import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { RequestError, stableJson } from './contracts';
import { telemetrySchema, type TelemetryInput } from './telemetry-contract';

/**
 * Historical reconciliation (USG-011): a read model over the retained v1 ledgers and the v2 ledgers
 * that says, per account, period, and model, which hourly keys only the retired collectors observed,
 * which both observed, and what the canonical selection counts; and, per account and meter, which
 * allowance observations stay visible as history after their producer was disabled and which v1
 * samples are shown once because a v2 reading duplicates them. Nothing here writes unless
 * `reconcileV1Envelope` is called with `apply`, and that path only appends the retired collectors'
 * pending envelopes under an explicit source mapping with their original observation times.
 */
type Sql = ReturnType<typeof postgres>;
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const EPOCH = '1970-01-01T00:00:00Z';

export type HourlyReconciliationRow = {
  account_id: string; provider: string; period: string; model: string;
  /** Keys are `account + session + UTC hour + model`; v1 is a retired `local` source, v2 the companion. */
  keys: { v1_only: number; v2_only: number; shared: number; shared_equal: number; shared_v2_larger: number; shared_v1_larger: number;
    /** v1-only keys inside an hour where the companion did observe this account under other keys: candidates for a session-identity mismatch, not proof of one. */
    v1_only_in_v2_hours: number };
  /** What the dashboard counts today (every source, one row per key) and what it would count if the v1 rows were dropped. */
  canonical: { calls: number; tokens: number; calls_from_v1_rows: number; tokens_from_v1_rows: number };
  without_v1: { calls: number; tokens: number };
  v1_only: { calls: number; tokens: number };
};
export type AllowanceReconciliationRow = {
  account_id: string; provider: string; meter_key: string; origin: 'quota_samples' | 'allowance_readings'; reader: string;
  rows: number; history_only_rows: number; cross_ledger_duplicates: number;
  /** Rows the previous view policy exposed (enabled producers only) and rows the current policy exposes (all, duplicates once). */
  visible_before: number; visible_after: number;
  observed: { first: string | null; last: string | null }; resets: { first: string | null; last: string | null };
};
export type AllowanceCurrentRow = {
  account_id: string; meter_key: string;
  /** Newest observation from an enabled producer, which is the only one a card may present as current capacity. */
  current_observed_at: string | null; newest_any_observed_at: string | null; revived_prevented: boolean;
};
export type MonthlyRetentionRow = { period_key: string; subject_key: string; revisions: number; statuses: string[]; latest_produced_at: string | null };
export type ReconciliationReport = {
  as_of: string; since: string | null;
  hourly: { rows: HourlyReconciliationRow[]; totals: { canonical_tokens: number; canonical_calls: number; without_v1_tokens: number; without_v1_calls: number;
    v1_only_keys: number; v2_only_keys: number; shared_keys: number; v1_only_in_v2_hours: number } };
  allowances: { rows: AllowanceReconciliationRow[]; current: AllowanceCurrentRow[] };
  monthly: { rows: MonthlyRetentionRow[]; note: string };
  notes: string[];
};

export type BucketVerdict = 'duplicate' | 'superseded' | 'advancing' | 'new_key';
export type QuotaVerdict = 'duplicate_v1' | 'duplicate_v2' | 'new';
export type EnvelopeReconciliation = {
  source: { id: string; account_id: string; provider: string; mode: string; disabled: boolean };
  observed_at: string; applied: boolean;
  buckets: { total: number; by_verdict: Record<BucketVerdict, number>;
    verdicts: { session_hash: string; hour: string; model: string; calls: number; total_tokens: number; verdict: BucketVerdict;
      canonical: { calls: number; total_tokens: number; source_mode: string } | null }[] };
  quotas: { total: number; by_verdict: Record<QuotaVerdict, number>;
    verdicts: { window_key: string; observed_at: string; used_percent: number; verdict: QuotaVerdict }[] };
  /** Canonical calls and tokens over the envelope's hours before, and after (measured when applied, projected otherwise). */
  canonical: { before: { calls: number; tokens: number }; after: { calls: number; tokens: number }; projected: boolean };
  /** True when a run would add no logical fact: every bucket is a duplicate or superseded and every quota is a duplicate. */
  /* Content hashes are computed over the strings the collector sent, exactly as ingestion stored them; a
     collector that formats the same instant differently produces a superseded or new verdict, never a duplicate. */
  no_new_facts: boolean;
  inserted: { bucket_revisions: number; quota_samples: number };
};

