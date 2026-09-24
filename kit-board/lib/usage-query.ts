import { z } from 'zod';
import type postgres from 'postgres';
import { RequestError, stableJson } from './contracts';
import { readCache } from './read-cache';
import { DATABASE_JOB_BUDGET_INTERVAL } from './database-budget';
import {
  DISPLAY_TIMEZONE, HOUR, PRESETS, RESOLUTIONS, isSupportedTimeZone, localMonthKey, monthBounds, monthsWithin,
  periodsWithin, resolveRange, zonedInstant, type Preset, type Resolution, type ResolvedRange,
} from './usage-periods';
import { catalogThresholds, contextBandFor, priceUsage, type ApiEquivalentEstimate, type PricingInputRow } from './usage-pricing';
import { estimateEnvironment, type CohortInput, type EnvironmentalEstimate, type StoredEstimate } from './environmental-estimate';
import { BUILTIN_PROVIDERS, KNOWN_BUILTIN_AGENTS, KNOWN_BUILTIN_TOOLS } from './usage-builtins';
import { projectMapCtes } from './usage-project-map';

export const USAGE_QUERY_SECTIONS = ['overview', 'requests', 'tools', 'knowledge'] as const;
export type UsageQuerySection = (typeof USAGE_QUERY_SECTIONS)[number];
/** Process-local coalescing only; HTTP responses stay private/no-store. */
export const USAGE_QUERY_CACHE_TTL_MS = 5 * 60_000;
const USAGE_QUERY_CACHE_MAX = 96;

/**
 * One filtered usage query layer (USG-012). Tokens cards share this selected scope: half-open range
 * at local boundaries, OR within a dimension and AND across dimensions, explicit Unknown,
 * full-bucket inclusion, and per-section coverage with stated denominators. An optional `section`
 * reads only the tables that card needs so the page can paint progressively; omitting it still
 * returns the full result.
 *
 * Source precedence follows the metric contract. Canonical hourly buckets are the headline token
 * and call authority for every slice, because no collection manifest has declared a slice complete
 * at request level. Local Claude and Codex hours come from `token_bucket_revisions`; Cursor hosted
 * and Admin API aggregates come from `account_usage_buckets`. The two ledgers are unioned, never
 * summed as if they were the same work. Request records supply the dimensions buckets lack (project,
 * effort, surface, agent); a filter on one of those dimensions narrows the headline to the request
 * detail that carries it and discloses the bucket tokens it cannot examine. Pricing follows the
 * headline: buckets already carry model, hour, and exclusive composition, which is enough to
 * estimate at assumed Standard on the short context band, with the Chicago calendar date of the
 * hour choosing the rate period. Request records add effort, tier, speed, cache-write TTL, and
 * per-request context band when they are the headline. Monthly snapshots are historical fallback
 * only where the hourly ledger has nothing for a crosswalked account and month, and are never
 * expanded into finer detail than they recorded.
 *
 * Detail reads never window the whole ledger. They discover keys whose activity falls in the
 * selected range, rank only those keys' revisions, and resolve project/knowledge identity from
 * that key set instead of the global resolution views. Tools look up calling requests by the
 * invocation set they already have; knowledge is its own section so a tool timeout cannot hold
 * the knowledge card.
 */
type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const num = (value: unknown) => Number(value ?? 0);
const iso = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).toISOString());
const UNKNOWN = 'unknown';

/**
 * How far on each side of a selected range a detail read ranks a key's revisions before applying the range
 * filter, so the canonical revision is chosen from all of them rather than from the slice that happens to
 * fall inside. `activity_at` is GENERATED from coalesce(ended_at, started_at, observed_at), so a reader that
 * emits a request once while it runs and again once it finishes moves it; this has to stay comfortably wider
 * than any such spread. Production carries zero spread across all 93,771 keys and the fixtures' widest is
 * three hours (both measured 2026-09-21); `usage-store.integration.test.ts` asserts the margin holds.
 */
export const REVISION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const PROVIDERS = ['codex', 'claude', 'cursor', 'anthropic_api', 'openai_api'] as const;
export const SURFACES = ['cli', 'ide', 'desktop', 'sdk', 'ci', 'cloud', UNKNOWN] as const;
/**
 * Project filter codes besides a project id. `no_project` is the explicit No project row only; `projectless`
 * is the app's own chats with no project ("Chats / no project"); bare `not_reported` covers every machine
 * that has not reported projects, and `not_reported:<install id>` one machine, which is what its own row
 * applies. Each card row applies exactly the requests it shows.
 */
export const PROJECT_STATES = ['no_project', 'projectless', UNKNOWN, 'unassigned', 'not_reported'] as const;
const NOT_REPORTED_FILTER = /^not_reported:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isProjectCode = (value: string) => (PROJECT_STATES as readonly string[]).includes(value) || NOT_REPORTED_FILTER.test(value);
/** How a request row's agent role reads when no label states one: identity first, then class and depth. */
const AGENT_ROLE_SQL = (a: string) => `CASE WHEN ${a}.agent_identity_basis IS NULL THEN 'unattributed' WHEN ${a}.agent_class = 'main' OR ${a}.agent_depth = 0 THEN 'main'
    WHEN ${a}.agent_depth > 0 OR ${a}.parent_agent_key IS NOT NULL THEN 'subagent' ELSE 'unattributed' END`;
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
  projects: list(z.union([z.uuid(), z.enum(PROJECT_STATES), z.string().regex(NOT_REPORTED_FILTER)]), 50),
  agent_scope: z.enum(['all', 'main', 'subagent']).default('all'),
  agents: list(sha256, 50),
  /** When set, skip tables other cards own. Omitted = the full result (tests and non-Tokens callers). Knowledge is separate from tools so each can finish without the other. */
  section: z.enum(USAGE_QUERY_SECTIONS).optional(),
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
    accounts: { id: string; provider: string; label: string }[];
    /** Every non-browser collector source, the machine filter's vocabulary. */
    machines: { id: string; account_id: string; machine_label: string; mode: string }[];
    filters: Omit<UsageQuery, 'preset' | 'start' | 'end' | 'timezone' | 'resolution' | 'section'>;
    /** Filters that only request detail can answer; when any is set the headline is the covered request detail. */
    detail_filters: string[] };
  headline: { total_tokens: number; calls: number; conversations: number | null; composition: Composition; basis: 'buckets' | 'requests';
    /** Tokens in the selected bucket population the active detail filters could not examine. */
    unfilterable_tokens: number; unfilterable_calls: number; /** Request-detail tokens in hours with no bucket: a ledger shortfall, disclosed rather than clamped. */ uncovered_request_tokens: number;
    snapshot_tokens: number; snapshot_calls: number; last_observation: string | null };
  series: { resolution: Resolution; points: SeriesPoint[]; excludes_snapshot_tokens: number };
  by_model: { model: string; total_tokens: number; calls: number; composition: Composition; share: number | null; basis: 'buckets' | 'requests' }[];
  model_series: { model: string; points: { start: string; total_tokens: number; calls: number }[] }[];
  /**
   * Model crossed with reasoning effort over the same periods. Only request records carry effort, so this
   * is request detail alone and never reconciles to the bucket headline; `coverage` says how much of the
   * headline it can speak for, and a model that reports no effort is kept as `unknown` rather than dropped.
   */
  effort_series: { rows: { model: string; effort: string; points: { start: string; total_tokens: number; calls: number }[] }[]; coverage: Coverage };
  pricing_inputs: { rows: { provider: string | null; model: string | null; reasoning_effort: string | null; service_tier: string | null; speed: string | null; context_window_tokens: number | null;
      cache_write_ttl: string | null; token_state: string | null; context_band: 'short' | 'long'; rate_date: string | null; calls: number; composition: Composition; total_tokens: number }[];
    coverage: Coverage; note: string };
  /**
   * One row per resolved state and project (lib/usage-project-map.ts). `label` is the app project's name
   * ("(removed)" once no active app project keeps it), "Chats / no project" for an app chat with no
   * project, or "<machine>: companion update needed" for an install that has never reported projects.
   */
  projects: { rows: { state: 'project' | 'unassigned' | 'no_project' | 'unknown' | 'not_reported'; project_id: string | null; label: string | null; filter_value: string; total_tokens: number; calls: number; conversations: number; share: number | null }[];
    coverage: Coverage; registry: Coverage };
  /**
   * One row per displayed agent group (spec 6.3): provider, role and name from the labels first, then the
   * ledger. `group_id` is the value the agent filter takes; `instances` counts distinct agent keys.
   */
  agents: { rows: { group_id: string; provider: string; role: 'main' | 'subagent' | 'unattributed'; name: string; builtin: boolean; instances: number; sessions: number;
      total_tokens: number; calls: number; composition: Composition; share: number | null }[];
    summary: { main_tokens: number; subagent_tokens: number; unattributed_tokens: number; observed_children: number; spawns: number; by_class: Record<string, number> }; coverage: Coverage };
  /**
   * `by_tool` is top-level rows only: a nested Codex MCP call sits in its exec row's `children` (and a
   * child whose exec is outside the range under the synthetic "exec (outside range)" row, which has 0
   * invocations of its own). `invocations` counts every invocation once, children included.
   */
  tools: { invocations: number; by_tool: { name: string | null; class: string; namespace: string | null; builtin: boolean; machine: string | null; synthetic: boolean; invocations: number; share: number | null;
      children: { name: string | null; namespace: string | null; invocations: number; outcomes: Record<string, number> }[] }[];
    by_caller: { state: 'group' | 'label' | 'outside_range' | 'none'; group_id: string | null; provider: string | null; role: string | null; name: string | null; builtin: boolean; invocations: number }[];
    by_outcome: Record<string, number>; caller_coverage: Coverage; outcome_coverage: Coverage; unsupported_filters: string[] };
  /** Access rows follow the same filters as tool invocations: machine from the access's binding, agent from the invocation's caller, detail filters through the calling request. */
  knowledge: { rows: { source_id: string | null; label: string | null; state: string; accesses: number; distinct_invocations: number; distinct_sessions: number; distinct_agents: number;
      by_access_kind: Record<string, number>; earlier_configuration_accesses: number }[]; distinct_invocations: number; note: string; unsupported_filters: string[] };
  environmental_inputs: { cohorts: CohortInput[]; coverage: Coverage; note: string };
  /** The API-equivalent estimate over the pricing inputs and the environmental estimate over the cohorts (USG-013). */
  cost: ApiEquivalentEstimate; environment: EnvironmentalEstimate;
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

function modelFilterSql(p: Params, q: UsageQuery, namedModels: string[], column: string): string {
  if (!q.models.length) return '';
  const parts = [
    namedModels.length ? `${column} = ANY(${p.add(namedModels)}::text[])` : null,
    q.models.includes(UNKNOWN) ? `${column} = 'unknown'` : null,
  ].filter(Boolean);
  return parts.length ? `AND (${parts.join(' OR ')})` : '';
}

/**
 * Local hourly revisions unioned with provider-reported account buckets, ranked to one canonical row per
 * key. Distinct accounts, never double-counted work. Every canonical bucket overlapping the span is kept,
 * so one ranking serves both the buckets wholly inside a range and the count of those straddling its edges.
 * Both bounds compare the indexed start column against a constant (`hour > start - 1h`, never
 * `hour + 1h > start`), so the ledger scan is an index range scan.
 */
