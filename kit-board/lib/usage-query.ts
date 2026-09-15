import { z } from 'zod';
import type postgres from 'postgres';
import { RequestError, stableJson } from './contracts';
import {
  DISPLAY_TIMEZONE, HOUR, PRESETS, RESOLUTIONS, isSupportedTimeZone, localMonthKey, monthBounds, monthsWithin,
  periodsWithin, resolveRange, zonedInstant, type Preset, type Resolution, type ResolvedRange,
} from './usage-periods';

/**
 * One filtered usage query layer (USG-012). Every Tokens card reads the same selected scope from
 * here: half-open range at local boundaries, OR within a dimension and AND across dimensions,
 * explicit Unknown, full-bucket inclusion, and per-section coverage with stated denominators.
 *
 * Source precedence follows the metric contract. Canonical hourly buckets are the headline token
 * and call authority for every slice, because no collection manifest has declared a slice complete
 * at request level. Request records supply the dimensions buckets lack (project, effort, surface,
 * agent, pricing inputs); a filter on one of those dimensions narrows the headline to the request
 * detail that carries it and discloses the bucket tokens it cannot examine. Monthly snapshots are
 * historical fallback only where the hourly ledger has nothing for a crosswalked account and month,
 * and are never expanded into finer detail than they recorded.
 */
type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const num = (value: unknown) => Number(value ?? 0);
const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
const CHANNEL_RANK = "CASE r.channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END";
const IDENTITY_RANK = "CASE r.session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END";
const UNKNOWN = 'unknown';

export const PROVIDERS = ['codex', 'claude', 'cursor', 'anthropic_api', 'openai_api'] as const;
export const SURFACES = ['cli', 'ide', 'desktop', 'sdk', 'ci', 'cloud', UNKNOWN] as const;
export const PROJECT_STATES = ['no_project', UNKNOWN, 'unassigned'] as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^[a-z0-9_.:-]{1,64}$/);
const list = <T extends z.ZodTypeAny>(item: T, max: number) => z.array(item).max(max).default([]);

export const usageQuerySchema = z.object({
  preset: z.enum(PRESETS).default('month_to_date'),
  start: z.iso.datetime({ offset: true }).optional(),
  end: z.iso.datetime({ offset: true }).optional(),
  timezone: z.string().min(1).max(64).refine(isSupportedTimeZone, 'Unsupported time zone').default(DISPLAY_TIMEZONE),
  resolution: z.enum(RESOLUTIONS).default('day'),
  accounts: list(z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/), 50),
  providers: list(z.enum(PROVIDERS), PROVIDERS.length),
  models: list(z.string().min(1).max(100), 50),
  efforts: list(code, 20),
  machines: list(z.uuid(), 50),
  surfaces: list(z.enum(SURFACES), SURFACES.length),
  projects: list(z.union([z.uuid(), z.enum(PROJECT_STATES)]), 50),
  agent_scope: z.enum(['all', 'main', 'subagent']).default('all'),
  agents: list(sha256, 50),
}).strict();
export type UsageQuery = z.infer<typeof usageQuerySchema>;

const LIST_KEYS = ['accounts', 'providers', 'models', 'efforts', 'machines', 'surfaces', 'projects', 'agents'] as const;
/** Query-string form: list keys accept repeats or comma-separated values. */
export function parseUsageQuery(params: URLSearchParams): UsageQuery {
  const raw: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    if ((LIST_KEYS as readonly string[]).includes(key)) raw[key] = params.getAll(key).flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean);
    else { const value = params.get(key); if (value !== null && value !== '') raw[key] = value; }   // an empty value is an absent one
  }
  return usageQuerySchema.parse(raw);
}

export type Composition = { input_fresh: number; input_cached: number; input_cache_write: number; output: number; reasoning: number | null; unclassified: number };
export type SeriesPoint = { start: string; end: string; total_tokens: number; calls: number; composition: Composition;
  /** observed: rows exist; zero: none, and a collector had scanned past this interval; missing: none and no collector evidence; partial: still being observed or clipped by the range. */
  state: 'observed' | 'zero' | 'missing' | 'partial'; sources: ('buckets' | 'requests' | 'snapshot')[] };
export type Coverage = { applicable: number; complete: number; headline: number; eligible: number; classified: number; unit: 'tokens' | 'calls' | 'invocations'; note: string };
export type UsageQueryResult = {
  as_of: string;
  scope: { range: { preset: Preset; start: string; end: string; timezone: string; anchored_to_now: boolean; resolution: Resolution };
    accounts: { id: string; provider: string; label: string }[]; filters: Omit<UsageQuery, 'preset' | 'start' | 'end' | 'timezone' | 'resolution'>;
    /** Filters that only request detail can answer; when any is set the headline is the covered request detail. */
    detail_filters: string[] };
  headline: { total_tokens: number; calls: number; conversations: number | null; composition: Composition; basis: 'buckets' | 'requests';
    /** Tokens in the selected bucket population the active detail filters could not examine. */
    unfilterable_tokens: number; unfilterable_calls: number; /** Request-detail tokens in hours with no bucket: a ledger shortfall, disclosed rather than clamped. */ uncovered_request_tokens: number;
    snapshot_tokens: number; snapshot_calls: number; last_observation: string | null };
  series: { resolution: Resolution; points: SeriesPoint[]; excludes_snapshot_tokens: number };
  by_model: { model: string; total_tokens: number; calls: number; composition: Composition; share: number | null; basis: 'buckets' | 'requests' }[];
  model_series: { model: string; points: { start: string; total_tokens: number; calls: number }[] }[];
  pricing_inputs: { rows: { model: string | null; reasoning_effort: string | null; service_tier: string | null; speed: string | null; context_window_tokens: number | null;
      cache_write_ttl: string | null; token_state: string | null; calls: number; composition: Composition; total_tokens: number }[];
    coverage: Coverage; note: string };
  projects: { rows: { state: 'project' | 'unassigned' | 'no_project' | 'unknown'; project_id: string | null; label: string | null; total_tokens: number; calls: number; conversations: number; share: number | null }[];
    coverage: Coverage; registry: Coverage };
  agents: { rows: { agent_key: string | null; class: string; name: string | null; depth: number | null; parent_agent_key: string | null; model: string | null; total_tokens: number; calls: number; share: number | null }[];
    summary: { main_tokens: number; subagent_tokens: number; unattributed_tokens: number; observed_children: number; spawns: number; by_class: Record<string, number> }; coverage: Coverage };
  tools: { invocations: number; by_tool: { name: string | null; class: string; namespace: string | null; invocations: number; share: number | null }[];
    by_caller: { agent_key: string | null; agent_name: string | null; agent_class: string | null; model: string | null; invocations: number }[];
    by_outcome: Record<string, number>; caller_coverage: Coverage; outcome_coverage: Coverage; unsupported_filters: string[] };
  knowledge: { rows: { source_id: string | null; label: string | null; state: string; accesses: number; distinct_invocations: number; distinct_sessions: number; distinct_agents: number;
      by_access_kind: Record<string, number>; earlier_configuration_accesses: number }[]; distinct_invocations: number; note: string };
  environmental_inputs: { cohorts: { account_id: string; provider: string; month: string; calls: number; raw_tokens: number; average_raw_tokens_per_call: number | null; basis: 'buckets' | 'snapshot' }[]; coverage: Coverage; note: string };
  historical: { snapshots: { subject_key: string; machine_name: string | null; month: string; status: string; produced_at: string | null; account_id: string | null; source_timezone: string | null;
      total_tokens: number; calls: number; threads: number | null; daily_rows: number; merged: 'month' | 'days' | 'none'; reason: string | null; merged_tokens: number; merged_calls: number;
      methodology_version: string | null; pricing_catalog: string | null; estimated_cost_usd: number | null }[]; note: string };
  request_detail: { covered_tokens: number; covered_calls: number; coverage: Coverage };
  unsupported: string[]; notes: string[];
};

