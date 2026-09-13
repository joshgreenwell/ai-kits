import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { database } from './db';
import { RequestError, stableJson } from './contracts';
import { connectionSchema, type TelemetryInput } from './telemetry-contract';
import { readCache } from './read-cache';

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
export async function createConnection(input: unknown) {
  const data = connectionSchema.parse(input), sql = database();
  const id = randomUUID(), key = randomBytes(32).toString('base64url');
  await sql.begin(async transaction => {
    // postgres 3.4.8 TransactionSql uses Omit, which drops the callable signature.
    const tx = transaction as unknown as postgres.Sql;
    await tx`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${data.account_id}, ${data.provider}, ${data.account_label}) ON CONFLICT DO NOTHING`;
    const [account] = await tx`SELECT provider FROM personal_hub.usage_accounts WHERE id = ${data.account_id}`;
    if (account.provider !== data.provider) throw new RequestError('Account belongs to another provider', 409);
    await tx`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash)
      VALUES (${id}, ${data.account_id}, ${data.machine_label}, ${data.mode}, ${hash(key)})`;
  });
  return { schema_version: 1, url: process.env.SITE_URL, source_id: id, key, account_id: data.account_id, provider: data.provider, mode: data.mode };
}

export async function telemetrySource(request: Request) {
  const auth = request.headers.get('authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new RequestError('Unauthorized', 401);
  const [source] = await database()`SELECT s.id, s.account_id, s.mode, a.provider FROM personal_hub.telemetry_sources s
    JOIN personal_hub.usage_accounts a ON a.id = s.account_id WHERE key_hash = ${hash(auth.slice(7))} AND NOT disabled`;
  if (!source) throw new RequestError('Unauthorized', 401);
  return source as { id: string; account_id: string; mode: 'local' | 'browser'; provider: 'codex' | 'claude' };
}

export async function ingestTelemetry(source: Awaited<ReturnType<typeof telemetrySource>>, input: TelemetryInput) {
  if (source.mode === 'browser' && input.buckets.length) throw new RequestError('This connection can publish quota readings only', 403);
  return database().begin(async transaction => {
    // postgres 3.4.8 TransactionSql uses Omit, which drops the callable signature.
    const tx = transaction as unknown as postgres.Sql;
    const bucketRows = input.buckets.map(bucket => ({ id: randomUUID(), account_id: source.account_id,
      source_id: source.id, observed_at: input.observed_at, content_hash: hash(bucket), ...bucket }));
    const quotaRows = input.quotas.map(q => ({ id: randomUUID(), account_id: source.account_id,
      source_id: source.id, content_hash: hash(q), ...q }));
    const buckets = bucketRows.length ? (await tx`INSERT INTO personal_hub.token_bucket_revisions ${tx(bucketRows)} ON CONFLICT DO NOTHING RETURNING id`).length : 0;
    const quotas = quotaRows.length ? (await tx`INSERT INTO personal_hub.quota_samples ${tx(quotaRows)} ON CONFLICT DO NOTHING RETURNING id`).length : 0;
    await tx`UPDATE personal_hub.telemetry_sources SET last_seen_at = now(), coverage = ${tx.json(input.coverage as postgres.JSONValue)} WHERE id = ${source.id}`;
    return { ok: true, id: hash({ source: source.id, input }), buckets, quotas, duplicate: buckets + quotas === 0 };
  });
}

// A window resets within its own length (plus a day of slack). A reading whose reset lies further out is a
// bad clock or a hand-written sample; the contract now rejects such records, and rows that arrived before
// that rule are ignored here so they cannot pin a forecast card.

// v1 quota samples and v2 allowance readings share window keys through the compatibility view.
// Until the unified usage migration is applied the view does not exist (SQLSTATE 42P01); the v1
// samples alone keep the live page working across the deploy-then-migrate window.
async function allowancePercentRows(sql: ReturnType<typeof database>) {
  try {
    return await sql`SELECT id, account_id, window_key, label, observed_at, used_percent, resets_at, window_minutes, origin, reader
      FROM personal_hub.allowance_percent_view
      WHERE observed_at >= now() - interval '35 days' AND resets_at <= observed_at + make_interval(mins => coalesce(window_minutes, 129600)) + interval '1 day' ORDER BY observed_at`;
  } catch (error) {
    if ((error as { code?: string }).code !== '42P01') throw error;
    return await sql`SELECT q.id, q.account_id, q.window_key, q.label, q.observed_at, q.used_percent, q.resets_at, q.window_minutes,
        'quota_samples'::text AS origin, 'v1'::text AS reader
      FROM personal_hub.quota_samples q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id AND NOT s.disabled
      WHERE q.observed_at >= now() - interval '35 days' AND q.resets_at <= q.observed_at + make_interval(mins => coalesce(q.window_minutes, 129600)) + interval '1 day' ORDER BY q.observed_at`;
  }
}

async function loadTelemetryDashboard() {
  const sql = database();
  const [accounts, sources, hourly, quotaRows, reports] = await Promise.all([
    sql`SELECT id, provider, label FROM personal_hub.usage_accounts ORDER BY created_at, id`,
    sql`SELECT id, account_id, machine_label, mode, disabled, last_seen_at, coverage FROM personal_hub.telemetry_sources ORDER BY created_at`,
    // Each bucket is a complete cumulative snapshot. Choose the most complete copy,
    // including when a session was copied to another machine. Never sum revisions.
    // Disabled connections and bindings leave the dashboard: the join excludes their revisions.
    sql`WITH canonical AS (SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.*
      FROM personal_hub.token_bucket_revisions t JOIN personal_hub.telemetry_sources s ON s.id = t.source_id AND NOT s.disabled
      WHERE t.hour >= now() - interval '35 days'
      ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC)
      SELECT account_id, hour, model, sum(input_tokens)::float8 AS input_tokens, sum(cached_tokens)::float8 AS cached_tokens,
        sum(cache_write_tokens)::float8 AS cache_write_tokens, sum(output_tokens)::float8 AS output_tokens,
        sum(total_tokens)::float8 AS total_tokens, sum(calls)::float8 AS calls
      FROM canonical GROUP BY account_id, hour, model ORDER BY hour`,
    allowancePercentRows(sql),
    // Project only the baseline fields; the full reports include large detail arrays.
    sql`SELECT DISTINCT ON (period_key, subject_key)
      payload->>'machine_id' AS machine_id, payload->>'machine_name' AS machine_name,
      payload#>>'{report,current,month}' AS month,
      (payload#>>'{report,current,totals,total_tokens}')::float8 AS total_tokens,
      coalesce(payload#>'{report,current,daily}', '[]'::jsonb) AS daily
      FROM personal_hub.report_revisions WHERE kind = 'usage' AND status != 'failed'
      ORDER BY period_key DESC, subject_key, produced_at DESC, received_at DESC`,
  ]);
  // Preserve the original machine/month granularity. No invented account/provider labels.
  const history = reports;
  return JSON.parse(JSON.stringify({ accounts, sources, hourly, quotas: quotaRows, history, as_of: new Date().toISOString() }));
}
const liveCache = readCache(30_000, loadTelemetryDashboard);
export const telemetryDashboard = () => liveCache.get();