const emptyBucketVerdicts = (): Record<BucketVerdict, number> => ({ duplicate: 0, superseded: 0, advancing: 0, new_key: 0 });
const emptyQuotaVerdicts = (): Record<QuotaVerdict, number> => ({ duplicate_v1: 0, duplicate_v2: 0, new: 0 });

export function createUsageReconciliation(getDatabase?: () => Sql) {
  // Routes and scripts load the server-only connector only when a database operation runs.
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();

  async function hourlyRows(db: Sql, since: string) {
    return db`WITH keyed AS (
        SELECT t.account_id, t.session_hash, t.hour, t.model,
          bool_or(s.mode = 'local') AS has_v1, bool_or(s.mode = 'companion') AS has_v2,
          max(t.calls) FILTER (WHERE s.mode = 'local') AS v1_calls, max(t.total_tokens) FILTER (WHERE s.mode = 'local') AS v1_tokens,
          max(t.calls) FILTER (WHERE s.mode = 'companion') AS v2_calls, max(t.total_tokens) FILTER (WHERE s.mode = 'companion') AS v2_tokens
        FROM personal_hub.token_bucket_revisions t JOIN personal_hub.telemetry_sources s ON s.id = t.source_id
        WHERE t.hour >= ${since}::timestamptz GROUP BY 1, 2, 3, 4
      ), canonical AS (
        -- The nonregressing rule of personal_hub.token_bucket_canonical, inlined so this report also
        -- runs against a database that has not applied that migration yet.
        SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.account_id, t.session_hash, t.hour, t.model, t.calls, t.total_tokens, s.mode AS source_mode
        FROM personal_hub.token_bucket_revisions t JOIN personal_hub.telemetry_sources s ON s.id = t.source_id
        WHERE t.hour >= ${since}::timestamptz
        ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC
      ), without_v1 AS (
        SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.account_id, t.session_hash, t.hour, t.model, t.calls, t.total_tokens
        FROM personal_hub.token_bucket_revisions t JOIN personal_hub.telemetry_sources s ON s.id = t.source_id AND s.mode = 'companion'
        WHERE t.hour >= ${since}::timestamptz
        ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC
      ), v2_hours AS (SELECT DISTINCT account_id, hour FROM keyed WHERE has_v2)
      SELECT k.account_id, a.provider, to_char(k.hour AT TIME ZONE 'UTC', 'YYYY-MM') AS period, k.model,
        count(*) FILTER (WHERE k.has_v1 AND NOT k.has_v2)::int AS v1_only,
        count(*) FILTER (WHERE k.has_v2 AND NOT k.has_v1)::int AS v2_only,
        count(*) FILTER (WHERE k.has_v1 AND k.has_v2)::int AS shared,
        count(*) FILTER (WHERE k.has_v1 AND k.has_v2 AND k.v1_calls = k.v2_calls AND k.v1_tokens = k.v2_tokens)::int AS shared_equal,
        count(*) FILTER (WHERE k.has_v1 AND k.has_v2 AND (k.v2_calls > k.v1_calls OR (k.v2_calls = k.v1_calls AND k.v2_tokens > k.v1_tokens)))::int AS shared_v2_larger,
        count(*) FILTER (WHERE k.has_v1 AND k.has_v2 AND (k.v1_calls > k.v2_calls OR (k.v1_calls = k.v2_calls AND k.v1_tokens > k.v2_tokens)))::int AS shared_v1_larger,
        count(*) FILTER (WHERE k.has_v1 AND NOT k.has_v2 AND EXISTS (SELECT 1 FROM v2_hours h WHERE h.account_id = k.account_id AND h.hour = k.hour))::int AS v1_only_in_v2_hours,
        coalesce(sum(c.calls), 0)::float8 AS canonical_calls, coalesce(sum(c.total_tokens), 0)::float8 AS canonical_tokens,
        coalesce(sum(c.calls) FILTER (WHERE c.source_mode = 'local'), 0)::float8 AS canonical_calls_from_v1,
        coalesce(sum(c.total_tokens) FILTER (WHERE c.source_mode = 'local'), 0)::float8 AS canonical_tokens_from_v1,
        coalesce(sum(w.calls), 0)::float8 AS without_v1_calls, coalesce(sum(w.total_tokens), 0)::float8 AS without_v1_tokens,
        coalesce(sum(c.calls) FILTER (WHERE k.has_v1 AND NOT k.has_v2), 0)::float8 AS v1_only_calls,
        coalesce(sum(c.total_tokens) FILTER (WHERE k.has_v1 AND NOT k.has_v2), 0)::float8 AS v1_only_tokens
      FROM keyed k
      JOIN personal_hub.usage_accounts a ON a.id = k.account_id
      JOIN canonical c ON c.account_id = k.account_id AND c.session_hash = k.session_hash AND c.hour = k.hour AND c.model = k.model
      LEFT JOIN without_v1 w ON w.account_id = k.account_id AND w.session_hash = k.session_hash AND w.hour = k.hour AND w.model = k.model
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 3, 4`;
  }

  async function allowanceRows(db: Sql, since: string) {
    return db`WITH observations AS (
        SELECT q.account_id, q.window_key AS meter_key, 'quota_samples'::text AS origin, 'v1'::text AS reader, s.disabled AS history_only,
          EXISTS (SELECT 1 FROM personal_hub.allowance_readings r
            JOIN personal_hub.companion_bindings rb ON rb.id = r.binding_id JOIN personal_hub.companion_installs ri ON ri.id = rb.install_id
            WHERE r.account_id = q.account_id AND r.meter_key = q.window_key AND r.observed_at = q.observed_at
              AND r.kind = 'percent_used' AND r.value = q.used_percent AND r.resets_at = q.resets_at AND r.window_minutes IS NOT NULL
              AND (s.disabled OR (rb.enabled AND NOT ri.disabled))) AS duplicate_of_v2,
          q.observed_at, q.resets_at
        FROM personal_hub.quota_samples q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id
        WHERE q.observed_at >= ${since}::timestamptz
        UNION ALL
        SELECT r.account_id, r.meter_key, 'allowance_readings', r.reader, (NOT b.enabled OR i.disabled), false, r.observed_at, r.resets_at
        FROM personal_hub.allowance_readings r JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
        JOIN personal_hub.companion_installs i ON i.id = b.install_id
        WHERE r.kind = 'percent_used' AND r.resets_at IS NOT NULL AND r.window_minutes IS NOT NULL AND r.observed_at >= ${since}::timestamptz)
      SELECT o.account_id, a.provider, o.meter_key, o.origin, o.reader,
        count(*)::int AS rows, count(*) FILTER (WHERE o.history_only)::int AS history_only_rows,
        count(*) FILTER (WHERE o.duplicate_of_v2)::int AS cross_ledger_duplicates,
        count(*) FILTER (WHERE NOT o.history_only)::int AS visible_before,
        count(*) FILTER (WHERE NOT o.duplicate_of_v2)::int AS visible_after,
        min(o.observed_at) AS first_observed, max(o.observed_at) AS last_observed, min(o.resets_at) AS first_reset, max(o.resets_at) AS last_reset
      FROM observations o JOIN personal_hub.usage_accounts a ON a.id = o.account_id
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 3, 4, 5`;
  }

  // The same rows allowance_percent_view exposes, read from the ledgers so the selection can be
  // reported before the view carries `history_only`.
  async function currentRows(db: Sql) {
    return db`WITH observations AS (
        SELECT q.account_id, q.window_key AS meter_key, q.observed_at, s.disabled AS history_only
        FROM personal_hub.quota_samples q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id
        WHERE NOT EXISTS (SELECT 1 FROM personal_hub.allowance_readings r
          JOIN personal_hub.companion_bindings rb ON rb.id = r.binding_id JOIN personal_hub.companion_installs ri ON ri.id = rb.install_id
          WHERE r.account_id = q.account_id AND r.meter_key = q.window_key AND r.observed_at = q.observed_at
            AND r.kind = 'percent_used' AND r.value = q.used_percent AND r.resets_at = q.resets_at AND r.window_minutes IS NOT NULL
            AND (s.disabled OR (rb.enabled AND NOT ri.disabled)))
        UNION ALL
        SELECT r.account_id, r.meter_key, r.observed_at, (NOT b.enabled OR i.disabled)
        FROM personal_hub.allowance_readings r JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
        JOIN personal_hub.companion_installs i ON i.id = b.install_id
        WHERE r.kind = 'percent_used' AND r.resets_at IS NOT NULL AND r.window_minutes IS NOT NULL)
      SELECT account_id, meter_key,
        max(observed_at) FILTER (WHERE NOT history_only) AS current_observed_at, max(observed_at) AS newest_any_observed_at
      FROM observations GROUP BY 1, 2 ORDER BY 1, 2`;
  }

  async function monthlyRows(db: Sql) {
    return db`SELECT period_key, subject_key, count(*)::int AS revisions,
        array_agg(DISTINCT status ORDER BY status) AS statuses, max(produced_at) AS latest_produced_at
      FROM personal_hub.report_revisions WHERE kind = 'usage' GROUP BY 1, 2 ORDER BY 1 DESC, 2`;
  }

  /** The before/after matrix. Read-only, bounded to grouped rows, and never summing raw revisions. */
  async function report({ since = null }: { since?: string | null } = {}): Promise<ReconciliationReport> {
    if (since !== null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/.test(since)) throw new RequestError('since must be an ISO date or instant');
    const bound = since ? (since.length === 10 ? `${since}T00:00:00Z` : since) : EPOCH;
    const db = await sql();
    const [hourly, allowances, current, monthly] = await Promise.all([hourlyRows(db, bound), allowanceRows(db, bound), currentRows(db), monthlyRows(db)]);
    const rows: HourlyReconciliationRow[] = hourly.map(r => ({
      account_id: r.account_id as string, provider: r.provider as string, period: r.period as string, model: r.model as string,
      keys: { v1_only: Number(r.v1_only), v2_only: Number(r.v2_only), shared: Number(r.shared), shared_equal: Number(r.shared_equal),
        shared_v2_larger: Number(r.shared_v2_larger), shared_v1_larger: Number(r.shared_v1_larger), v1_only_in_v2_hours: Number(r.v1_only_in_v2_hours) },
      canonical: { calls: Number(r.canonical_calls), tokens: Number(r.canonical_tokens), calls_from_v1_rows: Number(r.canonical_calls_from_v1), tokens_from_v1_rows: Number(r.canonical_tokens_from_v1) },
      without_v1: { calls: Number(r.without_v1_calls), tokens: Number(r.without_v1_tokens) },
      v1_only: { calls: Number(r.v1_only_calls), tokens: Number(r.v1_only_tokens) },
    }));
    const sum = (pick: (row: HourlyReconciliationRow) => number) => rows.reduce((n, row) => n + pick(row), 0);
    const instant = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
    return clone({
      as_of: new Date().toISOString(), since: since ? bound : null,
      hourly: { rows, totals: {
        canonical_tokens: sum(r => r.canonical.tokens), canonical_calls: sum(r => r.canonical.calls),
        without_v1_tokens: sum(r => r.without_v1.tokens), without_v1_calls: sum(r => r.without_v1.calls),
        v1_only_keys: sum(r => r.keys.v1_only), v2_only_keys: sum(r => r.keys.v2_only), shared_keys: sum(r => r.keys.shared),
        v1_only_in_v2_hours: sum(r => r.keys.v1_only_in_v2_hours) } },
      allowances: {
        rows: allowances.map(r => ({ account_id: r.account_id as string, provider: r.provider as string, meter_key: r.meter_key as string,
          origin: r.origin as AllowanceReconciliationRow['origin'], reader: r.reader as string, rows: Number(r.rows),
          history_only_rows: Number(r.history_only_rows), cross_ledger_duplicates: Number(r.cross_ledger_duplicates),
          visible_before: Number(r.visible_before), visible_after: Number(r.visible_after),
          observed: { first: instant(r.first_observed), last: instant(r.last_observed) }, resets: { first: instant(r.first_reset), last: instant(r.last_reset) } })),
        current: current.map(r => {
          const currentAt = instant(r.current_observed_at), newest = instant(r.newest_any_observed_at);
          return { account_id: r.account_id as string, meter_key: r.meter_key as string, current_observed_at: currentAt, newest_any_observed_at: newest,
            revived_prevented: newest !== null && (currentAt === null || Date.parse(newest) > Date.parse(currentAt)) };
        }) },
      monthly: { rows: monthly.map(r => ({ period_key: r.period_key as string, subject_key: r.subject_key as string, revisions: Number(r.revisions),
          statuses: r.statuses as string[], latest_produced_at: instant(r.latest_produced_at) })),
        note: 'Monthly envelopes are retained whole with their pricing and environmental assumptions; nothing here expands them into hours, requests, tools, agents, or projects.' },
      notes: [
        'Hourly keys are account + session + UTC hour + model. v1 rows come from retired local sources, v2 rows from companion bindings; the canonical row per key is the most complete revision whichever source published it, so a shared key counts once.',
        'A v1-only key inside an hour the companion also observed is a candidate for a session-identity difference between the collectors and needs the transcript to decide; it is not double counting by itself because the two rows carry different session hashes.',
        'Allowance rows from a disabled source, binding, or install remain visible with history_only; a current reading is only ever selected among enabled producers. A v1 sample that a v2 reading duplicates exactly is shown once.',
      ],
    });
  }

  async function canonicalTotals(db: Sql, accountId: string, hours: string[]) {
    if (!hours.length) return { calls: 0, tokens: 0 };
    const [row] = await db`WITH canonical AS (
        SELECT DISTINCT ON (t.session_hash, t.hour, t.model) t.calls, t.total_tokens
        FROM personal_hub.token_bucket_revisions t WHERE t.account_id = ${accountId} AND t.hour = ANY(${hours}::timestamptz[])
        ORDER BY t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC)
      SELECT coalesce(sum(calls), 0)::float8 AS calls, coalesce(sum(total_tokens), 0)::float8 AS tokens FROM canonical`;
    return { calls: Number(row.calls), tokens: Number(row.tokens) };
  }

  /**
   * Classifies one retired collector's pending v1 envelope against the ledgers under an explicit source
   * mapping, and appends it only when `apply` is set. Buckets keep the envelope's own `observed_at`;
   * collector contact (`last_seen_at`) is not touched, because a replay is not a run. A quota that a v2
   * reading already records is never copied, so old and new copies cannot appear twice.
   */
  async function reconcileV1Envelope(sourceId: unknown, input: unknown, { apply = false }: { apply?: boolean } = {}): Promise<EnvelopeReconciliation> {
    if (!isUuid(sourceId)) throw new RequestError('Unknown telemetry source', 404);
    const envelope: TelemetryInput = telemetrySchema.parse(input);
    const db = await sql();
    const [source] = await db`SELECT s.id, s.account_id, s.mode, s.disabled, a.provider FROM personal_hub.telemetry_sources s
      JOIN personal_hub.usage_accounts a ON a.id = s.account_id WHERE s.id = ${sourceId}`;
    if (!source) throw new RequestError('Unknown telemetry source', 404);
    if (source.mode === 'companion') throw new RequestError('A v1 envelope maps to a retired local or browser source, not a companion binding', 409);
    if (source.mode === 'browser' && envelope.buckets.length) throw new RequestError('This connection can publish quota readings only', 403);
    const accountId = source.account_id as string;

    const bucketRows = envelope.buckets.map(bucket => ({ ...bucket, content_hash: hash(bucket) }));
    const bucketFacts = bucketRows.length ? await db`WITH pending AS (
        SELECT * FROM unnest(${bucketRows.map(b => b.session_hash)}::text[], ${bucketRows.map(b => b.hour)}::timestamptz[], ${bucketRows.map(b => b.model)}::text[],
          ${bucketRows.map(b => b.content_hash)}::text[]) AS p(session_hash, hour, model, content_hash))
      SELECT p.session_hash, p.hour, p.model,
        EXISTS (SELECT 1 FROM personal_hub.token_bucket_revisions t WHERE t.account_id = ${accountId} AND t.session_hash = p.session_hash
          AND t.hour = p.hour AND t.model = p.model AND t.content_hash = p.content_hash) AS duplicate,
        c.calls AS canonical_calls, c.total_tokens AS canonical_tokens, c.source_mode AS canonical_source_mode
      FROM pending p LEFT JOIN LATERAL (
        SELECT t.calls, t.total_tokens, s.mode AS source_mode
        FROM personal_hub.token_bucket_revisions t JOIN personal_hub.telemetry_sources s ON s.id = t.source_id
        WHERE t.account_id = ${accountId} AND t.session_hash = p.session_hash AND t.hour = p.hour AND t.model = p.model
        ORDER BY t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC LIMIT 1) c ON true` : [];
    const factByKey = new Map(bucketFacts.map(f => [`${f.session_hash}|${new Date(f.hour as string).toISOString()}|${f.model}`, f]));
    const bucketVerdicts = bucketRows.map(bucket => {
      const fact = factByKey.get(`${bucket.session_hash}|${new Date(bucket.hour).toISOString()}|${bucket.model}`);
      const canonical = fact && fact.canonical_calls !== null
        ? { calls: Number(fact.canonical_calls), total_tokens: Number(fact.canonical_tokens), source_mode: fact.canonical_source_mode as string } : null;
      const verdict: BucketVerdict = fact?.duplicate ? 'duplicate'
        : !canonical ? 'new_key'
        : bucket.calls > canonical.calls || (bucket.calls === canonical.calls && bucket.total_tokens > canonical.total_tokens) ? 'advancing' : 'superseded';
      return { session_hash: bucket.session_hash, hour: bucket.hour, model: bucket.model, calls: bucket.calls, total_tokens: bucket.total_tokens, verdict, canonical };
    });

    const quotaRows = envelope.quotas.map(quota => ({ ...quota, content_hash: hash(quota) }));
    const quotaFacts = quotaRows.length ? await db`WITH pending AS (
        SELECT * FROM unnest(${quotaRows.map(q => q.window_key)}::text[], ${quotaRows.map(q => q.observed_at)}::timestamptz[], ${quotaRows.map(q => q.used_percent)}::float8[],
          ${quotaRows.map(q => q.resets_at)}::timestamptz[], ${quotaRows.map(q => q.content_hash)}::text[]) AS p(window_key, observed_at, used_percent, resets_at, content_hash))
      SELECT p.content_hash,
        EXISTS (SELECT 1 FROM personal_hub.quota_samples q WHERE q.account_id = ${accountId} AND q.content_hash = p.content_hash) AS duplicate_v1,
        EXISTS (SELECT 1 FROM personal_hub.allowance_readings r WHERE r.account_id = ${accountId} AND r.meter_key = p.window_key AND r.observed_at = p.observed_at
          AND r.kind = 'percent_used' AND r.value = p.used_percent AND r.resets_at = p.resets_at AND r.window_minutes IS NOT NULL) AS duplicate_v2
      FROM pending p` : [];
    const quotaFactByHash = new Map(quotaFacts.map(f => [f.content_hash as string, f]));
    const quotaVerdicts = quotaRows.map(quota => {
      const fact = quotaFactByHash.get(quota.content_hash);
      const verdict: QuotaVerdict = fact?.duplicate_v1 ? 'duplicate_v1' : fact?.duplicate_v2 ? 'duplicate_v2' : 'new';
      return { window_key: quota.window_key, observed_at: quota.observed_at, used_percent: quota.used_percent, verdict };
    });

    const byBucketVerdict = emptyBucketVerdicts(), byQuotaVerdict = emptyQuotaVerdicts();
    for (const v of bucketVerdicts) byBucketVerdict[v.verdict]++;
    for (const v of quotaVerdicts) byQuotaVerdict[v.verdict]++;
    const hours = [...new Set(bucketRows.map(b => new Date(b.hour).toISOString()))];
    const before = await canonicalTotals(db, accountId, hours);
    // Under the canonical rule an advancing bucket replaces its key's row and a new key adds one; nothing else moves the totals.
    const projected = bucketVerdicts.reduce((delta, v) => {
      if (v.verdict === 'new_key') return { calls: delta.calls + v.calls, tokens: delta.tokens + v.total_tokens };
      if (v.verdict === 'advancing') return { calls: delta.calls + v.calls - v.canonical!.calls, tokens: delta.tokens + v.total_tokens - v.canonical!.total_tokens };
      return delta;
    }, { calls: 0, tokens: 0 });
    const noNewFacts = byBucketVerdict.new_key === 0 && byBucketVerdict.advancing === 0 && byQuotaVerdict.new === 0;
    const base = { source: { id: source.id as string, account_id: accountId, provider: source.provider as string, mode: source.mode as string, disabled: source.disabled as boolean },
      observed_at: envelope.observed_at, buckets: { total: bucketVerdicts.length, by_verdict: byBucketVerdict, verdicts: bucketVerdicts },
      quotas: { total: quotaVerdicts.length, by_verdict: byQuotaVerdict, verdicts: quotaVerdicts }, no_new_facts: noNewFacts };
    if (!apply) {
      return clone({ ...base, applied: false, canonical: { before, after: { calls: before.calls + projected.calls, tokens: before.tokens + projected.tokens }, projected: true },
        inserted: { bucket_revisions: 0, quota_samples: 0 } });
    }
    return db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      // Only revisions that add a fact are appended. A superseded revision would add nothing, and with the
      // envelope's later observation time it could win the composition tie-break against the canonical row.
      const pendingBuckets = bucketRows.filter((_, index) => ['new_key', 'advancing'].includes(bucketVerdicts[index].verdict))
        .map(({ content_hash, ...bucket }) => ({ id: randomUUID(), account_id: accountId, source_id: source.id, observed_at: envelope.observed_at, content_hash, ...bucket }));
      const insertedBuckets = pendingBuckets.length ? (await tx`INSERT INTO personal_hub.token_bucket_revisions ${tx(pendingBuckets)} ON CONFLICT DO NOTHING RETURNING id`).length : 0;
      const pendingQuotas = quotaRows.filter((_, index) => quotaVerdicts[index].verdict === 'new')
        .map(({ content_hash, ...quota }) => ({ id: randomUUID(), account_id: accountId, source_id: source.id, content_hash, ...quota }));
      const insertedQuotas = pendingQuotas.length ? (await tx`INSERT INTO personal_hub.quota_samples ${tx(pendingQuotas)} ON CONFLICT DO NOTHING RETURNING id`).length : 0;
      const after = await canonicalTotals(tx, accountId, hours);
      return clone({ ...base, applied: true, canonical: { before, after, projected: false }, inserted: { bucket_revisions: insertedBuckets, quota_samples: insertedQuotas } });
    });
  }

  return { report, reconcileV1Envelope };
}

export const usageReconciliation = createUsageReconciliation();