function canonicalBucketCte(p: Params, accounts: string[], startIso: string, endIso: string): string {
  return `local_canonical AS (
      SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model)
        t.account_id, t.source_id, t.session_hash, t.hour, t.hour + interval '1 hour' AS bucket_end, t.model, t.calls,
        t.input_tokens, t.cached_tokens, t.cache_write_tokens, t.output_tokens, 0::bigint AS unclassified,
        t.total_tokens, t.observed_at, 'local'::text AS origin
      FROM personal_hub.token_bucket_revisions t
      WHERE t.account_id = ANY(${p.add(accounts)}::text[])
        AND t.hour > ${p.add(startIso)}::timestamptz - interval '1 hour'
        AND t.hour < ${p.add(endIso)}::timestamptz
      ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC
    ), provider_canonical AS (
      SELECT DISTINCT ON (u.account_id, u.report_source, u.bucket_start, u.bucket_end, u.dimensions_hash)
        u.account_id, b.source_id, NULL::text AS session_hash, u.bucket_start AS hour, u.bucket_end,
        coalesce(nullif(u.model, ''), 'unknown') AS model, coalesce(u.requests, 0) AS calls,
        coalesce(u.input_tokens, 0) AS input_tokens, coalesce(u.cached_tokens, 0) AS cached_tokens,
        coalesce(u.cache_write_tokens, 0) AS cache_write_tokens, coalesce(u.output_tokens, 0) AS output_tokens,
        coalesce(u.unclassified_tokens, 0) AS unclassified,
        coalesce(
          u.total_tokens,
          coalesce(u.input_tokens, 0) + coalesce(u.cached_tokens, 0)
            + coalesce(u.cache_write_tokens, 0) + coalesce(u.output_tokens, 0)
        ) AS total_tokens,
        u.observed_at, 'provider'::text AS origin
      FROM personal_hub.account_usage_buckets u
      JOIN personal_hub.companion_bindings b ON b.id = u.binding_id
      WHERE u.account_id = ANY(${p.add(accounts)}::text[])
        AND u.bucket_start < ${p.add(endIso)}::timestamptz
        AND u.bucket_end > ${p.add(startIso)}::timestamptz
      ORDER BY u.account_id, u.report_source, u.bucket_start, u.bucket_end, u.dimensions_hash,
        u.provider_refreshed_at DESC NULLS LAST, u.observed_at DESC, u.id DESC
    ), canonical AS (
      SELECT * FROM local_canonical
      UNION ALL
      SELECT * FROM provider_canonical
    )`;
}

type Meta = {
  accounts: { id: string; provider: string; label: string }[];
  sources: { id: string; account_id: string; machine_label: string; mode: string }[];
  coverage: Map<string, { from: number | null; through: number | null }>;
};

/** The analyzer's stored estimate for a merged legacy month, when the envelope carries one. */
function storedEstimate(value: unknown): StoredEstimate | null {
  const e = value as Row | null;
  if (!e || typeof e !== 'object' || typeof e.methodology_version !== 'string' || !e.energy_kwh || !e.direct_water_liters || !e.operational_co2_kg) return null;
  const basis = (e.basis ?? {}) as Row;
  const triple = (v: unknown, keys: string[]) => Object.fromEntries(keys.map(k => [k, num((v as Row)[k])]));
  return { methodology_version: e.methodology_version, planning_workload_class: (basis.planning_workload_class as string | null) ?? null,
    planning_wh_per_call: basis.planning_wh_per_call === undefined || basis.planning_wh_per_call === null ? null : num(basis.planning_wh_per_call),
    energy_kwh: triple(e.energy_kwh, ['efficient_production_floor', 'planning', 'long_context_upper']) as StoredEstimate['energy_kwh'],
    direct_water_liters: triple(e.direct_water_liters, ['efficient_production_floor', 'planning', 'long_context_upper']) as StoredEstimate['direct_water_liters'],
    operational_co2_kg: triple(e.operational_co2_kg, ['clean_energy_floor', 'planning_us_grid', 'long_context_us_grid']) as StoredEstimate['operational_co2_kg'] };
}
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
type PricingRowOut = UsageQueryResult['pricing_inputs']['rows'][number];
function pricingRowFromSql(row: Row, extras: { provider?: string | null; context_band: 'short' | 'long'; rate_date: string | null }): PricingRowOut {
  const composition = emptyComposition();
  addComposition(composition, row);
  return {
    provider: extras.provider ?? ((row.provider as string | null) ?? null),
    model: (row.model as string | null) ?? null,
    reasoning_effort: (row.reasoning_effort as string | null) ?? null,
    service_tier: (row.service_tier as string | null) ?? null,
    speed: (row.speed as string | null) ?? null,
    context_window_tokens: row.context_window_tokens === null || row.context_window_tokens === undefined ? null : num(row.context_window_tokens),
    cache_write_ttl: (row.cache_write_ttl as string | null) ?? null,
    token_state: (row.token_state as string | null) ?? null,
    context_band: extras.context_band, rate_date: extras.rate_date, calls: num(row.calls), total_tokens: num(row.total_tokens), composition,
  };
}
function pricingInputFromRow(row: PricingRowOut): PricingInputRow {
  return {
    provider: row.provider, model: row.model, reasoning_effort: row.reasoning_effort, service_tier: row.service_tier, speed: row.speed,
    context_window_tokens: row.context_window_tokens, cache_write_ttl: row.cache_write_ttl, token_state: row.token_state,
    context_band: row.context_band, rate_date: row.rate_date, calls: row.calls,
    input_fresh: row.composition.input_fresh, input_cached: row.composition.input_cached, input_cache_write: row.composition.input_cache_write,
    output: row.composition.output, reasoning: row.composition.reasoning, unclassified: row.composition.unclassified, total_tokens: row.total_tokens,
  };
}

