import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { RequestError, stableJson } from './contracts';
import { DEFAULT_CADENCE_MINUTES } from './allowance-freshness';
import { mergeSettings, type CollectionSettings } from './companion-settings';
import type { TelemetryInput } from './telemetry-contract';
import { readCache } from './read-cache';

type Sql = ReturnType<typeof postgres>;
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
export type TelemetrySourceRow = { id: string; account_id: string; mode: 'local' | 'browser'; provider: 'codex' | 'claude' };

/** Injectable database provider keeps the v1 read side and the browser ingest testable against a disposable cluster. */
export function createTelemetryStore(getDatabase?: () => Sql) {
  // Routes load the server-only connector only when a database operation runs.
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();

  async function telemetrySource(request: Request): Promise<TelemetrySourceRow> {
    const auth = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new RequestError('Unauthorized', 401);
    const db = await sql();
    const [source] = await db`SELECT s.id, s.account_id, s.mode, a.provider FROM personal_hub.telemetry_sources s
      JOIN personal_hub.usage_accounts a ON a.id = s.account_id WHERE key_hash = ${hash(auth.slice(7))} AND NOT disabled`;
    if (!source) throw new RequestError('Unauthorized', 401);
    return source as TelemetrySourceRow;
  }

  /**
   * The browser quota extension is the last v1 collector in service: allowance readings only, never buckets.
   * `last_seen_at` records collector contact and advances on every accepted post, readings or not; the
   * meter's own freshness comes from the samples ledger (see `browserConnections`).
   */
  async function ingestBrowserQuotas(source: TelemetrySourceRow, input: TelemetryInput) {
    if (input.buckets.length) throw new RequestError('This connection can publish quota readings only', 403);
    const db = await sql();
    return db.begin(async transaction => {
      // postgres 3.4.8 TransactionSql uses Omit, which drops the callable signature.
      const tx = transaction as unknown as Sql;
      const rows = input.quotas.map(q => ({ id: randomUUID(), account_id: source.account_id, source_id: source.id, content_hash: hash(q), ...q }));
      const quotas = rows.length ? (await tx`INSERT INTO personal_hub.quota_samples ${tx(rows)} ON CONFLICT DO NOTHING RETURNING id`).length : 0;
      await tx`UPDATE personal_hub.telemetry_sources SET last_seen_at = now(), coverage = ${tx.json(input.coverage as postgres.JSONValue)} WHERE id = ${source.id}`;
      return { ok: true, id: hash({ source: source.id, input }), buckets: 0, quotas, duplicate: quotas === 0 };
    });
  }

  /** Browser sources for the Connections page: last contact beside the newest reading actually observed and received. */
  async function browserConnections() {
    const db = await sql();
    const sources = await db`SELECT s.id, s.account_id, s.machine_label, s.disabled, s.last_seen_at,
        (SELECT max(q.observed_at) FROM personal_hub.quota_samples q WHERE q.source_id = s.id) AS last_observation,
        (SELECT max(q.received_at) FROM personal_hub.quota_samples q WHERE q.source_id = s.id) AS last_received
      FROM personal_hub.telemetry_sources s WHERE s.mode = 'browser' ORDER BY s.created_at`;
    return JSON.parse(JSON.stringify({ sources, cadence_minutes: DEFAULT_CADENCE_MINUTES })) as {
      sources: { id: string; account_id: string; machine_label: string; disabled: boolean; last_seen_at: string | null;
        last_observation: string | null; last_received: string | null }[];
      cadence_minutes: number;
    };
  }

  // A window resets within its own length (plus a day of slack). A reading whose reset lies further out is a
  // bad clock or a hand-written sample; the contract now rejects such records, and rows that arrived before
  // that rule are ignored here so they cannot pin a forecast card.

  // v1 quota samples and v2 allowance readings share window keys through the compatibility view.
  // Until the unified usage migration is applied the view does not exist (SQLSTATE 42P01); the v1
  // samples alone keep the live page working across the deploy-then-migrate window. The view is the
  // union both readers feed; the v2-only current reading lives in usage-store's loadDashboard.
  async function allowancePercentRows(db: Sql) {
    try {
      return await db`SELECT id, account_id, source_id, window_key, label, observed_at, used_percent, resets_at, window_minutes, origin, reader, basis
        FROM personal_hub.allowance_percent_view
        WHERE observed_at >= now() - interval '35 days' AND resets_at <= observed_at + make_interval(mins => coalesce(window_minutes, 129600)) + interval '1 day' ORDER BY observed_at`;
    } catch (error) {
      if ((error as { code?: string }).code !== '42P01') throw error;
      return await db`SELECT q.id, q.account_id, q.source_id, q.window_key, q.label, q.observed_at, q.used_percent, q.resets_at, q.window_minutes,
          'quota_samples'::text AS origin, 'v1'::text AS reader, 'reported'::text AS basis
        FROM personal_hub.quota_samples q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id AND NOT s.disabled
        WHERE q.observed_at >= now() - interval '35 days' AND q.resets_at <= q.observed_at + make_interval(mins => coalesce(q.window_minutes, 129600)) + interval '1 day' ORDER BY q.observed_at`;
    }
  }

  async function loadTelemetryDashboard() {
    const db = await sql();
    const [accounts, sourceRows, settingsRows, hourly, quotaRows, reports] = await Promise.all([
      db`SELECT id, provider, label FROM personal_hub.usage_accounts ORDER BY created_at, id`,
      // A companion binding's source inherits its install override; v1, browser, and local sources run hourly.
      db`SELECT s.id, s.account_id, s.machine_label, s.mode, s.disabled, s.last_seen_at, s.coverage, i.settings AS install_settings
        FROM personal_hub.telemetry_sources s
        LEFT JOIN personal_hub.companion_bindings b ON b.source_id = s.id
        LEFT JOIN personal_hub.companion_installs i ON i.id = b.install_id
        ORDER BY s.created_at`,
      db`SELECT settings FROM personal_hub.collection_settings WHERE id = 1`,
      // Each bucket is a complete cumulative snapshot. Choose the most complete copy,
      // including when a session was copied to another machine. Never sum revisions.
      // A retired or paused connection stops uploading; its measured history stays on the dashboard.
      // The retired v1 scripts and the companion published the same buckets, so hiding one copy
      // would erase weeks of work rather than a duplicate.
      db`WITH canonical AS (SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.*
        FROM personal_hub.token_bucket_revisions t
        WHERE t.hour >= now() - interval '35 days'
        ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC)
        SELECT account_id, hour, model, sum(input_tokens)::float8 AS input_tokens, sum(cached_tokens)::float8 AS cached_tokens,
          sum(cache_write_tokens)::float8 AS cache_write_tokens, sum(output_tokens)::float8 AS output_tokens,
          sum(total_tokens)::float8 AS total_tokens, sum(calls)::float8 AS calls
        FROM canonical GROUP BY account_id, hour, model ORDER BY hour`,
      allowancePercentRows(db),
      // Project only the baseline fields; the full reports include large detail arrays.
      db`SELECT DISTINCT ON (period_key, subject_key)
        payload->>'machine_id' AS machine_id, payload->>'machine_name' AS machine_name,
        payload#>>'{report,current,month}' AS month,
        (payload#>>'{report,current,totals,total_tokens}')::float8 AS total_tokens,
        coalesce(payload#>'{report,current,daily}', '[]'::jsonb) AS daily
        FROM personal_hub.report_revisions WHERE kind = 'usage' AND status != 'failed'
        ORDER BY period_key DESC, subject_key, produced_at DESC, received_at DESC`,
    ]);
    const global = (settingsRows[0]?.settings ?? {}) as Partial<CollectionSettings>;
    const sources = sourceRows.map(({ install_settings, ...source }) => ({ ...source,
      cadence_minutes: install_settings ? mergeSettings(global, install_settings as Partial<CollectionSettings>).cadence_minutes : DEFAULT_CADENCE_MINUTES }));
    // Preserve the original machine/month granularity. No invented account/provider labels.
    const history = reports;
    return JSON.parse(JSON.stringify({ accounts, sources, hourly, quotas: quotaRows, history, as_of: new Date().toISOString() }));
  }
  const liveCache = readCache(30_000, loadTelemetryDashboard);
  const telemetryDashboard = () => liveCache.get();

  return { telemetrySource, ingestBrowserQuotas, browserConnections, telemetryDashboard };
}

export const telemetryStore = createTelemetryStore();
export const { telemetrySource, ingestBrowserQuotas, telemetryDashboard } = telemetryStore;