/** Positional-parameter builder: every value is bound, the text carries only `$n` placeholders. */
type Bindable = postgres.ParameterOrJSON<never>;
class Params {
  values: Bindable[] = [];
  add(value: unknown) { this.values.push(value as Bindable); return `$${this.values.length}`; }
}

type Meta = {
  accounts: { id: string; provider: string; label: string }[];
  sources: { id: string; account_id: string; machine_label: string; mode: string }[];
  coverage: Map<string, { from: number | null; through: number | null }>;
};

const emptyComposition = (): Composition => ({ input_fresh: 0, input_cached: 0, input_cache_write: 0, output: 0, reasoning: null, unclassified: 0 });
const addComposition = (into: Composition, row: Row, prefix = '') => {
  into.input_fresh += num(row[`${prefix}input_fresh`]); into.input_cached += num(row[`${prefix}input_cached`]);
  into.input_cache_write += num(row[`${prefix}input_cache_write`]); into.output += num(row[`${prefix}output`]);
  const reasoning = row[`${prefix}reasoning`];
  if (reasoning !== null && reasoning !== undefined) into.reasoning = (into.reasoning ?? 0) + num(reasoning);
  into.unclassified += num(row[`${prefix}unclassified`]);
};
const coverage = (unit: Coverage['unit'], headline: number, eligible: number, classified: number, note: string): Coverage => ({
  unit, headline, eligible, classified, applicable: headline > 0 ? eligible / headline : 0, complete: eligible > 0 ? classified / eligible : 0, note,
});
const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function createUsageQuery(getDatabase?: () => Sql) {
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();

  async function meta(db: Sql): Promise<Meta> {
    const accounts = await db`SELECT id, provider, label FROM personal_hub.usage_accounts ORDER BY created_at, id`;
    const sources = await db`SELECT id, account_id, machine_label, mode FROM personal_hub.telemetry_sources ORDER BY created_at, id`;
    // Coverage per account: the first hour any collector observed and the newest collector contact, which
    // says how far the collectors have scanned. Absence before `from` or after `through` is missing data;
    // absence in between is a true zero for the collectors that exist.
    const rows = await db`SELECT a.id,
        (SELECT min(t.hour) FROM personal_hub.token_bucket_revisions t WHERE t.account_id = a.id) AS observed_from,
        greatest(
          (SELECT max(s.last_seen_at) FROM personal_hub.telemetry_sources s WHERE s.account_id = a.id),
          (SELECT max(cr.finished_at) FROM personal_hub.companion_runs cr JOIN personal_hub.companion_bindings b ON b.install_id = cr.install_id WHERE b.account_id = a.id)
        ) AS scanned_through
      FROM personal_hub.usage_accounts a`;
    const coverageByAccount = new Map(rows.map(r => [r.id as string, {
      from: r.observed_from ? new Date(r.observed_from as string).getTime() : null,
      through: r.scanned_through ? new Date(r.scanned_through as string).getTime() : null }]));
    return { accounts: clone(accounts) as unknown as Meta['accounts'], sources: clone(sources) as unknown as Meta['sources'], coverage: coverageByAccount };
  }

  /** The canonical request population in range with bucket-level filters, plus whether each row matches the detail filters. */
  function requestCte(p: Params, q: UsageQuery, accounts: string[], range: ResolvedRange) {
    const detail: string[] = [];
    const modelFilter = (column: string) => {
      const named = q.models.filter(m => m !== UNKNOWN);
      const parts: string[] = [];
      if (named.length) parts.push(`${column} = ANY(${p.add(named)}::text[])`);
      if (q.models.includes(UNKNOWN)) parts.push(`(${column} IS NULL OR ${column} = 'unknown')`);
      return parts.length ? `(${parts.join(' OR ')})` : null;
    };
    const codeFilter = (column: string, values: string[]) => {
      const named = values.filter(v => v !== UNKNOWN);
      const parts: string[] = [];
      if (named.length) parts.push(`${column} = ANY(${p.add(named)}::text[])`);
      if (values.includes(UNKNOWN)) parts.push(`${column} IS NULL`);
      return parts.length ? `(${parts.join(' OR ')})` : null;
    };
    const model = modelFilter('r.model_actual');
    if (q.efforts.length) detail.push(codeFilter('r.reasoning_effort', q.efforts)!);
    if (q.surfaces.length) detail.push(`r.surface = ANY(${p.add(q.surfaces)}::text[])`);
    if (q.agent_scope === 'main') detail.push(`(r.agent_class = 'main' OR r.agent_depth = 0)`);
    if (q.agent_scope === 'subagent') detail.push(`(r.agent_depth > 0 OR r.parent_agent_key IS NOT NULL)`);
    if (q.agents.length) detail.push(`r.agent_key = ANY(${p.add(q.agents)}::text[])`);
    if (q.projects.length) {
      const ids = q.projects.filter(v => !(PROJECT_STATES as readonly string[]).includes(v));
      const states = q.projects.filter(v => (PROJECT_STATES as readonly string[]).includes(v));
      const parts: string[] = [];
      if (ids.length) parts.push(`pr.project_id = ANY(${p.add(ids)}::uuid[])`);
      if (states.length) parts.push(`pr.project_state = ANY(${p.add(states)}::text[])`);
      detail.push(`(${parts.join(' OR ')})`);
    }
    // Revisions of one logical request are ranked over a window widened by a week on each side, so the
    // canonical row is chosen among all its revisions before the exact range, model, and machine filters apply.
    const widen = 7 * 24 * HOUR;
    const scope = [
      `r.account_id = ANY(${p.add(accounts)}::text[])`,
      `r.activity_at >= ${p.add(new Date(range.start - widen).toISOString())}::timestamptz`,
      `r.activity_at < ${p.add(new Date(range.end + widen).toISOString())}::timestamptz`,
    ];
    const post = [
      `activity_at >= ${p.add(new Date(range.start).toISOString())}::timestamptz`,
      `activity_at < ${p.add(new Date(range.end).toISOString())}::timestamptz`,
      ...(model ? [model.replaceAll('r.model_actual', 'model_actual')] : []),
      ...(q.machines.length ? [`source_id = ANY(${p.add(q.machines)}::uuid[])`] : []),
    ];
    const text = `ranked AS (
      SELECT r.id, r.account_id, r.semantic_key, r.session_hash, r.model_actual, r.activity_at, r.observed_at, r.surface, r.reasoning_effort, r.service_tier, r.speed,
        r.context_window_tokens, r.cache_write_ttl, r.token_state, r.outcome,
        r.input_fresh_tokens, r.input_cached_tokens, r.input_cache_write_tokens, r.output_tokens, r.reasoning_tokens, r.unclassified_tokens, r.observed_total_tokens,
        r.agent_key, r.agent_class, r.agent_name, r.agent_depth, r.parent_agent_key, r.agent_identity_basis,
        b.source_id, pr.project_state, pr.project_id, pr.project_label,
        ${detail.length ? `(${detail.join(' AND ')})` : 'true'} AS matches,
        row_number() OVER (PARTITION BY r.account_id, r.semantic_key ORDER BY ${CHANNEL_RANK}, ${IDENTITY_RANK}, r.observed_at DESC, r.received_at DESC, r.id DESC) AS rank
      FROM personal_hub.activity_requests r
      JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
      LEFT JOIN personal_hub.activity_request_project_resolution pr ON pr.account_id = r.account_id AND pr.semantic_key = r.semantic_key
      WHERE ${scope.join(' AND ')}
    ), requests AS (SELECT * FROM ranked WHERE rank = 1 AND ${post.join(' AND ')})`;
    return { text, detailFilters: detail.length > 0 };
  }

  // A parameter is added only when the expression references it: an unreferenced bound value has no type.
  const periodExpr = (column: string, resolution: Resolution, p: Params, tz: string) =>
    resolution === 'day' ? (() => { const z = `${p.add(tz)}::text`; return `date_trunc('day', ${column} AT TIME ZONE ${z}) AT TIME ZONE ${z}`; })() : `date_trunc('hour', ${column})`;
  const compositionSelect = (alias = 'r') => `sum(${alias}.input_fresh_tokens)::float8 AS input_fresh, sum(${alias}.input_cached_tokens)::float8 AS input_cached,
      sum(${alias}.input_cache_write_tokens)::float8 AS input_cache_write, sum(${alias}.output_tokens)::float8 AS output,
      sum(${alias}.reasoning_tokens)::float8 AS reasoning, sum(${alias}.unclassified_tokens)::float8 AS unclassified,
      sum(${alias}.observed_total_tokens)::float8 AS total_tokens, count(*)::int AS calls, count(DISTINCT ${alias}.session_hash)::int AS conversations`;

  async function usageQuery(input: UsageQuery, { now = Date.now() }: { now?: number } = {}): Promise<UsageQueryResult> {
    const q = usageQuerySchema.parse(input);
    const range = resolveRange({ preset: q.preset, start: q.start, end: q.end, timezone: q.timezone, now });
    const periods = periodsWithin(range, q.resolution, q.timezone);
    const db = await sql();
    const m = await meta(db);
    const byId = new Map(m.accounts.map(a => [a.id, a]));
    for (const id of q.accounts) if (!byId.has(id)) throw new RequestError('Unknown account', 404);
    for (const id of q.machines) if (!m.sources.some(s => s.id === id)) throw new RequestError('Unknown machine', 404);
    const selected = m.accounts.filter(a => (!q.accounts.length || q.accounts.includes(a.id)) && (!q.providers.length || (q.providers as string[]).includes(a.provider)));
    const accounts = selected.map(a => a.id);
    const unsupported: string[] = [], notes: string[] = [];
    const tz = q.timezone;
    const bucketEnd = range.anchored_to_now ? Math.ceil(now / HOUR) * HOUR : range.end;
    const detailFilters = [q.efforts.length && 'efforts', q.surfaces.length && 'surfaces', q.projects.length && 'projects', q.agent_scope !== 'all' && 'agent_scope', q.agents.length && 'agents']
      .filter((v): v is string => typeof v === 'string');
    const empty = (): UsageQueryResult['headline'] => ({ total_tokens: 0, calls: 0, conversations: null, composition: emptyComposition(), basis: 'buckets',
      unfilterable_tokens: 0, unfilterable_calls: 0, uncovered_request_tokens: 0, snapshot_tokens: 0, snapshot_calls: 0, last_observation: null });

    // 1. Canonical buckets by period and model. A bucket counts only when it lies wholly inside the range,
    //    the current hour being the one exception while the range is anchored to now.
    const bp = new Params();
    const bucketWhere = [
      `t.account_id = ANY(${bp.add(accounts)}::text[])`,
      `t.hour >= ${bp.add(new Date(range.start).toISOString())}::timestamptz`,
      `t.hour + interval '1 hour' <= ${bp.add(new Date(bucketEnd).toISOString())}::timestamptz`,
    ];
    const namedModels = q.models.filter(v => v !== UNKNOWN);
    if (q.models.length) bucketWhere.push(`(${[namedModels.length ? `t.model = ANY(${bp.add(namedModels)}::text[])` : null, q.models.includes(UNKNOWN) ? `t.model = 'unknown'` : null].filter(Boolean).join(' OR ')})`);
    const bucketRows = accounts.length ? await db.unsafe(`WITH canonical AS (
        SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.account_id, t.source_id, t.hour, t.model, t.calls,
          t.input_tokens, t.cached_tokens, t.cache_write_tokens, t.output_tokens, t.total_tokens, t.observed_at
        FROM personal_hub.token_bucket_revisions t
        WHERE ${bucketWhere.join(' AND ')}
        ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC)
      SELECT account_id, model, ${periodExpr('hour', q.resolution, bp, tz)} AS period_start, ${periodExpr('hour', 'day', bp, tz)} AS day_start,
        sum(calls)::float8 AS calls, sum(input_tokens)::float8 AS input_fresh, sum(cached_tokens)::float8 AS input_cached,
        sum(cache_write_tokens)::float8 AS input_cache_write, sum(output_tokens)::float8 AS output, 0::float8 AS unclassified,
        sum(total_tokens)::float8 AS total_tokens, max(hour) AS last_hour, max(observed_at) AS last_observed,
        count(*) FILTER (WHERE hour + interval '1 hour' > ${bp.add(new Date(now).toISOString())}::timestamptz)::int AS partial_buckets
      FROM canonical ${q.machines.length ? `WHERE source_id = ANY(${bp.add(q.machines)}::uuid[])` : ''}
      GROUP BY 1, 2, 3, 4 ORDER BY 3, 1, 2`, bp.values) : [];
    // Buckets straddling a custom range end are excluded rather than prorated; say how many.
    const sp = new Params();
    const straddleModel = q.models.length ? `AND (${[namedModels.length ? `t.model = ANY(${sp.add(namedModels)}::text[])` : null, q.models.includes(UNKNOWN) ? `t.model = 'unknown'` : null].filter(Boolean).join(' OR ')})` : '';
    const [straddle] = accounts.length ? await db.unsafe(`SELECT count(DISTINCT (t.account_id, t.session_hash, t.hour, t.model))::int AS buckets
        FROM personal_hub.token_bucket_revisions t WHERE t.account_id = ANY(${sp.add(accounts)}::text[]) ${straddleModel}
          AND ((t.hour < ${sp.add(new Date(range.start).toISOString())}::timestamptz AND t.hour + interval '1 hour' > ${sp.add(new Date(range.start).toISOString())}::timestamptz)
            OR (t.hour < ${sp.add(new Date(bucketEnd).toISOString())}::timestamptz AND t.hour + interval '1 hour' > ${sp.add(new Date(bucketEnd).toISOString())}::timestamptz))`, sp.values) : [{ buckets: 0 }];
    // Conversations under the bucket basis are the distinct sessions among the canonical buckets in scope.
    const cp0 = new Params();
    const [bucketSessions] = accounts.length ? await db.unsafe(`WITH canonical AS (
        SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.account_id, t.session_hash, t.source_id
        FROM personal_hub.token_bucket_revisions t
        WHERE t.account_id = ANY(${cp0.add(accounts)}::text[]) AND t.hour >= ${cp0.add(new Date(range.start).toISOString())}::timestamptz
          AND t.hour + interval '1 hour' <= ${cp0.add(new Date(bucketEnd).toISOString())}::timestamptz
          ${namedModels.length || q.models.includes(UNKNOWN) ? `AND (${[namedModels.length ? `t.model = ANY(${cp0.add(namedModels)}::text[])` : null, q.models.includes(UNKNOWN) ? `t.model = 'unknown'` : null].filter(Boolean).join(' OR ')})` : ''}
        ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC)
      SELECT count(DISTINCT session_hash)::int AS conversations FROM canonical ${q.machines.length ? `WHERE source_id = ANY(${cp0.add(q.machines)}::uuid[])` : ''}`, cp0.values) : [{ conversations: 0 }];
    const bucketConversations = num(bucketSessions.conversations);
    if (num(straddle.buckets) > 0) notes.push(`${num(straddle.buckets)} hourly bucket(s) straddling a range edge are excluded rather than prorated.`);

    // 2. Requests: one canonical row per logical request; grouped several ways from the same CTE.
    const rp = new Params();
    const cte = requestCte(rp, q, accounts, range);
    const requestPeriodRows = accounts.length ? await db.unsafe(`WITH ${cte.text}
      SELECT r.matches, r.model_actual AS model, ${periodExpr('r.activity_at', q.resolution, rp, tz)} AS period_start, ${compositionSelect()},
        max(r.observed_at) AS last_observed
      FROM requests r GROUP BY 1, 2, 3 ORDER BY 3, 2`, rp.values) : [];
    const pp = new Params(); const pcte = requestCte(pp, q, accounts, range);
    const projectRows = accounts.length ? await db.unsafe(`WITH ${pcte.text}
      SELECT coalesce(r.project_state, 'unknown') AS state, r.project_id, r.project_label, ${compositionSelect()}
      FROM requests r WHERE r.matches GROUP BY 1, 2, 3 ORDER BY total_tokens DESC NULLS LAST`, pp.values) : [];
    const ap = new Params(); const acte = requestCte(ap, q, accounts, range);
    const agentRows = accounts.length ? await db.unsafe(`WITH ${acte.text}
      SELECT r.agent_key, coalesce(r.agent_class, 'unknown') AS agent_class, r.agent_name, r.agent_depth, r.parent_agent_key, r.model_actual AS model,
        CASE WHEN r.agent_identity_basis IS NULL THEN 'unattributed' WHEN r.agent_class = 'main' OR r.agent_depth = 0 THEN 'main'
             WHEN r.agent_depth > 0 OR r.parent_agent_key IS NOT NULL THEN 'subagent' ELSE 'unattributed' END AS role,
        ${compositionSelect()}
      FROM requests r WHERE r.matches GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY total_tokens DESC NULLS LAST`, ap.values) : [];
    const cp = new Params(); const ccte = requestCte(cp, q, accounts, range);
    const pricingRows = accounts.length ? await db.unsafe(`WITH ${ccte.text}
      SELECT r.model_actual AS model, r.reasoning_effort, r.service_tier, r.speed, r.context_window_tokens, r.cache_write_ttl, r.token_state, ${compositionSelect()}
      FROM requests r WHERE r.matches GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY total_tokens DESC NULLS LAST`, cp.values) : [];

    // 3. Tools, callers, and outcomes: one invocation identity counts once; the newest result names its outcome.
    const tp = new Params(); const tcte = requestCte(tp, q, accounts, range);
    const toolUnsupported: string[] = [];
    if (q.models.length) toolUnsupported.push('models');
    const toolRows = accounts.length ? await db.unsafe(`WITH ${tcte.text}, canonical_invocations AS (
        SELECT DISTINCT ON (t.account_id, t.invocation_key) t.account_id, t.invocation_key, t.tool_name, t.tool_class, t.tool_namespace, t.caller_agent_key, t.caller_request_key, t.outcome, t.session_hash, t.observed_at, b.source_id
        FROM personal_hub.tool_events t JOIN personal_hub.companion_bindings b ON b.id = t.binding_id
        WHERE t.event_kind = 'invocation' AND t.account_id = ANY(${tp.add(accounts)}::text[])
          AND t.observed_at >= ${tp.add(new Date(range.start - 7 * 24 * HOUR).toISOString())}::timestamptz AND t.observed_at < ${tp.add(new Date(range.end + 7 * 24 * HOUR).toISOString())}::timestamptz
        ORDER BY t.account_id, t.invocation_key, t.observed_at DESC, t.received_at DESC, t.id DESC
      ), invocations AS (
        SELECT * FROM canonical_invocations
        WHERE observed_at >= ${tp.add(new Date(range.start).toISOString())}::timestamptz AND observed_at < ${tp.add(new Date(range.end).toISOString())}::timestamptz
          ${q.machines.length ? `AND source_id = ANY(${tp.add(q.machines)}::uuid[])` : ''}
          ${q.agents.length ? `AND caller_agent_key = ANY(${tp.add(q.agents)}::text[])` : ''}
      ), results AS (
        SELECT DISTINCT ON (t.account_id, t.invocation_key) t.account_id, t.invocation_key, t.outcome
        FROM personal_hub.tool_events t WHERE t.event_kind = 'result' AND t.account_id = ANY(${tp.add(accounts)}::text[])
        ORDER BY t.account_id, t.invocation_key, t.observed_at DESC, t.received_at DESC, t.id DESC
      ), joined AS (
        SELECT i.*, coalesce(res.outcome, i.outcome) AS final_outcome, r.model_actual AS caller_model, r.agent_name AS caller_name, r.agent_class AS caller_class, r.matches
        FROM invocations i LEFT JOIN results res ON res.account_id = i.account_id AND res.invocation_key = i.invocation_key
        LEFT JOIN requests r ON r.account_id = i.account_id AND r.semantic_key = i.caller_request_key)
      SELECT tool_name, tool_class, tool_namespace, caller_agent_key, caller_name, caller_class, caller_model, final_outcome AS outcome,
        (caller_request_key IS NOT NULL) AS has_caller_request, count(*)::int AS invocations
      FROM joined ${cte.detailFilters ? 'WHERE matches' : ''} GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`, tp.values) : [];
    if (cte.detailFilters) toolUnsupported.push('detail filters apply through the calling request; invocations without a retained caller request are excluded');

    // 4. Knowledge sources: rows resolved under the current configuration, per mapped source or unassigned identity.
    const kp = new Params();
    const knowledgeRows = accounts.length ? await db.unsafe(`WITH accesses AS (
        SELECT a.account_id, a.invocation_key, a.access_kind, a.current_configuration, a.source_id, a.source_label, a.source_state, a.identity_id
        FROM personal_hub.resource_access_source_resolution a
        WHERE a.account_id = ANY(${kp.add(accounts)}::text[]) AND a.observed_at >= ${kp.add(new Date(range.start).toISOString())}::timestamptz AND a.observed_at < ${kp.add(new Date(range.end).toISOString())}::timestamptz
      ), invocations AS (
        SELECT DISTINCT ON (t.account_id, t.invocation_key) t.account_id, t.invocation_key, t.session_hash, t.caller_agent_key
        FROM personal_hub.tool_events t WHERE t.event_kind = 'invocation' AND t.account_id = ANY(${kp.add(accounts)}::text[])
        ORDER BY t.account_id, t.invocation_key, t.observed_at DESC, t.received_at DESC, t.id DESC)
      SELECT a.source_id, a.source_label, coalesce(a.source_state, 'unknown') AS state, CASE WHEN a.source_id IS NULL THEN a.identity_id END AS identity_id,
        count(*) FILTER (WHERE a.current_configuration)::int AS accesses, count(*) FILTER (WHERE NOT a.current_configuration)::int AS earlier_configuration_accesses,
        count(DISTINCT a.invocation_key) FILTER (WHERE a.current_configuration)::int AS distinct_invocations,
        count(DISTINCT i.session_hash) FILTER (WHERE a.current_configuration)::int AS distinct_sessions,
        count(DISTINCT i.caller_agent_key) FILTER (WHERE a.current_configuration)::int AS distinct_agents,
        count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'read')::int AS kind_read,
        count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'search')::int AS kind_search,
        count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'write')::int AS kind_write,
        count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'unknown')::int AS kind_unknown
      FROM accesses a LEFT JOIN invocations i ON i.account_id = a.account_id AND i.invocation_key = a.invocation_key
      GROUP BY 1, 2, 3, 4 ORDER BY accesses DESC`, kp.values) : [];
    const [knowledgeTotal] = accounts.length ? await db.unsafe(`SELECT count(DISTINCT a.invocation_key)::int AS distinct_invocations
      FROM personal_hub.resource_access_source_resolution a WHERE a.account_id = ANY($1::text[]) AND a.current_configuration AND a.observed_at >= $2::timestamptz AND a.observed_at < $3::timestamptz`,
      [accounts, new Date(range.start).toISOString(), new Date(range.end).toISOString()]) : [{ distinct_invocations: 0 }];

    // 5. Agent lifecycle: spawn attempts and distinct observed children, from events and request rows together.
    const gp = new Params(); const gcte = requestCte(gp, q, accounts, range);
    const [agentEvidence] = accounts.length ? await db.unsafe(`WITH ${gcte.text}, events AS (
        SELECT DISTINCT ON (e.account_id, e.semantic_key) e.event_kind, e.agent_key, e.outcome
        FROM personal_hub.agent_events e WHERE e.account_id = ANY(${gp.add(accounts)}::text[])
          AND e.observed_at >= ${gp.add(new Date(range.start).toISOString())}::timestamptz AND e.observed_at < ${gp.add(new Date(range.end).toISOString())}::timestamptz
        ORDER BY e.account_id, e.semantic_key, e.observed_at DESC, e.received_at DESC, e.id DESC)
      SELECT (SELECT count(*)::int FROM events WHERE event_kind = 'spawn') AS spawns,
        (SELECT count(DISTINCT r.session_hash)::int FROM requests r WHERE r.matches) AS conversations,
        (SELECT count(DISTINCT agent_key)::int FROM (
          SELECT agent_key FROM events WHERE event_kind IN ('start', 'resume', 'finish') AND agent_key IS NOT NULL
          UNION SELECT r.agent_key FROM requests r WHERE r.matches AND r.agent_key IS NOT NULL AND (r.agent_depth > 0 OR r.parent_agent_key IS NOT NULL)) children) AS observed_children`, gp.values) : [{ spawns: 0, observed_children: 0, conversations: 0 }];

    // 6. Monthly snapshots for the months the range touches, crosswalked to accounts where the operator mapped them.
    const months = monthsWithin(range, tz);
    const closedMonths = months.filter(month => monthBounds(month, tz).end <= now);
    const snapshotRows = await db.unsafe(`SELECT DISTINCT ON (rv.period_key, rv.subject_key) rv.period_key, rv.subject_key, rv.status, rv.produced_at,
        rv.payload->>'machine_name' AS machine_name,
        (rv.payload#>>'{report,current,totals,total_tokens}')::float8 AS total_tokens, (rv.payload#>>'{report,current,totals,calls}')::float8 AS calls,
        (rv.payload#>>'{report,current,totals,threads}')::float8 AS threads,
        coalesce(rv.payload#>'{report,current,daily}', '[]'::jsonb) AS daily, rv.payload#>'{report,current,exclusive_composition}' AS composition,
        rv.payload#>>'{report,current,environmental_estimate,methodology_version}' AS methodology_version,
        rv.payload#>>'{report,current,api_equivalent_cost,pricing_catalog,version}' AS pricing_catalog,
        (rv.payload#>>'{report,current,api_equivalent_cost,estimated_cost_usd}')::float8 AS estimated_cost_usd,
        sub.account_id, sub.source_timezone
      FROM personal_hub.report_revisions rv LEFT JOIN personal_hub.usage_report_subjects sub ON sub.subject_key = rv.subject_key
      WHERE rv.kind = 'usage' AND rv.status <> 'failed' AND rv.period_key = ANY($1::text[])
      ORDER BY rv.period_key, rv.subject_key, CASE WHEN rv.period_key = ANY($2::text[]) AND rv.status = 'complete' THEN 0 ELSE 1 END, rv.produced_at DESC, rv.received_at DESC`,
      [months, closedMonths]);
    // Which (account, source month) pairs the hourly ledger covers at all, over the whole months, not just the range.
    const mp = new Params();
    const monthCoverage = accounts.length && months.length ? await db.unsafe(`SELECT t.account_id, to_char(t.hour AT TIME ZONE ${mp.add(tz)}, 'YYYY-MM') AS month
      FROM personal_hub.token_bucket_revisions t WHERE t.account_id = ANY(${mp.add(accounts)}::text[])
        AND t.hour >= ${mp.add(new Date(monthBounds(months[0], tz).start).toISOString())}::timestamptz AND t.hour < ${mp.add(new Date(monthBounds(months.at(-1)!, tz).end).toISOString())}::timestamptz
      GROUP BY 1, 2`, mp.values) : [];
    const coveredMonths = new Set(monthCoverage.map(r => `${r.account_id}|${r.month}`));

    // ---- Assemble. Points are keyed by their aligned interval start, which is what the rows group under.
    const pointIndex = new Map(periods.map((period, index) => [period.aligned, index]));
    const points: SeriesPoint[] = periods.map(period => ({ start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString(),
      total_tokens: 0, calls: 0, composition: emptyComposition(), state: 'missing', sources: [] }));
    const mark = (index: number, source: SeriesPoint['sources'][number]) => { if (!points[index].sources.includes(source)) points[index].sources.push(source); };

    const useRequests = cte.detailFilters;
    const headline = empty();
    const byModel = new Map<string, { total_tokens: number; calls: number; composition: Composition; basis: 'buckets' | 'requests' }>();
    const modelSeries = new Map<string, Map<number, { total_tokens: number; calls: number }>>();
    const cohorts = new Map<string, { account_id: string; provider: string; month: string; calls: number; raw_tokens: number; basis: 'buckets' | 'snapshot' }>();
    let lastObservation: number | null = null;
    const observe = (value: unknown) => { const instant = value ? new Date(value as string).getTime() : NaN; if (Number.isFinite(instant)) lastObservation = Math.max(lastObservation ?? 0, instant); };
    const bucketTotals = { tokens: 0, calls: 0 };
    for (const row of bucketRows) {
      const start = new Date(row.period_start as string).getTime();
      const index = pointIndex.get(start);
      bucketTotals.tokens += num(row.total_tokens); bucketTotals.calls += num(row.calls);
      const month = localMonthKey(new Date(row.day_start as string).getTime(), tz);
      const cohortKey = `${row.account_id}|${month}`;
      const cohort = cohorts.get(cohortKey) ?? { account_id: row.account_id as string, provider: byId.get(row.account_id as string)?.provider ?? UNKNOWN, month, calls: 0, raw_tokens: 0, basis: 'buckets' as const };
      cohort.calls += num(row.calls); cohort.raw_tokens += num(row.total_tokens); cohorts.set(cohortKey, cohort);
      if (useRequests) continue;   // request rows drive the headline; buckets still bound the population below
      observe(row.last_observed);
      headline.total_tokens += num(row.total_tokens); headline.calls += num(row.calls); addComposition(headline.composition, row);
      const model = byModel.get(row.model as string) ?? { total_tokens: 0, calls: 0, composition: emptyComposition(), basis: 'buckets' as const };
      model.total_tokens += num(row.total_tokens); model.calls += num(row.calls); addComposition(model.composition, row); byModel.set(row.model as string, model);
      if (index !== undefined) {
        const point = points[index];
        point.total_tokens += num(row.total_tokens); point.calls += num(row.calls); addComposition(point.composition, row);
        point.state = num(row.partial_buckets) > 0 ? 'partial' : 'observed'; mark(index, 'buckets');
        const series = modelSeries.get(row.model as string) ?? new Map(); const entry = series.get(index) ?? { total_tokens: 0, calls: 0 };
        entry.total_tokens += num(row.total_tokens); entry.calls += num(row.calls); series.set(index, entry); modelSeries.set(row.model as string, series);
      }
    }
    const requestTotals = { all: { tokens: 0, calls: 0 }, matching: { tokens: 0, calls: 0, conversations: 0 } };
    for (const row of requestPeriodRows) {
      requestTotals.all.tokens += num(row.total_tokens); requestTotals.all.calls += num(row.calls);
      if (!row.matches) continue;
      requestTotals.matching.tokens += num(row.total_tokens); requestTotals.matching.calls += num(row.calls);
      if (!useRequests) continue;
      observe(row.last_observed);
      headline.total_tokens += num(row.total_tokens); headline.calls += num(row.calls); addComposition(headline.composition, row);
      const key = (row.model as string | null) ?? UNKNOWN;
      const model = byModel.get(key) ?? { total_tokens: 0, calls: 0, composition: emptyComposition(), basis: 'requests' as const };
      model.total_tokens += num(row.total_tokens); model.calls += num(row.calls); addComposition(model.composition, row); byModel.set(key, model);
      const start = new Date(row.period_start as string).getTime();
      const index = pointIndex.get(start);
      if (index !== undefined) {
        const point = points[index];
        point.total_tokens += num(row.total_tokens); point.calls += num(row.calls); addComposition(point.composition, row); point.state = 'observed'; mark(index, 'requests');
        const series = modelSeries.get(key) ?? new Map(); const entry = series.get(index) ?? { total_tokens: 0, calls: 0 };
        entry.total_tokens += num(row.total_tokens); entry.calls += num(row.calls); series.set(index, entry); modelSeries.set(key, series);
      }
    }
    if (useRequests) {
      headline.basis = 'requests';
      headline.unfilterable_tokens = Math.max(0, bucketTotals.tokens - requestTotals.all.tokens);
      headline.unfilterable_calls = Math.max(0, bucketTotals.calls - requestTotals.all.calls);
      headline.uncovered_request_tokens = Math.max(0, requestTotals.all.tokens - bucketTotals.tokens);
      notes.push(`Filters on ${detailFilters.join(', ')} apply to request detail only; ${headline.unfilterable_tokens} bucket tokens in the selected scope carry no request detail and are excluded, not matched.`);
      if (headline.uncovered_request_tokens > 0) notes.push(`${headline.uncovered_request_tokens} request-detail tokens fall in hours the bucket ledger does not cover; the two ledgers do not reconcile there.`);
    }
    headline.conversations = useRequests ? num(agentEvidence.conversations) : bucketConversations;

    // Historical snapshots: merge only where the hourly ledger has nothing for the mapped account and month.
    const snapshots: UsageQueryResult['historical']['snapshots'] = [];
    let snapshotSeriesExcluded = 0;
    for (const row of snapshotRows) {
      const month = row.period_key as string, accountId = (row.account_id as string | null) ?? null;
      const daily = (row.daily as { date: string; total_tokens: number; calls: number }[]) ?? [];
      const entry = { subject_key: row.subject_key as string, machine_name: (row.machine_name as string | null) ?? null, month, status: row.status as string, produced_at: iso(row.produced_at),
        account_id: accountId, source_timezone: (row.source_timezone as string | null) ?? null, total_tokens: num(row.total_tokens), calls: num(row.calls),
        threads: row.threads === null ? null : num(row.threads), daily_rows: daily.length, merged: 'none' as 'month' | 'days' | 'none', reason: null as string | null, merged_tokens: 0, merged_calls: 0,
        methodology_version: (row.methodology_version as string | null) ?? null, pricing_catalog: (row.pricing_catalog as string | null) ?? null,
        estimated_cost_usd: row.estimated_cost_usd === null ? null : num(row.estimated_cost_usd) };
      const bounds = monthBounds(month, tz);
      if (!accountId) entry.reason = 'subject_not_mapped';
      else if (!accounts.includes(accountId)) entry.reason = 'account_not_selected';
      else if (useRequests || q.models.length || q.machines.length) entry.reason = 'filters_unsupported_by_snapshot';
      else if (coveredMonths.has(`${accountId}|${month}`)) entry.reason = 'hourly_ledger_covers_month';
      else if (bounds.start >= range.start && bounds.end <= range.end) {
        // Whole month inside the range: the month total is a whole-period fact and merges as such.
        entry.merged = 'month'; entry.merged_tokens = entry.total_tokens; entry.merged_calls = entry.calls;
        headline.total_tokens += entry.total_tokens; headline.calls += entry.calls; headline.snapshot_tokens += entry.total_tokens; headline.snapshot_calls += entry.calls;
        const composition = row.composition as Row | null;
        if (composition) {
          headline.composition.input_fresh += num(composition.uncached_input_tokens); headline.composition.input_cached += num(composition.cached_input_tokens);
          headline.composition.output += num(composition.reasoning_output_tokens) + num(composition.nonreasoning_output_tokens);
          headline.composition.reasoning = (headline.composition.reasoning ?? 0) + num(composition.reasoning_output_tokens);
          headline.composition.unclassified += num(composition.unclassified_total_only_tokens);
        }
        const cohortKey = `${accountId}|${month}`;
        cohorts.set(cohortKey, { account_id: accountId, provider: byId.get(accountId)?.provider ?? UNKNOWN, month, calls: entry.calls, raw_tokens: entry.total_tokens, basis: 'snapshot' });
        if (entry.source_timezone === tz && q.resolution === 'day') {
          for (const day of daily) {
            const [y, mo, d] = day.date.split('-').map(Number);
            const index = pointIndex.get(zonedInstant(y, mo, d, entry.source_timezone));
            if (index === undefined) { snapshotSeriesExcluded += num(day.total_tokens); continue; }
            const point = points[index]; point.total_tokens += num(day.total_tokens); point.calls += num(day.calls); point.state = 'observed'; mark(index, 'snapshot');
          }
          entry.merged = 'days';
        } else snapshotSeriesExcluded += entry.total_tokens;
      } else if (entry.source_timezone === tz && q.resolution === 'day') {
        // Part of the month is selected: only whole source days inside the range can be placed, and only when the source zone is the display zone.
        for (const day of daily) {
          const [y, mo, d] = day.date.split('-').map(Number);
          const dayStart = zonedInstant(y, mo, d, entry.source_timezone);
          const index = pointIndex.get(dayStart);
          if (index === undefined || periods[index].clipped) continue;
          entry.merged = 'days'; entry.merged_tokens += num(day.total_tokens); entry.merged_calls += num(day.calls);
          headline.total_tokens += num(day.total_tokens); headline.calls += num(day.calls); headline.snapshot_tokens += num(day.total_tokens); headline.snapshot_calls += num(day.calls);
          const point = points[index]; point.total_tokens += num(day.total_tokens); point.calls += num(day.calls); point.state = 'observed'; mark(index, 'snapshot');
        }
        if (entry.merged === 'none') entry.reason = 'no_whole_source_day_in_range';
        else headline.composition.unclassified += entry.merged_tokens;
      } else entry.reason = !entry.source_timezone ? 'source_timezone_unknown_whole_month_only' : entry.source_timezone !== tz ? 'source_timezone_differs_from_display' : 'hourly_resolution_unsupported';
      snapshots.push(entry);
    }
    if (snapshots.some(s => s.merged === 'month')) notes.push('Merged monthly snapshots contribute whole-month totals; their composition lacks a separate cache-write class and their calls join the environmental cohort at month resolution.');

    // Point states: no rows means a true zero only where the account's collectors had scanned past the interval.
    const scannedThrough = Math.max(...accounts.map(id => m.coverage.get(id)?.through ?? 0), 0);
    const observedFrom = Math.min(...accounts.map(id => m.coverage.get(id)?.from ?? Number.POSITIVE_INFINITY));
    for (const [index, point] of points.entries()) {
      const period = periods[index];
      if (!point.sources.length) point.state = period.end <= scannedThrough && period.start >= observedFrom ? 'zero' : 'missing';
      if (period.end > now || (period.clipped && point.state !== 'missing')) point.state = 'partial';
    }

    const headlineTokens = headline.total_tokens;
    const modelRows = [...byModel.entries()].map(([model, value]) => ({ model, ...value, share: share(value.total_tokens, headlineTokens) })).sort((a, b) => b.total_tokens - a.total_tokens);
    const modelSeriesRows = [...modelSeries.entries()].map(([model, series]) => ({ model,
      points: [...series.entries()].sort((a, b) => a[0] - b[0]).map(([index, value]) => ({ start: points[index].start, ...value })) }));

    const requestEligible = useRequests ? requestTotals.matching.tokens : bucketTotals.tokens;
    const requestCovered = useRequests ? requestTotals.matching.tokens : requestTotals.all.tokens;
    const detailNote = 'Request detail covers the canonical tokens linked to accepted request records; buckets remain the headline until a collection slice is declared complete and reconciled.';
    const pricing = pricingRows.map(row => ({ model: (row.model as string | null) ?? null, reasoning_effort: (row.reasoning_effort as string | null) ?? null, service_tier: (row.service_tier as string | null) ?? null,
      speed: (row.speed as string | null) ?? null, context_window_tokens: row.context_window_tokens === null ? null : num(row.context_window_tokens), cache_write_ttl: (row.cache_write_ttl as string | null) ?? null,
      token_state: (row.token_state as string | null) ?? null, calls: num(row.calls), total_tokens: num(row.total_tokens), composition: (() => { const c = emptyComposition(); addComposition(c, row); return c; })() }));
    const pricedEligible = pricing.reduce((n, row) => n + row.total_tokens, 0);
    const pricedWithEvidence = pricing.filter(row => row.model !== null).reduce((n, row) => n + row.total_tokens, 0);

    const projectRowsOut = projectRows.map(row => ({ state: row.state as UsageQueryResult['projects']['rows'][number]['state'], project_id: (row.project_id as string | null) ?? null,
      label: (row.project_label as string | null) ?? null, total_tokens: num(row.total_tokens), calls: num(row.calls), conversations: num(row.conversations), share: share(num(row.total_tokens), useRequests ? headlineTokens : requestTotals.matching.tokens) }));
    const projectEvidenced = projectRowsOut.filter(r => r.state !== 'unknown').reduce((n, r) => n + r.total_tokens, 0);
    const projectIdentity = projectRowsOut.filter(r => r.state === 'project' || r.state === 'unassigned').reduce((n, r) => n + r.total_tokens, 0);
    const projectMapped = projectRowsOut.filter(r => r.state === 'project').reduce((n, r) => n + r.total_tokens, 0);

    const agentRowsOut = agentRows.map(row => ({ agent_key: (row.agent_key as string | null) ?? null, class: row.agent_class as string, name: (row.agent_name as string | null) ?? null,
      depth: row.agent_depth === null ? null : num(row.agent_depth), parent_agent_key: (row.parent_agent_key as string | null) ?? null, model: (row.model as string | null) ?? null,
      role: row.role as string, total_tokens: num(row.total_tokens), calls: num(row.calls), share: share(num(row.total_tokens), useRequests ? headlineTokens : requestTotals.matching.tokens) }));
    const roleTokens = (role: string) => agentRowsOut.filter(r => r.role === role).reduce((n, r) => n + r.total_tokens, 0);
    const byClass: Record<string, number> = {};
    for (const row of agentRowsOut) byClass[row.class] = (byClass[row.class] ?? 0) + row.total_tokens;

    const toolTotal = toolRows.reduce((n, row) => n + num(row.invocations), 0);
    const byTool = new Map<string, { name: string | null; class: string; namespace: string | null; invocations: number }>();
    const byCaller = new Map<string, { agent_key: string | null; agent_name: string | null; agent_class: string | null; model: string | null; invocations: number }>();
    const byOutcome: Record<string, number> = {};
    let withCaller = 0, withOutcome = 0;
    for (const row of toolRows) {
      const n = num(row.invocations);
      const toolKey = `${row.tool_class}|${row.tool_namespace ?? ''}|${row.tool_name ?? ''}`;
      const tool = byTool.get(toolKey) ?? { name: (row.tool_name as string | null) ?? null, class: row.tool_class as string, namespace: (row.tool_namespace as string | null) ?? null, invocations: 0 };
      tool.invocations += n; byTool.set(toolKey, tool);
      const callerKey = `${row.caller_agent_key ?? ''}|${row.caller_model ?? ''}`;
      const caller = byCaller.get(callerKey) ?? { agent_key: (row.caller_agent_key as string | null) ?? null, agent_name: (row.caller_name as string | null) ?? null, agent_class: (row.caller_class as string | null) ?? null, model: (row.caller_model as string | null) ?? null, invocations: 0 };
      caller.invocations += n; byCaller.set(callerKey, caller);
      const outcome = (row.outcome as string | null) ?? UNKNOWN;
      byOutcome[outcome] = (byOutcome[outcome] ?? 0) + n;
      if (row.caller_agent_key || row.has_caller_request) withCaller += n;
      if (outcome !== UNKNOWN) withOutcome += n;
    }

    const knowledge = knowledgeRows.map(row => ({ source_id: (row.source_id as string | null) ?? null, label: (row.source_label as string | null) ?? null, state: row.state as string,
      accesses: num(row.accesses), distinct_invocations: num(row.distinct_invocations), distinct_sessions: num(row.distinct_sessions), distinct_agents: num(row.distinct_agents),
      by_access_kind: { read: num(row.kind_read), search: num(row.kind_search), write: num(row.kind_write), unknown: num(row.kind_unknown) }, earlier_configuration_accesses: num(row.earlier_configuration_accesses) }));

    const cohortRows = [...cohorts.values()].map(c => ({ ...c, average_raw_tokens_per_call: c.calls > 0 ? c.raw_tokens / c.calls : null })).sort((a, b) => a.month.localeCompare(b.month) || a.account_id.localeCompare(b.account_id));
    if (useRequests) unsupported.push('Environmental cohorts stay at account and source month; a detail filter does not reclassify the cohort, so filtered calls are reported against the unfiltered cohort inputs.');
    if (q.resolution === 'hour' && snapshots.length) unsupported.push('Monthly snapshots cannot be placed on an hourly series.');

    return clone({
      as_of: new Date(now).toISOString(),
      scope: { range: { preset: range.preset, start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString(), timezone: tz, anchored_to_now: range.anchored_to_now, resolution: q.resolution },
        accounts: selected, filters: { accounts: q.accounts, providers: q.providers, models: q.models, efforts: q.efforts, machines: q.machines, surfaces: q.surfaces, projects: q.projects, agent_scope: q.agent_scope, agents: q.agents },
        detail_filters: detailFilters },
      headline: { ...headline, last_observation: lastObservation ? new Date(lastObservation).toISOString() : null },
      series: { resolution: q.resolution, points, excludes_snapshot_tokens: snapshotSeriesExcluded },
      by_model: modelRows, model_series: modelSeriesRows,
      pricing_inputs: { rows: pricing, coverage: coverage('tokens', headlineTokens, pricedEligible, pricedWithEvidence, 'Pricing inputs exist only on request records; the eligible population is the request-covered tokens, and rows without a model cannot be priced.'), note: 'Catalog pricing is applied by the cost calculation (USG-013); these are its inputs with effort, tier, speed, context, and cache-write evidence preserved and unknown kept unknown.' },
      projects: { rows: projectRowsOut,
        coverage: coverage('tokens', headlineTokens, requestCovered, projectEvidenced, 'Project evidence: request-covered tokens with a project identity or an explicit No project; Unknown project is the remainder.'),
        registry: coverage('tokens', headlineTokens, projectIdentity, projectMapped, 'Registry mapping: tokens carrying a stable project identity that a named project maps.') },
      agents: { rows: agentRowsOut.map(({ role: _role, ...row }) => row),
        summary: { main_tokens: roleTokens('main'), subagent_tokens: roleTokens('subagent'), unattributed_tokens: roleTokens('unattributed'), observed_children: num(agentEvidence.observed_children), spawns: num(agentEvidence.spawns), by_class: byClass },
        coverage: coverage('tokens', headlineTokens, requestCovered, roleTokens('main') + roleTokens('subagent'), 'Agent attribution: request-covered tokens assigned to a main or child identity; missing identity stays unattributed.') },
      tools: { invocations: toolTotal, by_tool: [...byTool.values()].map(t => ({ ...t, share: share(t.invocations, toolTotal) })).sort((a, b) => b.invocations - a.invocations),
        by_caller: [...byCaller.values()].sort((a, b) => b.invocations - a.invocations), by_outcome: byOutcome,
        caller_coverage: coverage('invocations', toolTotal, toolTotal, withCaller, 'Reported invocations with a supported caller.'),
        outcome_coverage: coverage('invocations', toolTotal, toolTotal, withOutcome, 'Reported invocations with a supported outcome.'), unsupported_filters: toolUnsupported },
      knowledge: { rows: knowledge, distinct_invocations: num(knowledgeTotal.distinct_invocations),
        note: 'Per-source access counts overlap when one invocation touches several sources; distinct_invocations is the unduplicated total. Only rows classified under each install\'s current configuration count.' },
      environmental_inputs: { cohorts: cohortRows, coverage: coverage('calls', headline.calls, cohortRows.reduce((n, c) => n + c.calls, 0), cohortRows.reduce((n, c) => n + c.calls, 0), 'Cohorts are account and source calendar month over canonical calls; classification and factors belong to the environmental calculation.'),
        note: 'Average raw tokens per call is the cohort input the reused method classifies; nothing here converts allowance movement or dollars into calls.' },
      historical: { snapshots, note: 'A snapshot merges only for a mapped account whose hourly ledger has nothing in that month, as a whole month, or by whole source days when its zone is known; otherwise it is listed and not counted.' },
      request_detail: { covered_tokens: requestCovered, covered_calls: useRequests ? requestTotals.matching.calls : requestTotals.all.calls,
        coverage: coverage('tokens', useRequests ? headlineTokens : bucketTotals.tokens, requestEligible, requestCovered, detailNote) },
      unsupported, notes,
    });
  }

  /** Subjects seen in monthly reports beside their crosswalk, for the Settings surface that maps them. */
  async function listReportSubjects() {
    const db = await sql();
    const rows = await db`SELECT rv.subject_key, max(rv.payload->>'machine_name') AS machine_name, min(rv.period_key) AS first_month, max(rv.period_key) AS last_month,
        count(*)::int AS revisions, sub.account_id, sub.source_timezone, sub.updated_at
      FROM personal_hub.report_revisions rv LEFT JOIN personal_hub.usage_report_subjects sub ON sub.subject_key = rv.subject_key
      WHERE rv.kind = 'usage' GROUP BY rv.subject_key, sub.account_id, sub.source_timezone, sub.updated_at ORDER BY rv.subject_key`;
    const accounts = await db`SELECT id, provider, label FROM personal_hub.usage_accounts ORDER BY created_at, id`;
    return clone({ subjects: rows, accounts });
  }

  const subjectMutation = z.object({
    subject_key: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/), account_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/).nullable(),
    source_timezone: z.string().min(1).max(64).refine(isSupportedTimeZone, 'Unsupported time zone').nullable(),
  }).strict();
  /** Sets or clears a subject's crosswalk; the mapping is configuration and never edits an envelope. */
  async function updateReportSubject(input: unknown) {
    const data = subjectMutation.parse(input);
    const db = await sql();
    const [seen] = await db`SELECT 1 FROM personal_hub.report_revisions WHERE kind = 'usage' AND subject_key = ${data.subject_key} LIMIT 1`;
    if (!seen) throw new RequestError('Unknown report subject', 404);
    if (data.account_id) {
      const [account] = await db`SELECT id FROM personal_hub.usage_accounts WHERE id = ${data.account_id}`;
      if (!account) throw new RequestError('Unknown account', 404);
    }
    await db`INSERT INTO personal_hub.usage_report_subjects (subject_key, account_id, source_timezone) VALUES (${data.subject_key}, ${data.account_id}, ${data.source_timezone})
      ON CONFLICT (subject_key) DO UPDATE SET account_id = EXCLUDED.account_id, source_timezone = EXCLUDED.source_timezone, updated_at = now()`;
    return { ok: true, ...data };
  }

  return { usageQuery, listReportSubjects, updateReportSubject };
}

const defaultQuery = createUsageQuery();
export const { listReportSubjects, updateReportSubject } = defaultQuery;

/** Bounded per-scope cache: identical parameters within thirty seconds share one read, and at most 32 scopes are kept. */
const cache = new Map<string, { expires: number; value: Promise<UsageQueryResult> }>();
export function usageQuery(params: UsageQuery) {
  const key = stableJson(params);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = defaultQuery.usageQuery(params, { now }).catch(error => { cache.delete(key); throw error; });
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: now + 30_000, value });
  return value;
}