export function createUsageQuery(getDatabase?: () => Sql) {
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();
  // Accounts, sources and coverage bounds move on the hourly ingest cycle, and `meta` is three queries,
  // one of them with four correlated subqueries. A page asks for four sections, so uncached that is twelve
  // serialised round trips through a pool of one for an answer that cannot have changed between them.
  const metaCache = readCache(30_000, async () => meta(await sql()));

  async function meta(db: Sql): Promise<Meta> {
    const accounts = await db`SELECT id, provider, label FROM personal_hub.usage_accounts ORDER BY created_at, id`;
    const sources = await db`SELECT id, account_id, machine_label, mode FROM personal_hub.telemetry_sources ORDER BY created_at, id`;
    // Coverage per account: the first hour any collector observed and the newest collector contact, which
    // says how far the collectors have scanned. Absence before `from` or after `through` is missing data;
    // absence in between is a true zero for the collectors that exist.
    const rows = await db`SELECT a.id,
        (SELECT min(hour) FROM (
          SELECT min(t.hour) AS hour FROM personal_hub.token_bucket_revisions t WHERE t.account_id = a.id
          UNION ALL
          SELECT min(u.bucket_start) FROM personal_hub.account_usage_buckets u WHERE u.account_id = a.id
        ) observed) AS observed_from,
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

  /**
   * PROJECT MAP (spec 6.1). One row per distinct project-evidence tuple of the in-range requests, resolved
   * once against the app catalog and memberships (lib/usage-project-map.ts), materialised with real
   * statistics before any request table is built. The requests then join it on plain equality, so no
   * label or membership table is ever looped per request row. `project_key_join` is the key with NULL
   * folded to '' so the join stays hashable.
   */
  async function createProjectMap(tx: { unsafe: Sql['unsafe'] }, q: UsageQuery, accounts: string[], range: ResolvedRange, fromGroups = false) {
    const p = new Params();
    await tx.unsafe(`CREATE TEMP TABLE _usage_project_map ON COMMIT DROP AS
      WITH ${projectMapCtes(fromGroups
        ? `SELECT DISTINCT r.project_install_id, r.session_hash, r.effective_project_basis, r.effective_project_key FROM _usage_request_groups r`
        : `SELECT DISTINCT r.project_install_id, r.session_hash, r.effective_project_basis, r.effective_project_key
          FROM personal_hub.canonical_requests r
          WHERE r.account_id = ANY(${p.add(accounts)}::text[])
            AND r.activity_at >= ${p.add(new Date(range.start).toISOString())}::timestamptz
            AND r.activity_at < ${p.add(new Date(range.end).toISOString())}::timestamptz
            ${q.machines.length ? `AND r.source_id = ANY(${p.add(q.machines)}::uuid[])` : ''}`)}
      SELECT project_install_id, session_hash, effective_project_basis, coalesce(effective_project_key, '') AS project_key_join,
        project_state, project_id, project_label,
        -- The filter value the card row applies, so selecting a row filters to exactly that row.
        CASE
          WHEN project_state = 'project' THEN project_id::text
          WHEN project_reason = 'projectless' THEN 'projectless'
          WHEN project_state = 'not_reported' THEN coalesce('not_reported:' || project_install_id::text, 'not_reported')
          ELSE project_state
        END AS project_filter
      FROM project_map`, p.values);
    await tx.unsafe(`ANALYZE _usage_project_map`);
  }
  const projectJoin = `LEFT JOIN _usage_project_map pm ON pm.project_install_id = r.project_install_id AND pm.session_hash = r.session_hash
        AND pm.effective_project_basis = r.effective_project_basis AND pm.project_key_join = coalesce(r.effective_project_key, '')`;

  /**
   * AGENT MAP (spec 6.3). One row per distinct agent-evidence tuple of the in-range requests (1-2k for a
   * month), aggregated FIRST and only then joined to the install and the three label kinds, so labels are
   * looked up per agent, not per request. `group_id` is the agent row the card shows and the filter
   * selects: an opaque sha256 over (provider, display role, display name, builtin), so the comma-split
   * URL list and the `agents: sha256[]` schema stay valid whatever a name contains. A request finds its row
   * through `agentMapOn`: plain equality on the evidence columns, NULL folded to a sentinel in the map's
   * `k_*` columns so the join stays a hash join. (A hashed key such as md5(jsonb_build_array(...)) per
   * request was measured at about 0.8 s for a production month, 71k rows, 2026-09-23; this costs a hash
   * probe.) Built once per transaction that needs it: nothing reads a temp table across transactions.
   */
  const cursorSession = (a: string) => `CASE WHEN ${a}.provider = 'cursor' THEN ${a}.session_hash END`;
  const agentMapOn = (m: string, a: string) => `${m}.account_id = ${a}.account_id AND ${m}.source_id = ${a}.source_id AND ${m}.provider = ${a}.provider
        AND ${m}.k_agent = coalesce(${a}.agent_key, '') AND ${m}.k_session = coalesce(${cursorSession(a)}, '')
        AND ${m}.k_class = coalesce(${a}.agent_class, '') AND ${m}.k_name = coalesce(${a}.agent_name, '')
        AND ${m}.k_depth = coalesce(${a}.agent_depth, -1) AND ${m}.k_parent = coalesce(${a}.parent_agent_key, '')
        AND ${m}.k_basis = coalesce(${a}.agent_identity_basis, '')`;
  const builtinArraysSql = (p: Params, lists: Record<string, readonly string[]>, column: string) => `CASE ${column} ${BUILTIN_PROVIDERS
    .map(provider => `WHEN '${provider}' THEN ${p.add([...(lists[provider] ?? [])])}::text[]`).join(' ')} ELSE '{}'::text[] END`;
  async function createAgentMap(tx: { unsafe: Sql['unsafe'] }, q: UsageQuery, accounts: string[], range: ResolvedRange, fromGroups = false) {
    const p = new Params();
    await tx.unsafe(`CREATE TEMP TABLE _usage_agent_map ON COMMIT DROP AS
      WITH agg AS (
        SELECT r.account_id, r.source_id, r.provider, r.agent_key, CASE WHEN r.provider = 'cursor' THEN r.session_hash END AS cursor_session,
          r.agent_class, r.agent_name, r.agent_depth, r.parent_agent_key, r.agent_identity_basis
        ${fromGroups ? 'FROM _usage_request_groups r' : `FROM personal_hub.canonical_requests r
        WHERE r.account_id = ANY(${p.add(accounts)}::text[])
          AND r.activity_at >= ${p.add(new Date(range.start).toISOString())}::timestamptz
          AND r.activity_at < ${p.add(new Date(range.end).toISOString())}::timestamptz
          ${q.machines.length ? `AND r.source_id = ANY(${p.add(q.machines)}::uuid[])` : ''}`}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
      ), labelled AS (
        SELECT a.*, b.install_id,
          coalesce(a.agent_key, '') AS k_agent, coalesce(a.cursor_session, '') AS k_session, coalesce(a.agent_class, '') AS k_class,
          coalesce(a.agent_name, '') AS k_name, coalesce(a.agent_depth, -1) AS k_depth, coalesce(a.parent_agent_key, '') AS k_parent,
          coalesce(a.agent_identity_basis, '') AS k_basis,
          la.label AS agent_label, la.role AS agent_label_role, ln.label AS name_label, sa.label AS session_label, sa.role AS session_label_role
        FROM agg a
        LEFT JOIN personal_hub.companion_bindings b ON b.source_id = a.source_id
        LEFT JOIN personal_hub.usage_name_labels la ON la.install_id = b.install_id AND la.kind = 'agent' AND la.key = a.agent_key
        LEFT JOIN personal_hub.usage_name_labels ln ON ln.install_id = b.install_id AND ln.kind = 'agent_name' AND ln.key = a.agent_name AND a.agent_name LIKE 'h:%'
        LEFT JOIN personal_hub.usage_name_labels sa ON sa.install_id = b.install_id AND sa.kind = 'session_agent' AND sa.key = a.cursor_session
      ), shaped AS (
        SELECT l.*,
          coalesce(l.agent_label_role, l.session_label_role, ${AGENT_ROLE_SQL('l')}) AS display_role,
          coalesce(l.agent_label, l.name_label, l.session_label, l.agent_name,
            CASE WHEN l.agent_class = 'main' THEN 'main' WHEN l.provider = 'codex' AND l.agent_class = 'builtin' THEN 'default' ELSE 'unattributed' END) AS display_name
        FROM labelled l
      ), classed AS (
        SELECT s.*, (coalesce(s.agent_class = 'builtin', false) OR s.display_name = ANY(${builtinArraysSql(p, KNOWN_BUILTIN_AGENTS, 's.provider')})) AS builtin
        FROM shaped s
      )
      SELECT c.*, encode(sha256(convert_to(jsonb_build_array(c.provider, c.display_role, c.display_name, c.builtin)::text, 'UTF8')), 'hex') AS group_id
      FROM classed c`, p.values);
    await tx.unsafe(`ANALYZE _usage_agent_map`);
  }
  const agentJoin = `LEFT JOIN _usage_agent_map am ON ${agentMapOn('am', 'r')}`;
  /** The requests a set of agent groups covers, as (account_id, agent_key) pairs, for filters on tables that carry only a key. */
  const agentKeysIn = (p: Params, groups: string[]) =>
    `(SELECT account_id, agent_key FROM _usage_agent_map WHERE agent_key IS NOT NULL AND group_id = ANY(${p.add(groups)}::text[]))`;

  /**
   * Columns a caller lookup needs: what the tool and knowledge cards display about a calling request, plus
   * every column a detail filter can test. Far narrower than the full ledger row, which matters because the
   * ranking pass sorts these rows: the requests section's own pass carries 758-byte rows, and a caller
   * lookup that only reports a model and an agent has no reason to drag the token columns through the sort.
   */
  const CALLER_COLUMNS = `r.account_id, r.semantic_key, r.activity_at, r.model_actual, r.agent_key, r.agent_class,
        r.agent_name, r.agent_depth, r.parent_agent_key, r.reasoning_effort, r.surface, r.provider, r.session_hash, r.agent_identity_basis`;

  /**
   * REQUEST GROUPS. The requests section never needs a single request, only sums and distinct counts over
   * them, so it reads the range ONCE into groups keyed by every column a card groups by, filters on, or
   * counts distinctly: session, agent evidence, project evidence, model, effort, surface, the pricing
   * dimensions and the per-request long-context flags, plus a 15-minute activity slot. Every period the
   * cards show (UTC hours, and days in any zone, whose offsets are all multiples of 15 minutes) is a union
   * of slots, and a sum of group sums equals the sum over the requests (NULL-ignoring either way).
   *
   * Measured on production 2026-09-23: September's 79,947 requests are 2,724 groups at hourly grain. The
   * section used to scan the month three times (project map, agent map, request table) and aggregate the
   * 758-byte-wide request table six more; on this throttled instance a single cached 79k-row scan costs
   * 3.3 s and the wide table overflowed temp_buffers (8.0 s for one GROUP BY). Now one scan, then small.
   */
  /**
   * Runs one grouping statement with a larger `work_mem`, then restores the default for the rest of the
   * transaction. Both passes below read ~75-80k wide rows for a month and keep only a few thousand groups;
   * at this instance's 2 MB they sorted (or hash-joined) through temp files, 24-52 MB of throttled disk
   * each. With 32 MB they hash in memory (11 MB and 4 MB used): request groups 0.7-2.5 s -> 0.20-0.33 s,
   * tool rows 0.5-3.5 s -> 0.27-0.31 s, measured on production 2026-09-23. Scoped to these two statements
   * because a raised `work_mem` on the old ledger ranking pass flipped it to a slower parallel plan.
   */
  async function withGroupingMemory<T>(tx: { unsafe: Sql['unsafe'] }, run: () => Promise<T>): Promise<T> {
    await tx.unsafe(`SET LOCAL work_mem = '32MB'`);
    const result = await run();
    await tx.unsafe(`SET LOCAL work_mem TO DEFAULT`);
    return result;
  }

  async function createRequestGroups(tx: { unsafe: Sql['unsafe'] }, q: UsageQuery, accounts: string[], range: ResolvedRange) {
    const p = new Params();
    const thresholds = catalogThresholds();
    const loggedInput = 'coalesce(r.input_fresh_tokens, 0) + coalesce(r.input_cached_tokens, 0) + coalesce(r.input_cache_write_tokens, 0)';
    const named = q.models.filter(m => m !== UNKNOWN);
    const model = [
      ...(named.length ? [`r.model_actual = ANY(${p.add(named)}::text[])`] : []),
      ...(q.models.includes(UNKNOWN) ? [`(r.model_actual IS NULL OR r.model_actual = 'unknown')`] : []),
    ];
    await withGroupingMemory(tx, () => tx.unsafe(`CREATE TEMP TABLE _usage_request_groups ON COMMIT DROP AS
      SELECT r.account_id, r.source_id, r.provider, r.session_hash, r.model_actual,
        date_bin('15 minutes', r.activity_at, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS activity_slot,
        r.surface, r.reasoning_effort, r.service_tier, r.speed, r.context_window_tokens, r.cache_write_ttl, r.token_state,
        r.agent_key, r.agent_class, r.agent_name, r.agent_depth, r.parent_agent_key, r.agent_identity_basis,
        r.project_install_id, r.effective_project_basis, r.effective_project_key,
        (${loggedInput} > ${p.add(thresholds.openai)}::bigint) AS over_openai, (${loggedInput} > ${p.add(thresholds.anthropic)}::bigint) AS over_anthropic,
        (${loggedInput} > ${p.add(thresholds.xai)}::bigint) AS over_xai,
        sum(r.input_fresh_tokens) AS input_fresh_tokens, sum(r.input_cached_tokens) AS input_cached_tokens,
        sum(r.input_cache_write_tokens) AS input_cache_write_tokens, sum(r.output_tokens) AS output_tokens,
        sum(r.reasoning_tokens) AS reasoning_tokens, sum(r.unclassified_tokens) AS unclassified_tokens,
        sum(r.observed_total_tokens) AS observed_total_tokens, count(*)::int AS calls, max(r.observed_at) AS observed_at
      FROM personal_hub.canonical_requests r
      WHERE r.account_id = ANY(${p.add(accounts)}::text[])
        AND r.activity_at >= ${p.add(new Date(range.start).toISOString())}::timestamptz
        AND r.activity_at < ${p.add(new Date(range.end).toISOString())}::timestamptz
        ${model.length ? `AND (${model.join(' OR ')})` : ''}
        ${q.machines.length ? `AND r.source_id = ANY(${p.add(q.machines)}::uuid[])` : ''}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25`, p.values));
    await tx.unsafe(`ANALYZE _usage_request_groups`);
  }

  /**
   * Canonical requests for a key set, or the request groups. With `columns`, reads personal_hub.canonical_requests
   * and discovers in-range keys when `keysCte` is omitted (knowledge passes its callers); without, reads
   * `_usage_request_groups`, which `createRequestGroups` built in the same transaction. `project` joins
   * `_usage_project_map` and `agents` joins `_usage_agent_map`, which the caller must have created in the
   * same transaction (`createProjectMap`, `createAgentMap`); the agent join is needed only for the
   * agent-group and agent-scope filters.
   */
  function requestCte(p: Params, q: UsageQuery, accounts: string[], range: ResolvedRange, keysCte?: string,
    opts: { columns?: string; project?: boolean } = {}) {
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
    const withAgents = q.agents.length > 0 || q.agent_scope !== 'all';
    if (q.efforts.length) detail.push(codeFilter('r.reasoning_effort', q.efforts)!);
    if (q.surfaces.length) detail.push(`r.surface = ANY(${p.add(q.surfaces)}::text[])`);
    // Agent scope and agent groups use the displayed role and group, so the card and its filters describe one partition.
    if (q.agent_scope === 'main') detail.push(`r.agent_display_role = 'main'`);
    if (q.agent_scope === 'subagent') detail.push(`r.agent_display_role = 'subagent'`);
    if (q.agents.length) detail.push(`r.agent_group_id = ANY(${p.add(q.agents)}::text[])`);
    if (q.projects.length) {
      const ids = q.projects.filter(v => !isProjectCode(v));
      const codes = q.projects.filter(v => isProjectCode(v) && v !== 'not_reported');
      const parts: string[] = [];
      if (ids.length) parts.push(`r.project_id = ANY(${p.add(ids)}::uuid[])`);
      if (codes.length) parts.push(`r.project_filter = ANY(${p.add(codes)}::text[])`);
      if (q.projects.includes('not_reported')) parts.push(`r.project_state = 'not_reported'`);
      detail.push(`(${parts.join(' OR ')})`);
    }
    // Canonical requests come from personal_hub.canonical_requests, which already holds one row per
    // (account_id, semantic_key), chosen at write time in the order lib/usage-canonical.ts defines. What is
    // left is a range scan on canonical_requests_activity (account_id, activity_at DESC), where BOTH range
    // bounds are index boundary conditions, so the scan size is the SELECTED RANGE.
    //
    // Project resolution deliberately STAYS at read time: the projection carries only the evidence of the
    // project-preferred revision, never a resolved id or label, because an app's catalog or a membership
    // must still relabel past requests. It is resolved once per distinct evidence tuple in
    // `_usage_project_map`, never per row.
    const withProject = opts.project ?? true;
    // The grouped source already carries the range, model and machine filters (`createRequestGroups`).
    const groups = opts.columns === undefined;
    // The model filter is built only where it is used: an unreferenced bound value has no type (42P18).
    const model = groups ? null : modelFilter('r.model_actual');
    const where = groups ? [] : [
      `r.account_id = ANY(${p.add(accounts)}::text[])`,
      `r.activity_at >= ${p.add(new Date(range.start).toISOString())}::timestamptz`,
      `r.activity_at < ${p.add(new Date(range.end).toISOString())}::timestamptz`,
      ...(model ? [model] : []),
      // source_id is denormalised onto the projection, so the machine filter no longer joins bindings.
      ...(q.machines.length ? [`r.source_id = ANY(${p.add(q.machines)}::uuid[])`] : []),
    ];
    const text = `resolved AS (
      SELECT ${groups ? 'r.*' : `${opts.columns}, r.source_id`},
        ${withProject ? `coalesce(pm.project_state, 'unknown') AS project_state, pm.project_id, pm.project_label, coalesce(pm.project_filter, 'unknown') AS project_filter`
          : `NULL::text AS project_state, NULL::uuid AS project_id, NULL::text AS project_label, NULL::text AS project_filter`},
        ${withAgents ? 'am.group_id AS agent_group_id, am.display_role AS agent_display_role' : 'NULL::text AS agent_group_id, NULL::text AS agent_display_role'}
      FROM ${groups ? '_usage_request_groups' : 'personal_hub.canonical_requests'} r
      ${keysCte ? `JOIN ${keysCte} k ON k.account_id = r.account_id AND k.semantic_key = r.semantic_key` : ''}
      ${withProject ? projectJoin : ''}
      ${withAgents ? agentJoin : ''}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ), requests AS (
      SELECT r.*, ${detail.length ? `(${detail.join(' AND ')})` : 'true'} AS matches FROM resolved r
    )`;
    return { text, detailFilters: detail.length > 0, withAgents, withProject };
  }

  // A parameter is added only when the expression references it: an unreferenced bound value has no type.
  const periodExpr = (column: string, resolution: Resolution, p: Params, tz: string) =>
    resolution === 'day' ? (() => { const z = `${p.add(tz)}::text`; return `date_trunc('day', ${column} AT TIME ZONE ${z}) AT TIME ZONE ${z}`; })() : `date_trunc('hour', ${column})`;
  // Over request groups: calls is the sum of each group's request count.
  const compositionSelect = (alias = 'r') => `sum(${alias}.input_fresh_tokens)::float8 AS input_fresh, sum(${alias}.input_cached_tokens)::float8 AS input_cached,
      sum(${alias}.input_cache_write_tokens)::float8 AS input_cache_write, sum(${alias}.output_tokens)::float8 AS output,
      sum(${alias}.reasoning_tokens)::float8 AS reasoning, sum(${alias}.unclassified_tokens)::float8 AS unclassified,
      sum(${alias}.observed_total_tokens)::float8 AS total_tokens, sum(${alias}.calls)::int AS calls, count(DISTINCT ${alias}.session_hash)::int AS conversations`;

  async function usageQuery(input: UsageQuery, { now = Date.now() }: { now?: number } = {}): Promise<UsageQueryResult> {
    const q = usageQuerySchema.parse(input);
    const range = resolveRange({ preset: q.preset, start: q.start, end: q.end, timezone: q.timezone, now });
    const periods = periodsWithin(range, q.resolution, q.timezone);
    const db = await sql();
    const m = await metaCache.get();
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
    const useRequests = detailFilters.length > 0;
    const allSections = q.section === undefined;
    const wantOverview = allSections || q.section === 'overview';
    const wantRequests = allSections || q.section === 'requests';
    const wantTools = allSections || q.section === 'tools';
    const wantKnowledge = allSections || q.section === 'knowledge';
    // Overview is the hourly ledgers and snapshots. Requests own activity_requests group-bys.
    // Tools own tool_events; knowledge owns resource accesses. Detail filters make requests the
    // headline, so overview then also ranks activity_requests — still skipping tool tables.
    const needBuckets = wantOverview || wantRequests;
    const needRequestTable = wantRequests || (wantOverview && useRequests);
    const needRequestPeriods = (wantOverview && useRequests) || wantRequests;
    const needRequestGroups = wantRequests;
    const needRequestPricing = wantOverview && useRequests;
    const needAgentEvidence = wantRequests || (wantOverview && useRequests);
    // One section is one transaction under one budget: the whole transaction on Postgres 17
    // (`transaction_timeout`), each statement as the backstop, both the shared number the queue
    // and the browser derive their deadlines from. Postgres cancels with SQLSTATE 57014, which the
    // route reports as 504 with its message, before the queue would destroy the connection.
    const prepareRead = async (tx: { unsafe: Sql['unsafe'] }) => {
      // `work_mem` is deliberately left alone for the transaction. Raising it to 16MB was measured on this
      // instance and made the old requests read 2.6x SLOWER: the extra budget flipped its ranking pass to a
      // parallel sequential scan and a hash join whose sort then spilled anyway. Fewer buffers is not the
      // goal; finishing sooner on a shared vCPU is. The two grouping passes raise it for themselves alone
      // (`withGroupingMemory`), where it was measured to remove their temp-file spill.
      await tx.unsafe(`SELECT set_config('statement_timeout', $1, true), set_config('jit', 'off', true),
        CASE WHEN current_setting('server_version_num')::int >= 170000 THEN set_config('transaction_timeout', $1, true) END`, [DATABASE_JOB_BUDGET_INTERVAL]);
    };

    // 1. Canonical buckets by period and model. A bucket counts only when it lies wholly inside the range,
    //    the current hour being the one exception while the range is anchored to now. The two ledgers are
    //    ranked once, in one transaction, into a temp table spanning the widest range any overview card
    //    needs (the whole months the range touches, for the environmental cohort population) plus the
    //    buckets straddling its edges; every card then filters that table to its own range, models, and
    //    machines. The model filter commutes with the ranking: model is part of both canonical keys
    //    (provider buckets hash it into dimensions_hash).
    const namedModels = q.models.filter(v => v !== UNKNOWN);
    const startIso = new Date(range.start).toISOString();
    const endIso = new Date(bucketEnd).toISOString();
    const months = monthsWithin(range, tz);
    const monthSpan = months.length ? { start: monthBounds(months[0], tz).start, end: monthBounds(months.at(-1)!, tz).end } : { start: range.start, end: bucketEnd };
    const monthStartIso = new Date(monthSpan.start).toISOString(), monthEndIso = new Date(monthSpan.end).toISOString();
    const wideStartIso = new Date(Math.min(range.start, monthSpan.start)).toISOString();
    const wideEndIso = new Date(Math.max(bucketEnd, monthSpan.end)).toISOString();
    const emptyOverview = { bucketRows: [] as Row[], straddle: 0, bucketSessions: 0, bucketPricingRows: [] as Row[], monthRows: [] as Row[] };
    const overview = accounts.length && needBuckets ? await db.begin(async tx => {
      await prepareRead(tx);
      const tp = new Params();
      await tx.unsafe(`CREATE TEMP TABLE _usage_buckets ON COMMIT DROP AS WITH ${canonicalBucketCte(tp, accounts, wideStartIso, wideEndIso)} SELECT * FROM canonical`, tp.values);
      await tx.unsafe(`CREATE INDEX _usage_buckets_span ON _usage_buckets (hour, bucket_end)`);
      // A card's scope: buckets wholly inside its range, then the selected models and machines.
      const within = (p: Params, start: string, end: string) => `hour >= ${p.add(start)}::timestamptz AND bucket_end <= ${p.add(end)}::timestamptz`;
      const machines = (p: Params) => q.machines.length ? `AND source_id = ANY(${p.add(q.machines)}::uuid[])` : '';
      const scoped = (p: Params) => `${within(p, startIso, endIso)} ${modelFilterSql(p, q, namedModels, 'model')} ${machines(p)}`;
      const bp = new Params();
      const bucketRows: Row[] = await tx.unsafe(`
        SELECT account_id, model, ${periodExpr('hour', q.resolution, bp, tz)} AS period_start, ${periodExpr('hour', 'day', bp, tz)} AS day_start,
          sum(calls)::float8 AS calls, sum(input_tokens)::float8 AS input_fresh, sum(cached_tokens)::float8 AS input_cached,
          sum(cache_write_tokens)::float8 AS input_cache_write, sum(output_tokens)::float8 AS output, sum(unclassified)::float8 AS unclassified,
          sum(total_tokens)::float8 AS total_tokens, max(hour) AS last_hour, max(observed_at) AS last_observed,
          count(*) FILTER (WHERE bucket_end > ${bp.add(new Date(now).toISOString())}::timestamptz)::int AS partial_buckets,
          bool_or(origin = 'provider') AS has_provider
        FROM _usage_buckets WHERE ${scoped(bp)}
        GROUP BY 1, 2, 3, 4 ORDER BY 3, 1, 2`, bp.values);
      if (!wantOverview) return { ...emptyOverview, bucketRows };
      // Buckets straddling a range edge are excluded rather than prorated; say how many. The table holds one
      // row per canonical key, so a plain count is the distinct-key count.
      const sp = new Params();
      const edgeStart = sp.add(startIso), edgeEnd = sp.add(endIso);
      const [straddle] = await tx.unsafe(`SELECT count(*)::int AS buckets FROM _usage_buckets
        WHERE ((hour < ${edgeStart}::timestamptz AND bucket_end > ${edgeStart}::timestamptz) OR (hour < ${edgeEnd}::timestamptz AND bucket_end > ${edgeEnd}::timestamptz))
          ${modelFilterSql(sp, q, namedModels, 'model')}`, sp.values);
      // Conversations under the bucket basis are the distinct sessions among the local canonical buckets in scope;
      // provider buckets carry no session.
      const cp0 = new Params();
      const [bucketSessions] = !useRequests ? await tx.unsafe(`SELECT count(DISTINCT session_hash)::int AS conversations
        FROM _usage_buckets WHERE origin = 'local' AND ${scoped(cp0)}`, cp0.values) : [{ conversations: 0 }];
      // Hourly buckets already have model, Chicago date, and exclusive composition. Missing tier is assumed
      // Standard; the hour is not a single request, so the short context band is used rather than a summed input.
      const bpp = new Params();
      const bucketPricingRows: Row[] = !useRequests ? await tx.unsafe(`
        SELECT account_id, model, to_char(hour AT TIME ZONE ${bpp.add(DISPLAY_TIMEZONE)}::text, 'YYYY-MM-DD') AS rate_date,
          sum(calls)::float8 AS calls, sum(input_tokens)::float8 AS input_fresh, sum(cached_tokens)::float8 AS input_cached,
          sum(cache_write_tokens)::float8 AS input_cache_write, sum(output_tokens)::float8 AS output, sum(unclassified)::float8 AS unclassified,
          sum(total_tokens)::float8 AS total_tokens
        FROM _usage_buckets WHERE ${scoped(bpp)}
        GROUP BY 1, 2, 3 ORDER BY total_tokens DESC NULLS LAST`, bpp.values) : [];
      // The whole-month cohort population per account: what the environmental class is inferred from, unfiltered
      // by model or machine, and which (account, source month) pairs the hourly ledger covers at all.
      const mp = new Params();
      const mtz = `${mp.add(tz)}::text`;
      const monthRows: Row[] = months.length ? await tx.unsafe(`
        SELECT account_id, to_char(hour AT TIME ZONE ${mtz}, 'YYYY-MM') AS month, sum(calls)::float8 AS calls, sum(total_tokens)::float8 AS raw_tokens
        FROM _usage_buckets WHERE ${within(mp, monthStartIso, monthEndIso)} GROUP BY 1, 2`, mp.values) : [];
      return { bucketRows, straddle: num(straddle.buckets), bucketSessions: num(bucketSessions.conversations), bucketPricingRows, monthRows };
    }) : emptyOverview;
    const { bucketRows, bucketPricingRows, monthRows } = overview;
    const bucketConversations = overview.bucketSessions;
    if (overview.straddle > 0) notes.push(`${overview.straddle} hourly bucket(s) straddling a range edge are excluded rather than prorated.`);
    if (bucketRows.some(row => row.has_provider)) {
      notes.push('Provider-reported account usage is included for Cursor and organization API accounts and is not added to local Claude or Codex hourly buckets.');
    }

    // 2–5. Group the in-range requests once, then cheap group-bys. Tools and knowledge are their own
    // transactions so they never rebuild the request groups and can finish independently.
    const rangeStartIso = new Date(range.start).toISOString();
    const rangeEndIso = new Date(range.end).toISOString();
    // The same day-wide revision window the request reads use, for the same measured reason: a tool
    // invocation's revisions all carry one `observed_at`, so the week this used to span found nothing.
    const widenStartIso = new Date(range.start - REVISION_WINDOW_MS).toISOString();
    const widenEndIso = new Date(range.end + REVISION_WINDOW_MS).toISOString();
    // Tool invocations and knowledge accesses share one filter contract: machine from the row's own binding,
    // agent from the invocation's caller, detail filters through the calling request. A model filter alone has
    // no request to apply through, so both sections report it rather than guessing.
    const toolUnsupported: string[] = [];
    if (q.models.length) toolUnsupported.push('models');
    if (useRequests) toolUnsupported.push('detail filters apply through the calling request; invocations without a retained caller request are excluded');
    const knowledgeUnsupported = [...toolUnsupported];
    // Lifecycle events carry no model, effort, surface, or project and no request to reach one through.
    const eventUnsupported = [q.models.length && 'models', q.efforts.length && 'efforts', q.surfaces.length && 'surfaces', q.projects.length && 'projects', q.agent_scope !== 'all' && 'agent_scope']
      .filter((v): v is string => typeof v === 'string');

    const emptyDetail = {
      requestPeriodRows: [] as Row[], projectRows: [] as Row[], agentRows: [] as Row[], requestPricingRows: [] as Row[],
      effortRows: [] as Row[], knowledgeRows: [] as Row[],
      knowledgeTotal: { distinct_invocations: 0 } as Row,
      agentEvidence: { spawns: 0, observed_children: 0, conversations: 0 } as Row,
    };
    const requestDetail = accounts.length && needRequestTable ? await db.begin(async tx => {
      await prepareRead(tx);
      // The range is read once, into request groups; the maps are built from the groups and joined on plain
      // equality, so resolution runs per distinct project or agent tuple, never per request row. The joined
      // table has no index: every read below is a whole-table aggregate, and an index only tempted the
      // planner into an index-order scan that thrashed temp_buffers (8.0 s for a month, 2026-09-23).
      const needProject = needRequestGroups || q.projects.length > 0;
      const needAgents = needRequestGroups || q.agents.length > 0 || q.agent_scope !== 'all';
      await createRequestGroups(tx, q, accounts, range);
      if (needProject) await createProjectMap(tx, q, accounts, range, true);
      if (needAgents) await createAgentMap(tx, q, accounts, range, true);
      const rp = new Params();
      const cte = requestCte(rp, q, accounts, range, undefined, { project: needProject });
      await tx.unsafe(`CREATE TEMP TABLE _usage_requests ON COMMIT DROP AS WITH ${cte.text} SELECT * FROM requests`, rp.values);
      await tx.unsafe(`ANALYZE _usage_requests`);

      const periodP = new Params();
      const requestPeriodRows = needRequestPeriods ? await tx.unsafe(`
        SELECT r.matches, r.account_id, r.model_actual AS model, ${periodExpr('r.activity_slot', q.resolution, periodP, tz)} AS period_start, ${compositionSelect()},
          max(r.observed_at) AS last_observed
        FROM _usage_requests r GROUP BY 1, 2, 3, 4 ORDER BY 4, 3`, periodP.values) : [];

      const projectRows = needRequestGroups ? await tx.unsafe(`
        SELECT coalesce(r.project_state, 'unknown') AS state, r.project_id, r.project_label, coalesce(r.project_filter, r.project_state, 'unknown') AS filter_value, ${compositionSelect()}
        FROM _usage_requests r WHERE r.matches GROUP BY 1, 2, 3, 4 ORDER BY total_tokens DESC NULLS LAST`) : [];

      // One row per displayed agent group. Aggregate first, per agent evidence tuple and session, then join
      // the 1-2k map rows and fold into provider, role, name and builtin. Instances are distinct agent keys.
      const agentRows = needRequestGroups ? await tx.unsafe(`WITH per_agent AS (
          SELECT r.account_id, r.source_id, r.provider, r.agent_key, r.session_hash, r.agent_class, r.agent_name, r.agent_depth,
            r.parent_agent_key, r.agent_identity_basis,
            sum(r.input_fresh_tokens) AS input_fresh_tokens, sum(r.input_cached_tokens) AS input_cached_tokens,
            sum(r.input_cache_write_tokens) AS input_cache_write_tokens, sum(r.output_tokens) AS output_tokens,
            sum(r.reasoning_tokens) AS reasoning_tokens, sum(r.unclassified_tokens) AS unclassified_tokens,
            sum(r.observed_total_tokens) AS observed_total_tokens, sum(r.calls) AS calls
          FROM _usage_requests r WHERE r.matches GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
        SELECT coalesce(m.group_id, '') AS group_id, coalesce(m.provider, r.provider) AS provider,
          coalesce(m.display_role, 'unattributed') AS role, coalesce(m.display_name, 'unattributed') AS name, coalesce(m.builtin, false) AS builtin,
          count(DISTINCT r.agent_key)::int AS instances, count(DISTINCT r.session_hash)::int AS sessions,
          sum(r.input_fresh_tokens)::float8 AS input_fresh, sum(r.input_cached_tokens)::float8 AS input_cached,
          sum(r.input_cache_write_tokens)::float8 AS input_cache_write, sum(r.output_tokens)::float8 AS output,
          sum(r.reasoning_tokens)::float8 AS reasoning, sum(r.unclassified_tokens)::float8 AS unclassified,
          sum(r.observed_total_tokens)::float8 AS total_tokens, sum(r.calls)::int AS calls
        FROM per_agent r LEFT JOIN _usage_agent_map m ON ${agentMapOn('m', 'r')}
        GROUP BY 1, 2, 3, 4, 5 ORDER BY total_tokens DESC NULLS LAST`) : [];

      const cp = new Params();
      const requestPricingRows = needRequestPricing ? await tx.unsafe(`
        SELECT r.provider, r.model_actual AS model, r.reasoning_effort, r.service_tier, r.speed, r.context_window_tokens, r.cache_write_ttl, r.token_state,
          r.over_openai, r.over_anthropic, r.over_xai,
          to_char(r.activity_slot AT TIME ZONE ${cp.add(DISPLAY_TIMEZONE)}::text, 'YYYY-MM-DD') AS rate_date, ${compositionSelect()}
        FROM _usage_requests r WHERE r.matches GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 ORDER BY total_tokens DESC NULLS LAST`, cp.values) : [];

      const effortP = new Params();
      const effortRows = needRequestGroups ? await tx.unsafe(`
        SELECT coalesce(r.model_actual, '${UNKNOWN}') AS model, coalesce(r.reasoning_effort, '${UNKNOWN}') AS effort, ${periodExpr('r.activity_slot', q.resolution, effortP, tz)} AS period_start,
          sum(r.observed_total_tokens)::float8 AS total_tokens, sum(r.calls)::int AS calls
        FROM _usage_requests r WHERE r.matches GROUP BY 1, 2, 3 ORDER BY 3`, effortP.values) : [];

      // Lifecycle events follow the machine filter through their binding and the agent filter through the
      // event's own agent key; the other filters have no request to apply through (see the agents note).
      const gp = new Params();
      const [agentEvidence] = needAgentEvidence ? await tx.unsafe(`WITH events AS (
          SELECT DISTINCT ON (e.account_id, e.semantic_key) e.event_kind, e.agent_key, e.outcome
          FROM personal_hub.agent_events e
          JOIN personal_hub.companion_bindings b ON b.id = e.binding_id
          WHERE e.account_id = ANY(${gp.add(accounts)}::text[])
            AND e.observed_at >= ${gp.add(rangeStartIso)}::timestamptz AND e.observed_at < ${gp.add(rangeEndIso)}::timestamptz
            ${q.machines.length ? `AND b.source_id = ANY(${gp.add(q.machines)}::uuid[])` : ''}
            ${q.agents.length ? `AND (e.account_id, e.agent_key) IN ${agentKeysIn(gp, q.agents)}` : ''}
          ORDER BY e.account_id, e.semantic_key, e.observed_at DESC, e.received_at DESC, e.id DESC)
        SELECT (SELECT count(*)::int FROM events WHERE event_kind = 'spawn') AS spawns,
          (SELECT count(DISTINCT r.session_hash)::int FROM _usage_requests r WHERE r.matches) AS conversations,
          (SELECT count(DISTINCT agent_key)::int FROM (
            SELECT agent_key FROM events WHERE event_kind IN ('start', 'resume', 'finish') AND agent_key IS NOT NULL
            UNION SELECT r.agent_key FROM _usage_requests r WHERE r.matches AND r.agent_key IS NOT NULL AND (r.agent_depth > 0 OR r.parent_agent_key IS NOT NULL)) children) AS observed_children`, gp.values) : [emptyDetail.agentEvidence];

      return {
        requestPeriodRows, projectRows, agentRows, requestPricingRows, effortRows,
        agentEvidence: agentEvidence ?? { spawns: 0, observed_children: 0, conversations: 0 },
      };
    }) : emptyDetail;

    // Tools read two write-time projections and join them. The invocation set is a range scan on
    // canonical_tool_invocations (account_id, inv_observed_at DESC), which already carries each
    // invocation's canonical revision AND its latest result, so there is no DISTINCT ON over tool_events
    // and no per-invocation lookup for the result. That lookup alone was 64,745 index descents for a
    // month and 34-46 s of the card's 56-72 s, measured on production 2026-09-22. The caller requests are
    // a range scan on canonical_requests, materialised with real statistics before the invocation pass
    // joins them: as one chained statement over the ledgers the planner once estimated the invocation set at
    // a single row and nested-looped it against the requests, which ran past 127 s. The invocation pass
    // itself is a plain range scan on a real table, so its estimate is the table's own statistics.
    //
    // What this changes, measured and accepted. The old read ranked both kinds only within
    // REVISION_WINDOW_MS of the range; the projection ranks each invocation's whole history. So an
    // invocation whose newer revision was observed more than a day outside the range now counts where that
    // newer revision falls, and a result observed more than a day from the range still supplies its
    // invocation's outcome. Production has zero observed_at spread across all 85,949 invocation keys, so
    // neither case exists today. The knowledge card still ranks invocations within the window, so for
    // such an invocation the two cards could disagree; moving it onto this projection too would close that.
    const emptyTools = { byTool: [] as Row[], byCaller: [] as Row[] };
    const toolDetail = accounts.length && wantTools ? await db.begin(async tx => {
      await prepareRead(tx);
      // The agent map names every caller (by_caller) and serves the agent filter, so tools always build it;
      // the project map only when a project filter reaches invocations through their calling request.
      await createAgentMap(tx, q, accounts, range);
      if (q.projects.length) await createProjectMap(tx, q, accounts, range);
      // Callers are discovered the same way the requests section discovers its keys, by activity in range,
      // not by reading the invocation table for caller keys. Both produce the same set, because a caller
      // outside the range is filtered out either way. Without a detail filter a caller supplies only the
      // agent group of a Cursor request (Cursor invocations carry no agent key), so only Cursor accounts are
      // read: a request's provider is its account's (ingest refuses any other binding). Reading every caller
      // for that cost a month-wide scan and a 75k x 77k join that spilled temp_buffers: 10.6-22 s (2026-09-23).
      const callerAccounts = useRequests ? accounts : selected.filter(a => a.provider === 'cursor').map(a => a.id);
      const tp = new Params();
      const callers = requestCte(tp, q, callerAccounts, range, undefined, { columns: CALLER_COLUMNS, project: q.projects.length > 0 });
      await tx.unsafe(`CREATE TEMP TABLE _usage_tool_callers ON COMMIT DROP AS
        WITH ${callers.text}
        SELECT r.account_id, r.semantic_key, cm.group_id AS caller_group_id, r.matches FROM requests r
        LEFT JOIN _usage_agent_map cm ON r.provider = 'cursor' AND ${agentMapOn('cm', 'r')}`, tp.values);
      await tx.unsafe(`ANALYZE _usage_tool_callers`);

      // One pass over the invocation range, aggregated as it is read: no per-invocation temp table.
      // Materialising the ~75,000 invocations of a month, indexing them, and joining them back cost 6-30 s
      // on production (2026-09-23); a few thousand groups do not. Both consumers below only count, so the
      // groups are the union of their keys and carry the count in n.
      //
      // NESTED CALLS (spec 6.4). A row is a child only when its parent is a Codex `exec`: a nested MCP call
      // the companion (2.2.0) recorded under the exec that ran it. Every other parent link, such as a
      // Claude parent_tool_use_id, stays a top-level row. A parent is fetched by primary key, whether or not
      // it falls in the range, so a child whose exec is outside the range (or never arrived) still counts,
      // under a synthetic "exec (outside range)" row, and never vanishes. `in_scope` is the same predicate
      // that selects the in-range set, applied to the parent row.
      const ip = new Params();
      const inScope = (a: string) => `${a}.account_id = ANY(${ip.add(accounts)}::text[])
          AND ${a}.inv_observed_at >= ${ip.add(rangeStartIso)}::timestamptz AND ${a}.inv_observed_at < ${ip.add(rangeEndIso)}::timestamptz
          ${q.machines.length ? `AND ${a}.source_id = ANY(${ip.add(q.machines)}::uuid[])` : ''}
          ${q.agents.length ? `AND (${a}.account_id, ${a}.caller_agent_key) IN ${agentKeysIn(ip, q.agents)}` : ''}`;
      await withGroupingMemory(tx, () => tx.unsafe(`CREATE TEMP TABLE _usage_tool_rows ON COMMIT DROP AS
        WITH joined AS (
          SELECT i.account_id, i.source_id, i.tool_name, i.tool_namespace, i.tool_class, coalesce(i.res_outcome, i.outcome) AS final_outcome,
            i.caller_agent_key, i.caller_request_key, i.parent_invocation_key,
            b.install_id, b.provider, r.caller_group_id, r.matches,
            np.tool_name AS parent_tool, np.provider AS parent_provider, np.in_scope AS parent_in_scope
          FROM personal_hub.canonical_tool_invocations i
          LEFT JOIN personal_hub.companion_bindings b ON b.source_id = i.source_id
          LEFT JOIN _usage_tool_callers r ON r.account_id = i.account_id AND r.semantic_key = i.caller_request_key
          LEFT JOIN LATERAL (
            SELECT c.tool_name, pb.provider, (${inScope('c')}) AS in_scope
            FROM personal_hub.canonical_tool_invocations c
            JOIN personal_hub.companion_bindings pb ON pb.source_id = c.source_id
            WHERE i.parent_invocation_key IS NOT NULL
              AND c.account_id = i.account_id AND c.invocation_key = i.parent_invocation_key AND c.inv_revision_id IS NOT NULL
          ) np ON true
          WHERE ${inScope('i')})
        SELECT j.account_id, j.source_id, j.install_id, j.provider, j.tool_name, j.tool_namespace, j.tool_class, j.final_outcome AS outcome,
          j.caller_agent_key, j.caller_group_id, (j.caller_request_key IS NOT NULL) AS has_caller_request,
          CASE
            WHEN j.parent_invocation_key IS NULL THEN 'top'
            WHEN j.parent_tool = 'exec' AND j.parent_provider = 'codex' THEN CASE WHEN j.parent_in_scope THEN 'child' ELSE 'orphan' END
            WHEN j.parent_tool IS NULL AND j.provider = 'codex' AND j.tool_class = 'mcp' THEN 'orphan'
            ELSE 'top'
          END AS nesting,
          count(*)::int AS n
        FROM joined j ${useRequests ? 'WHERE j.matches' : ''}
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12`, ip.values));

      // Aggregate first, then name: labels are joined per (install, tool, namespace), not per invocation.
      const byTool = await tx.unsafe(`WITH agg AS (
          SELECT install_id, provider, tool_name, tool_namespace, tool_class, nesting, outcome,
            sum(n)::int AS invocations, coalesce(sum(n) FILTER (WHERE caller_agent_key IS NOT NULL OR has_caller_request), 0)::int AS with_caller
          FROM _usage_tool_rows GROUP BY 1, 2, 3, 4, 5, 6, 7)
        SELECT a.*, tl.label AS tool_label, nl.label AS namespace_label, ci.machine_label
        FROM agg a
        LEFT JOIN personal_hub.usage_name_labels tl ON tl.install_id = a.install_id AND tl.kind = 'tool' AND tl.key = a.tool_name
        LEFT JOIN personal_hub.usage_name_labels nl ON nl.install_id = a.install_id AND nl.kind = 'tool_namespace' AND nl.key = a.tool_namespace
        LEFT JOIN personal_hub.companion_installs ci ON ci.id = a.install_id`);

      // Callers, keyed by the agent map's group through (source -> install, caller agent key). A key the
      // map lacks (its requests fall outside the range) falls back to its `agent` label, then reads as
      // "caller outside range"; a Cursor invocation with no agent key takes its calling request's group.
      const byCaller = await tx.unsafe(`WITH agg AS (
          SELECT account_id, source_id, install_id, provider, caller_agent_key, caller_group_id, sum(n)::int AS invocations
          FROM _usage_tool_rows GROUP BY 1, 2, 3, 4, 5, 6
        ), by_key AS (
          SELECT DISTINCT ON (account_id, source_id, agent_key) account_id, source_id, agent_key, group_id, provider, display_role, display_name, builtin
          FROM _usage_agent_map WHERE agent_key IS NOT NULL
          ORDER BY account_id, source_id, agent_key, (display_role = 'unattributed'), display_name, group_id)
        SELECT a.provider AS caller_provider, a.caller_agent_key, a.invocations,
          k.group_id, k.provider, k.display_role, k.display_name, k.builtin,
          rm.group_id AS request_group_id, rm.provider AS request_provider, rm.display_role AS request_role, rm.display_name AS request_name, rm.builtin AS request_builtin,
          la.label AS agent_label, la.role AS agent_label_role
        FROM agg a
        LEFT JOIN by_key k ON k.account_id = a.account_id AND k.source_id = a.source_id AND k.agent_key = a.caller_agent_key
        LEFT JOIN (SELECT DISTINCT ON (group_id) group_id, provider, display_role, display_name, builtin FROM _usage_agent_map ORDER BY group_id) rm
          ON a.caller_agent_key IS NULL AND rm.group_id = a.caller_group_id
        LEFT JOIN personal_hub.usage_name_labels la ON la.install_id = a.install_id AND la.kind = 'agent' AND la.key = a.caller_agent_key`);
      return { byTool, byCaller };
    }) : emptyTools;

    const knowledgeDetail = accounts.length && wantKnowledge ? await db.begin(async tx => {
      await prepareRead(tx);
      // Agent groups and scope resolve through the agent map; projects through the project map. Each is built
      // here, in this transaction, only when a filter needs it.
      if (q.agents.length || q.agent_scope !== 'all') await createAgentMap(tx, q, accounts, range);
      if (useRequests && q.projects.length) await createProjectMap(tx, q, accounts, range);
      // Accesses follow the machine filter through their own binding, the agent filter through the
      // invocation's caller, and the detail filters through the calling request, exactly as tool
      // invocations do, so the two areas of the card describe one scope.
      const kp = new Params();
      await tx.unsafe(`CREATE TEMP TABLE _usage_accesses ON COMMIT DROP AS
        WITH in_range_accesses AS (
          SELECT DISTINCT a.account_id, a.semantic_key
          FROM personal_hub.resource_accesses a
          WHERE a.account_id = ANY(${kp.add(accounts)}::text[])
            AND a.observed_at >= ${kp.add(rangeStartIso)}::timestamptz AND a.observed_at < ${kp.add(rangeEndIso)}::timestamptz
        ), canonical_accesses AS (
          SELECT DISTINCT ON (a.account_id, a.semantic_key)
            a.account_id, a.binding_id, a.invocation_key, a.resource_key, a.configuration_version, a.access_kind, a.observed_at, a.semantic_key
          FROM personal_hub.resource_accesses a
          JOIN in_range_accesses k ON k.account_id = a.account_id AND k.semantic_key = a.semantic_key
          ORDER BY a.account_id, a.semantic_key, a.observed_at DESC, a.received_at DESC, a.id DESC
        )
        SELECT c.account_id, c.invocation_key, c.access_kind,
          (c.configuration_version IS NOT DISTINCT FROM i.configuration_version) AS current_configuration,
          m.source_id, s.label AS source_label,
          CASE WHEN i.id IS NULL THEN 'unknown' WHEN m.source_id IS NULL THEN 'unassigned' ELSE 'source' END AS source_state,
          CASE WHEN m.source_id IS NULL THEN i.id END AS identity_id
        FROM canonical_accesses c
        JOIN personal_hub.companion_bindings b ON b.id = c.binding_id
        LEFT JOIN personal_hub.usage_knowledge_source_identities i
          ON i.install_id = b.install_id AND i.resource_key = c.resource_key
        LEFT JOIN LATERAL (
          SELECT revision.source_id
          FROM personal_hub.usage_knowledge_source_mapping_revisions revision
          WHERE revision.identity_id = i.id
          ORDER BY revision.revision_order DESC
          LIMIT 1
        ) m ON true
        LEFT JOIN personal_hub.usage_knowledge_sources s ON s.id = m.source_id
        WHERE c.observed_at >= ${kp.add(rangeStartIso)}::timestamptz AND c.observed_at < ${kp.add(rangeEndIso)}::timestamptz
          ${q.machines.length ? `AND b.source_id = ANY(${kp.add(q.machines)}::uuid[])` : ''}`, kp.values);
      // The canonical invocation behind each access carries its session, caller agent, and calling
      // request. The request join is built only when a detail filter needs it, over the callers of this
      // access set alone, so the knowledge card never ranks more requests than it reads.
      const ip = new Params();
      const callers = useRequests ? requestCte(ip, q, accounts, range, 'caller_keys', { columns: CALLER_COLUMNS, project: q.projects.length > 0 }) : null;
      await tx.unsafe(`CREATE TEMP TABLE _usage_access_invocations ON COMMIT DROP AS
        WITH invocations AS (
          SELECT DISTINCT ON (t.account_id, t.invocation_key) t.account_id, t.invocation_key, t.session_hash, t.caller_agent_key, t.caller_request_key
          FROM personal_hub.tool_events t
          JOIN (SELECT DISTINCT account_id, invocation_key FROM _usage_accesses) k ON k.account_id = t.account_id AND k.invocation_key = t.invocation_key
          WHERE t.event_kind = 'invocation'
            AND t.observed_at >= ${ip.add(widenStartIso)}::timestamptz AND t.observed_at < ${ip.add(widenEndIso)}::timestamptz
          ORDER BY t.account_id, t.invocation_key, t.observed_at DESC, t.received_at DESC, t.id DESC)
        ${callers ? `, caller_keys AS (
          SELECT DISTINCT account_id, caller_request_key AS semantic_key FROM invocations WHERE caller_request_key IS NOT NULL
        ), ${callers.text}
        SELECT i.*, r.matches FROM invocations i LEFT JOIN requests r ON r.account_id = i.account_id AND r.semantic_key = i.caller_request_key`
        : 'SELECT i.*, true AS matches FROM invocations i'}`, ip.values);
      // An access whose invocation names no caller agent, or whose calling request was not retained, is
      // excluded under those filters rather than matched: the same rule the tools area applies.
      const fp = new Params();
      const keep = [
        ...(q.agents.length ? [`(i.account_id, i.caller_agent_key) IN ${agentKeysIn(fp, q.agents)}`] : []),
        ...(useRequests ? ['i.matches'] : []),
      ];
      const accessFilter = keep.length ? `WHERE ${keep.join(' AND ')}` : '';
      const knowledgeRows = await tx.unsafe(`
        SELECT a.source_id, a.source_label, coalesce(a.source_state, 'unknown') AS state, a.identity_id,
          count(*) FILTER (WHERE a.current_configuration)::int AS accesses, count(*) FILTER (WHERE NOT a.current_configuration)::int AS earlier_configuration_accesses,
          count(DISTINCT a.invocation_key) FILTER (WHERE a.current_configuration)::int AS distinct_invocations,
          count(DISTINCT i.session_hash) FILTER (WHERE a.current_configuration)::int AS distinct_sessions,
          count(DISTINCT i.caller_agent_key) FILTER (WHERE a.current_configuration)::int AS distinct_agents,
          count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'read')::int AS kind_read,
          count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'search')::int AS kind_search,
          count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'write')::int AS kind_write,
          count(*) FILTER (WHERE a.current_configuration AND a.access_kind = 'unknown')::int AS kind_unknown
        FROM _usage_accesses a LEFT JOIN _usage_access_invocations i ON i.account_id = a.account_id AND i.invocation_key = a.invocation_key
        ${accessFilter} GROUP BY 1, 2, 3, 4 ORDER BY accesses DESC`, fp.values);
      const [knowledgeTotal] = await tx.unsafe(`SELECT count(DISTINCT a.invocation_key)::int AS distinct_invocations
        FROM _usage_accesses a LEFT JOIN _usage_access_invocations i ON i.account_id = a.account_id AND i.invocation_key = a.invocation_key
        ${accessFilter ? `${accessFilter} AND` : 'WHERE'} a.current_configuration`, fp.values);
      return { knowledgeRows, knowledgeTotal: knowledgeTotal ?? { distinct_invocations: 0 } };
    }) : { knowledgeRows: emptyDetail.knowledgeRows, knowledgeTotal: emptyDetail.knowledgeTotal };

    const {
      requestPeriodRows, projectRows, agentRows, requestPricingRows, effortRows, agentEvidence,
    } = requestDetail;
    const { byTool: toolAgg, byCaller: callerAgg } = toolDetail;
    const { knowledgeRows, knowledgeTotal } = knowledgeDetail;

    // 6. Monthly snapshots for the months the range touches, crosswalked to accounts where the operator mapped them.
    const closedMonths = months.filter(month => monthBounds(month, tz).end <= now);
    // The crosswalk table arrives with the report-subjects migration; before it exists (SQLSTATE 42P01)
    // no subject is mapped, which is the same answer an empty table gives. Reading the envelopes without
    // the join keeps the whole query answering across the deploy-then-migrate window: an unmapped
    // snapshot is listed and never counted, exactly as it is when the table is there and empty.
    const snapshotSql = (crosswalk: boolean) => `SELECT DISTINCT ON (rv.period_key, rv.subject_key) rv.period_key, rv.subject_key, rv.status, rv.produced_at,
        rv.payload->>'machine_name' AS machine_name,
        (rv.payload#>>'{report,current,totals,total_tokens}')::float8 AS total_tokens, (rv.payload#>>'{report,current,totals,calls}')::float8 AS calls,
        (rv.payload#>>'{report,current,totals,threads}')::float8 AS threads,
        coalesce(rv.payload#>'{report,current,daily}', '[]'::jsonb) AS daily, rv.payload#>'{report,current,exclusive_composition}' AS composition,
        rv.payload#>>'{report,current,environmental_estimate,methodology_version}' AS methodology_version,
        rv.payload#>'{report,current,environmental_estimate}' AS environmental,
        rv.payload#>>'{report,current,api_equivalent_cost,pricing_catalog,version}' AS pricing_catalog,
        (rv.payload#>>'{report,current,api_equivalent_cost,estimated_cost_usd}')::float8 AS estimated_cost_usd,
        ${crosswalk ? 'sub.account_id, sub.source_timezone' : 'NULL::text AS account_id, NULL::text AS source_timezone'}
      FROM personal_hub.report_revisions rv${crosswalk ? ' LEFT JOIN personal_hub.usage_report_subjects sub ON sub.subject_key = rv.subject_key' : ''}
      WHERE rv.kind = 'usage' AND rv.status <> 'failed' AND rv.period_key = ANY($1::text[])
      ORDER BY rv.period_key, rv.subject_key, CASE WHEN rv.period_key = ANY($2::text[]) AND rv.status = 'complete' THEN 0 ELSE 1 END, rv.produced_at DESC, rv.received_at DESC`;
    const snapshotRows = wantOverview ? await db.unsafe(snapshotSql(true), [months, closedMonths]).catch(error => {
      if ((error as { code?: string }).code !== '42P01') throw error;
      return db.unsafe(snapshotSql(false), [months, closedMonths]);
    }) : [];
    const cohortPopulation = new Map(monthRows.map(r => [`${r.account_id}|${r.month}`, { calls: num(r.calls), raw_tokens: num(r.raw_tokens) }]));
    const coveredMonths = new Set(cohortPopulation.keys());
    const selectedByCohort = new Map<string, { calls: number; raw_tokens: number }>();
    const addSelected = (accountId: string, month: string, calls: number, tokens: number) => {
      const entry = selectedByCohort.get(`${accountId}|${month}`) ?? { calls: 0, raw_tokens: 0 };
      entry.calls += calls; entry.raw_tokens += tokens; selectedByCohort.set(`${accountId}|${month}`, entry);
    };
    // Legacy cohorts stay per report subject, so two subjects mapped to one account never overwrite each other.
    const snapshotCohorts = new Map<string, { account_id: string; month: string; subject_key: string; population: { calls: number; raw_tokens: number }; selected: { calls: number; raw_tokens: number }; stored: StoredEstimate | null }>();

    // ---- Assemble. Points are keyed by their aligned interval start, which is what the rows group under.
    const pointIndex = new Map(periods.map((period, index) => [period.aligned, index]));
    const points: SeriesPoint[] = periods.map(period => ({ start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString(),
      total_tokens: 0, calls: 0, composition: emptyComposition(), state: 'missing', sources: [] }));
    const mark = (index: number, source: SeriesPoint['sources'][number]) => { if (!points[index].sources.includes(source)) points[index].sources.push(source); };

    const headline = empty();
    const byModel = new Map<string, { total_tokens: number; calls: number; composition: Composition; basis: 'buckets' | 'requests' }>();
    const modelSeries = new Map<string, Map<number, { total_tokens: number; calls: number }>>();
    let lastObservation: number | null = null;
    const observe = (value: unknown) => { const instant = value ? new Date(value as string).getTime() : NaN; if (Number.isFinite(instant)) lastObservation = Math.max(lastObservation ?? 0, instant); };
    const bucketTotals = { tokens: 0, calls: 0 };
    for (const row of bucketRows) {
      const start = new Date(row.period_start as string).getTime();
      const index = pointIndex.get(start);
      bucketTotals.tokens += num(row.total_tokens); bucketTotals.calls += num(row.calls);
      if (useRequests) continue;   // request rows drive the headline; buckets still bound the population below
      addSelected(row.account_id as string, localMonthKey(new Date(row.day_start as string).getTime(), tz), num(row.calls), num(row.total_tokens));
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
      addSelected(row.account_id as string, localMonthKey(new Date(row.period_start as string).getTime(), tz), num(row.calls), num(row.total_tokens));
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
        snapshotCohorts.set(`${accountId}|${month}|${entry.subject_key}`, { account_id: accountId, month, subject_key: entry.subject_key, population: { calls: entry.calls, raw_tokens: entry.total_tokens }, selected: { calls: entry.calls, raw_tokens: entry.total_tokens }, stored: storedEstimate(row.environmental) });
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
        else {
          headline.composition.unclassified += entry.merged_tokens;
          snapshotCohorts.set(`${accountId}|${month}|${entry.subject_key}`, { account_id: accountId, month, subject_key: entry.subject_key, population: { calls: entry.calls, raw_tokens: entry.total_tokens }, selected: { calls: entry.merged_calls, raw_tokens: entry.merged_tokens }, stored: storedEstimate(row.environmental) });
        }
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
    // One row per model and effort, carrying only the periods it actually recorded; a period with no request stays absent.
    const effortSeries = new Map<string, { model: string; effort: string; points: Map<number, { total_tokens: number; calls: number }> }>();
    let effortTokens = 0;
    for (const row of effortRows) {
      const index = pointIndex.get(new Date(row.period_start as string).getTime());
      if (index === undefined) continue;
      const model = row.model as string, effort = row.effort as string, key = `${model}\u0000${effort}`;
      const series = effortSeries.get(key) ?? { model, effort, points: new Map() };
      const entry = series.points.get(index) ?? { total_tokens: 0, calls: 0 };
      entry.total_tokens += num(row.total_tokens); entry.calls += num(row.calls);
      effortTokens += num(row.total_tokens);
      series.points.set(index, entry); effortSeries.set(key, series);
    }
    const effortSeriesRows = [...effortSeries.values()].map(({ model, effort, points: byIndex }) => ({ model, effort,
      points: [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([index, value]) => ({ start: points[index].start, ...value })) }))
      .sort((a, b) => a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort));

    const requestEligible = useRequests ? requestTotals.matching.tokens : bucketTotals.tokens;
    const requestCovered = useRequests ? requestTotals.matching.tokens : requestTotals.all.tokens;
    const detailNote = 'Request detail covers the canonical tokens linked to accepted request records; buckets remain the headline until a collection slice is declared complete and reconciled.';
    const pricing = useRequests
      ? requestPricingRows.map(row => pricingRowFromSql(row, {
          context_band: contextBandFor((row.provider as string | null) ?? null, (row.model as string | null) ?? null, { openai: row.over_openai === true, anthropic: row.over_anthropic === true, xai: row.over_xai === true }),
          rate_date: (row.rate_date as string | null) ?? null,
        }))
      : bucketPricingRows.map(row => pricingRowFromSql(row, {
          provider: byId.get(row.account_id as string)?.provider ?? null,
          context_band: 'short',
          rate_date: (row.rate_date as string | null) ?? null,
        }));
    const cost = priceUsage(pricing.map(pricingInputFromRow));
    const pricedEligible = pricing.reduce((n, row) => n + row.total_tokens, 0);
    const pricedWithEvidence = pricing.filter(row => row.model !== null).reduce((n, row) => n + row.total_tokens, 0);
    const pricingCoverageNote = useRequests
      ? 'Pricing inputs exist on request records; the eligible population is the request-covered tokens, and rows without a model cannot be priced.'
      : 'The estimate prices the same hourly buckets as the headline: model, the Chicago calendar date of the hour, and exclusive token composition. Missing service tier is assumed Standard and counted. Buckets are not a single request, so every row prices on the short context band. Rows without a model cannot be priced.';
    const pricingNote = useRequests
      ? 'Catalog pricing is applied by the cost calculation (USG-013); these are its inputs with effort, tier, speed, context, and cache-write evidence preserved and unknown kept unknown.'
      : 'Catalog pricing is applied by the cost calculation (USG-013). Hourly collection is enough to estimate; request-level effort, tier, speed, and long-context evidence refine the estimate when a detail filter makes requests the headline.';

    const projectRowsOut = projectRows.map(row => ({ state: row.state as UsageQueryResult['projects']['rows'][number]['state'], project_id: (row.project_id as string | null) ?? null,
      label: (row.project_label as string | null) ?? null, filter_value: row.filter_value as string, total_tokens: num(row.total_tokens), calls: num(row.calls), conversations: num(row.conversations), share: share(num(row.total_tokens), useRequests ? headlineTokens : requestTotals.matching.tokens) }));
    const projectEvidenced = projectRowsOut.filter(r => r.state !== 'unknown').reduce((n, r) => n + r.total_tokens, 0);
    const projectIdentity = projectRowsOut.filter(r => r.state === 'project' || r.state === 'unassigned').reduce((n, r) => n + r.total_tokens, 0);
    const projectMapped = projectRowsOut.filter(r => r.state === 'project').reduce((n, r) => n + r.total_tokens, 0);

    type AgentOut = UsageQueryResult['agents']['rows'][number];
    const agentRowsOut: AgentOut[] = agentRows.map(row => {
      const composition = emptyComposition(); addComposition(composition, row);
      return { group_id: row.group_id as string, provider: row.provider as string, role: row.role as AgentOut['role'], name: row.name as string, builtin: row.builtin === true,
        instances: num(row.instances), sessions: num(row.sessions), total_tokens: num(row.total_tokens), calls: num(row.calls), composition,
        share: share(num(row.total_tokens), useRequests ? headlineTokens : requestTotals.matching.tokens) };
    });
    const roleTokens = (role: string) => agentRowsOut.filter(r => r.role === role).reduce((n, r) => n + r.total_tokens, 0);
    // The role-class line uses the displayed role and builtin tag, the same partition the rows and the agent-scope filter use.
    const byClass: Record<string, number> = {};
    for (const row of agentRowsOut) {
      const cls = row.role === 'main' ? 'main' : row.role === 'unattributed' ? 'unattributed' : row.builtin ? 'builtin' : 'custom';
      byClass[cls] = (byClass[cls] ?? 0) + row.total_tokens;
    }

    // Tools: display names from the labels, builtin from the class or the provider's display list, and
    // nested Codex MCP calls folded under their exec (spec 6.4). An unlabeled `h:` key reads as a short
    // hash with its machine and never raises an error.
    type ToolOut = UsageQueryResult['tools']['by_tool'][number];
    type ChildOut = ToolOut['children'][number];
    const HASHED = /^h:[a-f0-9]{16}$/;
    const shortHash = (value: string) => `${value.slice(0, 6)}…`;
    const toolTotal = toolAgg.reduce((n, row) => n + num(row.invocations), 0);
    const byTool = new Map<string, ToolOut & { childIndex: Map<string, ChildOut> }>();
    const byOutcome: Record<string, number> = {};
    let withCaller = 0, withOutcome = 0;
    const execKeys: string[] = [];
    const SYNTHETIC_EXEC = 'synthetic|exec (outside range)';
    // A Codex app connector's namespace label is its full `codex_apps:<app>` text (the companion keeps the
    // prefix so the read can tell a connector from an MCP server of the same name); it reads "<app> (connector)".
    const CONNECTOR = 'codex_apps:';
    const display = (row: Row) => {
      const raw = (row.tool_name as string | null) ?? null, label = (row.tool_label as string | null) ?? null;
      const unlabeled = !label && !!raw && HASHED.test(raw);
      const name = label ?? (raw ? (unlabeled ? shortHash(raw) : raw) : row.tool_class === 'builtin' ? 'builtin (unnamed)' : null);
      const rawNs = (row.tool_namespace as string | null) ?? null, nsLabel = (row.namespace_label as string | null) ?? null;
      const nsUnlabeled = !nsLabel && !!rawNs && HASHED.test(rawNs);
      const nsText = nsLabel ?? rawNs;
      const namespace = nsText === null ? null
        : nsText.startsWith(CONNECTOR) && nsText.length > CONNECTOR.length ? `${nsText.slice(CONNECTOR.length)} (connector)`
        : nsUnlabeled ? shortHash(nsText) : nsText;
      const machine = unlabeled || nsUnlabeled ? (row.machine_label as string | null) ?? null : null;
      const builtin = row.tool_class === 'builtin' || (!!name && (KNOWN_BUILTIN_TOOLS[row.provider as string] ?? []).includes(name));
      // Rows aggregate by identity, not by the text shown: an unlabeled hash is keyed by its full value and
      // its install (the salt is per install), so two hashes sharing their shown prefix never merge. Labelled
      // and readable values key by their text, which merges the same name across machines.
      const install = (row.install_id as string | null) ?? '';
      const nameId = unlabeled ? ['hash', raw, install] : ['text', name];
      const nsId = nsUnlabeled ? ['hash', rawNs, install] : ['text', nsText];
      return { name, namespace, machine, builtin, nameId, nsId };
    };
    const topRow = (key: string, init: () => ToolOut) => {
      const existing = byTool.get(key);
      if (existing) return existing;
      const created = { ...init(), childIndex: new Map<string, ChildOut>() };
      byTool.set(key, created);
      return created;
    };
    // Top-level rows first, so a child always finds its exec row.
    const ordered = [...toolAgg].sort((a, b) => Number(a.nesting !== 'top') - Number(b.nesting !== 'top'));
    for (const row of ordered) {
      const n = num(row.invocations);
      const outcome = (row.outcome as string | null) ?? UNKNOWN;
      byOutcome[outcome] = (byOutcome[outcome] ?? 0) + n;
      withCaller += num(row.with_caller);
      if (outcome !== UNKNOWN) withOutcome += n;
      const shown = display(row);
      if (row.nesting === 'top') {
        const key = JSON.stringify([row.tool_class, shown.nsId, shown.nameId]);
        const tool = topRow(key, () => ({ name: shown.name, class: row.tool_class as string, namespace: shown.namespace, builtin: shown.builtin, machine: shown.machine,
          synthetic: false, invocations: 0, share: null, children: [] }));
        tool.invocations += n;
        if (row.tool_name === 'exec' && row.provider === 'codex' && !execKeys.includes(key)) execKeys.push(key);
        continue;
      }
      const parentKey = row.nesting === 'child' && execKeys.length ? execKeys[0] : SYNTHETIC_EXEC;
      const parent = topRow(parentKey, () => ({ name: 'exec (outside range)', class: 'builtin', namespace: null, builtin: true, machine: null,
        synthetic: true, invocations: 0, share: null, children: [] }));
      const childKey = JSON.stringify([shown.nsId, shown.nameId]);
      const child = parent.childIndex.get(childKey) ?? { name: shown.name, namespace: shown.namespace, invocations: 0, outcomes: {} };
      child.invocations += n;
      child.outcomes[outcome] = (child.outcomes[outcome] ?? 0) + n;
      parent.childIndex.set(childKey, child);
    }
    const toolRowsOut: ToolOut[] = [...byTool.values()].map(({ childIndex, ...tool }) => ({ ...tool, share: share(tool.invocations, toolTotal),
      children: [...childIndex.values()].sort((a, b) => b.invocations - a.invocations || String(a.name).localeCompare(String(b.name))) }))
      .sort((a, b) => b.invocations - a.invocations || b.children.length - a.children.length || String(a.name).localeCompare(String(b.name)));

    type CallerOut = UsageQueryResult['tools']['by_caller'][number];
    const callers = new Map<string, CallerOut>();
    for (const row of callerAgg) {
      const n = num(row.invocations);
      const caller: Omit<CallerOut, 'invocations'> = row.group_id
        ? { state: 'group', group_id: row.group_id as string, provider: row.provider as string, role: row.display_role as string, name: row.display_name as string, builtin: row.builtin === true }
        : row.request_group_id
          ? { state: 'group', group_id: row.request_group_id as string, provider: row.request_provider as string, role: row.request_role as string, name: row.request_name as string, builtin: row.request_builtin === true }
          : row.caller_agent_key && row.agent_label
            ? { state: 'label', group_id: null, provider: (row.caller_provider as string | null) ?? null, role: (row.agent_label_role as string | null) ?? null, name: row.agent_label as string,
                builtin: (KNOWN_BUILTIN_AGENTS[row.caller_provider as string] ?? []).includes(row.agent_label as string) }
            : row.caller_agent_key
              ? { state: 'outside_range', group_id: null, provider: (row.caller_provider as string | null) ?? null, role: null, name: null, builtin: false }
              : { state: 'none', group_id: null, provider: null, role: null, name: null, builtin: false };
      const key = caller.state === 'group' ? `group:${caller.group_id}` : caller.state === 'label' ? `label:${caller.provider}:${caller.role}:${caller.name}` : `${caller.state}:${caller.provider ?? ''}`;
      const entry = callers.get(key) ?? { ...caller, invocations: 0 };
      entry.invocations += n; callers.set(key, entry);
    }

    const knowledge = knowledgeRows.map(row => ({ source_id: (row.source_id as string | null) ?? null, label: (row.source_label as string | null) ?? null, state: row.state as string,
      accesses: num(row.accesses), distinct_invocations: num(row.distinct_invocations), distinct_sessions: num(row.distinct_sessions), distinct_agents: num(row.distinct_agents),
      by_access_kind: { read: num(row.kind_read), search: num(row.kind_search), write: num(row.kind_write), unknown: num(row.kind_unknown) }, earlier_configuration_accesses: num(row.earlier_configuration_accesses) }));

    // Cohorts: every (account, source month) with selected calls, classified from its whole population.
    const cohortInputs: CohortInput[] = [];
    for (const [key, selected] of selectedByCohort) {
      const [accountId, month] = key.split('|');
      const population = cohortPopulation.get(key);
      if (!population || selected.calls === 0) continue;
      cohortInputs.push({ account_id: accountId, provider: byId.get(accountId)?.provider ?? UNKNOWN, month, basis: 'buckets', subject_key: null, population, selected, month_closed: monthBounds(month, tz).end <= now, stored: null });
    }
    for (const snapshot of snapshotCohorts.values()) {
      if (snapshot.selected.calls === 0) continue;
      cohortInputs.push({ account_id: snapshot.account_id, provider: byId.get(snapshot.account_id)?.provider ?? UNKNOWN, month: snapshot.month, basis: 'snapshot', subject_key: snapshot.subject_key,
        population: snapshot.population, selected: snapshot.selected, month_closed: monthBounds(snapshot.month, tz).end <= now, stored: snapshot.stored });
    }
    if (useRequests) unsupported.push('Environmental cohorts stay at account and source month; a detail filter sums the selected calls under the cohort\'s class and never reclassifies it.');
    const environment = estimateEnvironment(cohortInputs, { headlineCalls: headline.calls });
    if (q.resolution === 'hour' && snapshots.length) unsupported.push('Monthly snapshots cannot be placed on an hourly series.');

    return clone({
      as_of: new Date(now).toISOString(),
      scope: { range: { preset: range.preset, start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString(), timezone: tz, anchored_to_now: range.anchored_to_now, resolution: q.resolution },
        accounts: selected, machines: m.sources.filter(s => s.mode !== 'browser'), filters: { accounts: q.accounts, providers: q.providers, models: q.models, efforts: q.efforts, machines: q.machines, surfaces: q.surfaces, projects: q.projects, agent_scope: q.agent_scope, agents: q.agents },
        detail_filters: detailFilters },
      headline: { ...headline, last_observation: lastObservation ? new Date(lastObservation).toISOString() : null },
      series: { resolution: q.resolution, points, excludes_snapshot_tokens: snapshotSeriesExcluded },
      by_model: modelRows, model_series: modelSeriesRows,
      effort_series: { rows: effortSeriesRows,
        coverage: coverage('tokens', headlineTokens, requestCovered, effortTokens, 'Effort is recorded on request detail only; the eligible population is the request-covered tokens, and a request without a reported effort is kept as unknown.') },
      pricing_inputs: { rows: pricing, coverage: coverage('tokens', headlineTokens, pricedEligible, pricedWithEvidence, pricingCoverageNote), note: pricingNote },
      projects: { rows: projectRowsOut,
        coverage: coverage('tokens', headlineTokens, requestCovered, projectEvidenced, 'Project evidence: request-covered tokens with a project identity or an explicit No project; Unknown project is the remainder.'),
        registry: coverage('tokens', headlineTokens, projectIdentity, projectMapped, 'App projects: tokens whose folder or session the companion placed, and the part that lands in a project an app defines.') },
      agents: { rows: agentRowsOut,
        summary: { main_tokens: roleTokens('main'), subagent_tokens: roleTokens('subagent'), unattributed_tokens: roleTokens('unattributed'), observed_children: num(agentEvidence.observed_children), spawns: num(agentEvidence.spawns), by_class: byClass },
        coverage: coverage('tokens', headlineTokens, requestCovered, roleTokens('main') + roleTokens('subagent'), [
          'Agent attribution: request-covered tokens assigned to a main or child identity; missing identity stays unattributed.',
          ...(eventUnsupported.length ? [`Spawn events and lifecycle-observed children follow the machine and agent filters only; the ${eventUnsupported.join(', ')} filter${eventUnsupported.length > 1 ? 's do' : ' does'} not apply to them.`] : []),
        ].join(' ')) },
      tools: { invocations: toolTotal, by_tool: toolRowsOut,
        by_caller: [...callers.values()].sort((a, b) => b.invocations - a.invocations || String(a.name).localeCompare(String(b.name))), by_outcome: byOutcome,
        caller_coverage: coverage('invocations', toolTotal, toolTotal, withCaller, 'Reported invocations with a supported caller.'),
        outcome_coverage: coverage('invocations', toolTotal, toolTotal, withOutcome, 'Reported invocations with a supported outcome.'), unsupported_filters: toolUnsupported },
      knowledge: { rows: knowledge, distinct_invocations: num(knowledgeTotal.distinct_invocations),
        note: [
          'Per-source access counts overlap when one invocation touches several sources; distinct_invocations is the unduplicated total. Only rows classified under each install\'s current configuration count.',
          'Accesses follow the account, machine, and agent filters through their own binding and calling invocation, and the effort, surface, project, and agent-scope filters through the calling request.',
          ...(q.models.length ? ['The model filter is not applied to knowledge accesses: an access carries no model and is only linked to one through a retained calling request under a detail filter.'] : []),
        ].join(' '), unsupported_filters: knowledgeUnsupported },
      environmental_inputs: { cohorts: cohortInputs, coverage: coverage('calls', headline.calls, environment.coverage.calls_estimated + environment.coverage.calls_without_class, environment.coverage.calls_estimated, 'Cohorts are account and source calendar month; the class comes from the whole month and the selected calls are summed under it.'),
        note: 'Average raw tokens per call is the cohort input the reused method classifies; nothing here converts allowance movement or dollars into calls.' },
      cost, environment,
      historical: { snapshots, note: 'A snapshot merges only for a mapped account whose hourly ledger has nothing in that month, as a whole month, or by whole source days when its zone is known; otherwise it is listed and not counted.' },
      request_detail: { covered_tokens: requestCovered, covered_calls: useRequests ? requestTotals.matching.calls : requestTotals.all.calls,
        coverage: coverage('tokens', useRequests ? headlineTokens : bucketTotals.tokens, requestEligible, requestCovered, detailNote) },
      unsupported, notes,
    });
  }

  /** Subjects seen in monthly reports beside their crosswalk, for the Settings surface that maps them. */
  async function listReportSubjects() {
    const db = await sql();
    // Before the crosswalk table exists (SQLSTATE 42P01) every subject is simply unmapped, so the surface
    // still lists what the envelopes name; mapping one needs the migration and says so on its own.
    const subjectRows = (crosswalk: boolean) => crosswalk
      ? db`SELECT rv.subject_key, max(rv.payload->>'machine_name') AS machine_name, min(rv.period_key) AS first_month, max(rv.period_key) AS last_month,
        count(*)::int AS revisions, sub.account_id, sub.source_timezone, sub.updated_at
      FROM personal_hub.report_revisions rv LEFT JOIN personal_hub.usage_report_subjects sub ON sub.subject_key = rv.subject_key
      WHERE rv.kind = 'usage' GROUP BY rv.subject_key, sub.account_id, sub.source_timezone, sub.updated_at ORDER BY rv.subject_key`
      : db`SELECT rv.subject_key, max(rv.payload->>'machine_name') AS machine_name, min(rv.period_key) AS first_month, max(rv.period_key) AS last_month,
        count(*)::int AS revisions, NULL::text AS account_id, NULL::text AS source_timezone, NULL::timestamptz AS updated_at
      FROM personal_hub.report_revisions rv
      WHERE rv.kind = 'usage' GROUP BY rv.subject_key ORDER BY rv.subject_key`;
    const rows = await subjectRows(true).catch(error => {
      if ((error as { code?: string }).code !== '42P01') throw error;
      return subjectRows(false);
    });
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

/**
 * Bounded per-scope cache: identical parameters within the TTL share one read; a failed read is not
 * kept. `clear` drops every scope, for a write that changes what a read resolves (a project or
 * knowledge-source label or mapping), so the next read shows it instead of waiting out the TTL.
 */
export function createUsageQueryCache(load: (params: UsageQuery, options: { now: number }) => Promise<UsageQueryResult>,
  { ttlMs = USAGE_QUERY_CACHE_TTL_MS, max = USAGE_QUERY_CACHE_MAX, clock = Date.now }: { ttlMs?: number; max?: number; clock?: () => number } = {}) {
  const cache = new Map<string, { expires: number; value: Promise<UsageQueryResult> }>();
  return {
    get(params: UsageQuery) {
      const key = stableJson(params);
      const now = clock();
      const hit = cache.get(key);
      if (hit && hit.expires > now) return hit.value;
      const value = load(params, { now }).catch(error => { if (cache.get(key)?.value === value) cache.delete(key); throw error; });
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      cache.set(key, { expires: now + ttlMs, value });
      return value;
    },
    clear() { cache.clear(); },
    get size() { return cache.size; },
  };
}
const usageQueryCache = createUsageQueryCache((params, options) => defaultQuery.usageQuery(params, options));
export const usageQuery = (params: UsageQuery) => usageQueryCache.get(params);
/** Called by the usage store after a registry write; every process instance clears only its own memory. */
export const clearUsageQueryCache = () => usageQueryCache.clear();
