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

async function loadTelemetryDashboard() {
  const sql = database();
  const [accounts, sources, hourly, quotaRows, reports] = await Promise.all([
    sql`SELECT id, provider, label FROM personal_hub.usage_accounts ORDER BY created_at, id`,
    sql`SELECT id, account_id, machine_label, mode, disabled, last_seen_at, coverage FROM personal_hub.telemetry_sources ORDER BY created_at`,
    // Each bucket is a complete cumulative snapshot. Choose the most complete copy,
    // including when a session was copied to another machine. Never sum revisions.
    sql`WITH canonical AS (SELECT DISTINCT ON (account_id, session_hash, hour, model) *
      FROM personal_hub.token_bucket_revisions WHERE hour >= now() - interval '35 days'
      ORDER BY account_id, session_hash, hour, model, calls DESC, total_tokens DESC, observed_at DESC, received_at DESC)
      SELECT account_id, hour, model, sum(input_tokens)::float8 AS input_tokens, sum(cached_tokens)::float8 AS cached_tokens,
        sum(cache_write_tokens)::float8 AS cache_write_tokens, sum(output_tokens)::float8 AS output_tokens,
        sum(total_tokens)::float8 AS total_tokens, sum(calls)::float8 AS calls
      FROM canonical GROUP BY account_id, hour, model ORDER BY hour`,
    sql`SELECT id, account_id, window_key, label, observed_at, used_percent, resets_at, window_minutes
      FROM personal_hub.quota_samples WHERE observed_at >= now() - interval '35 days' ORDER BY observed_at`,
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
