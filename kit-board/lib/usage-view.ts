import { DISPLAY_TIMEZONE, HOUR, MAX_HOURLY_RANGE_DAYS, PRESETS, RESOLUTIONS, isSupportedTimeZone, localDateKey, wallClock, zonedInstant, type Preset, type Resolution } from './usage-periods';
import type { Composition, SeriesPoint, UsageQueryResult } from './usage-query';

/**
 * Client-safe view logic for the Tokens page (USG-017): the filter state that lives in the private
 * URL, its round trip to the query string `GET /api/usage-query` accepts, and the pure shaping of
 * the query result into what the cards render (composition segments, chart scale, interval labels,
 * series states). Nothing here fetches or touches the database; the same functions run in the
 * browser and in the render test.
 */
export const PROVIDER_OPTIONS = ['codex', 'claude', 'cursor', 'anthropic_api', 'openai_api'] as const;
export const SURFACE_OPTIONS = ['cli', 'ide', 'desktop', 'sdk', 'ci', 'cloud', 'unknown'] as const;
export const PROJECT_STATES = ['no_project', 'unknown', 'unassigned'] as const;
export const AGENT_SCOPES = ['all', 'main', 'subagent'] as const;

export type TokensFilters = {
  preset: Preset; start: string | null; end: string | null; timezone: string; resolution: Resolution;
  accounts: string[]; providers: string[]; models: string[]; efforts: string[]; machines: string[]; surfaces: string[]; projects: string[];
  agent_scope: typeof AGENT_SCOPES[number]; agents: string[];
};
export const DEFAULT_FILTERS: TokensFilters = {
  preset: 'month_to_date', start: null, end: null, timezone: DISPLAY_TIMEZONE, resolution: 'day',
  accounts: [], providers: [], models: [], efforts: [], machines: [], surfaces: [], projects: [], agent_scope: 'all', agents: [],
};
export const LIST_FILTER_KEYS = ['accounts', 'providers', 'models', 'efforts', 'machines', 'surfaces', 'projects', 'agents'] as const;
export type ListFilterKey = typeof LIST_FILTER_KEYS[number];
export const PRESET_LABELS: Record<Preset, string> = {
  today: 'Today', last_7_days: 'Last 7 days', last_30_days: 'Last 30 days', month_to_date: 'Month to date', previous_month: 'Previous month', custom: 'Custom range',
};
export const PROJECT_STATE_LABELS: Record<typeof PROJECT_STATES[number], string> = { no_project: 'No project', unknown: 'Unknown project', unassigned: 'Unassigned project' };

const isIso = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
/** Lists are canonical: deduplicated and sorted, so the same selection always yields the same URL and cache key. */
const listOf = (params: URLSearchParams, key: string) => [...new Set(params.getAll(key).flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean))].sort();

/** Reads the private URL tolerantly: an unknown value is dropped rather than failing the page. */
export function parseTokensFilters(params: URLSearchParams): TokensFilters {
  const preset = params.get('preset');
  const start = params.get('start'), end = params.get('end'), timezone = params.get('timezone'), resolution = params.get('resolution'), scope = params.get('agent_scope');
  const filters: TokensFilters = {
    ...DEFAULT_FILTERS,
    preset: (PRESETS as readonly string[]).includes(preset ?? '') ? preset as Preset : DEFAULT_FILTERS.preset,
    start: start && isIso(start) ? start : null, end: end && isIso(end) ? end : null,
    timezone: timezone && isSupportedTimeZone(timezone) ? timezone : DISPLAY_TIMEZONE,
    resolution: (RESOLUTIONS as readonly string[]).includes(resolution ?? '') ? resolution as Resolution : 'day',
    agent_scope: (AGENT_SCOPES as readonly string[]).includes(scope ?? '') ? scope as TokensFilters['agent_scope'] : 'all',
  };
  for (const key of LIST_FILTER_KEYS) filters[key] = listOf(params, key);
  filters.providers = filters.providers.filter(v => (PROVIDER_OPTIONS as readonly string[]).includes(v));
  filters.surfaces = filters.surfaces.filter(v => (SURFACE_OPTIONS as readonly string[]).includes(v));
  if (filters.preset === 'custom' && (!filters.start || !filters.end)) { filters.preset = DEFAULT_FILTERS.preset; filters.start = null; filters.end = null; }
  if (filters.preset !== 'custom') { filters.start = null; filters.end = null; }
  // Hourly resolution exists only for ranges the API serves hourly; a longer range falls back to daily rather than failing.
  if (filters.resolution === 'hour' && !hourlyPossible(filters)) filters.resolution = 'day';
  return filters;
}

/** Whether the filters' range can be served hourly before the range is resolved: presets longer than 14 days never can. */
export function hourlyPossible(filters: Pick<TokensFilters, 'preset' | 'start' | 'end'>) {
  if (filters.preset === 'last_30_days' || filters.preset === 'previous_month') return false;
  if (filters.preset === 'custom') return !!filters.start && !!filters.end && hourlyAllowed({ start: filters.start, end: filters.end });
  return true;
}

/** A timestamp in the display zone, so every time on the page reads in one zone. */
export function whenIn(value: string | null, timezone: string) {
  if (!value) return '—';
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(instant) : '—';
}

/** Writes only what differs from the defaults, so the landing URL stays bare and a shared link stays short. */
export function serializeTokensFilters(filters: TokensFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.preset !== DEFAULT_FILTERS.preset) params.set('preset', filters.preset);
  if (filters.preset === 'custom' && filters.start && filters.end) { params.set('start', filters.start); params.set('end', filters.end); }
  if (filters.timezone !== DEFAULT_FILTERS.timezone) params.set('timezone', filters.timezone);
  if (filters.resolution !== DEFAULT_FILTERS.resolution) params.set('resolution', filters.resolution);
  if (filters.agent_scope !== 'all') params.set('agent_scope', filters.agent_scope);
  for (const key of LIST_FILTER_KEYS) if (filters[key].length) params.set(key, [...filters[key]].sort().join(','));
  return params;
}

/** The query string the API accepts is the same set of keys, so the private URL and the request stay one document. */
export const queryString = (filters: TokensFilters) => serializeTokensFilters(filters).toString();

export function hourlyAllowed(range: { start: string; end: string }) {
  return Date.parse(range.end) - Date.parse(range.start) <= MAX_HOURLY_RANGE_DAYS * 24 * HOUR;
}

/** A custom range from two local calendar dates, inclusive of the end date, in the display zone. */
export function customRangeFromDates(startDate: string, endDate: string, timezone: string) {
  const [sy, sm, sd] = startDate.split('-').map(Number), [ey, em, ed] = endDate.split('-').map(Number);
  if (![sy, sm, sd, ey, em, ed].every(Number.isFinite)) return null;
  const start = zonedInstant(sy, sm, sd, timezone);
  const endExclusive = new Date(Date.UTC(ey, em - 1, ed + 1));
  const end = zonedInstant(endExclusive.getUTCFullYear(), endExclusive.getUTCMonth() + 1, endExclusive.getUTCDate(), timezone);
  if (end <= start) return null;
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export type FilterLabels = { accounts?: Record<string, string>; projects?: Record<string, string>; machines?: Record<string, string>; agents?: Record<string, string> };
export type FilterChip = { key: string; label: string; next: TokensFilters };

/** Every active narrowing as a removable chip; the range and resolution are controls, not chips. */
export function activeFilterChips(filters: TokensFilters, labels: FilterLabels = {}): FilterChip[] {
  const chips: FilterChip[] = [];
  const name = (key: ListFilterKey, value: string) => {
    if (key === 'projects' && (PROJECT_STATES as readonly string[]).includes(value)) return PROJECT_STATE_LABELS[value as typeof PROJECT_STATES[number]];
    const table = key === 'accounts' ? labels.accounts : key === 'projects' ? labels.projects : key === 'machines' ? labels.machines : key === 'agents' ? labels.agents : undefined;
    const short = key === 'agents' ? `agent ${value.slice(0, 8)}` : value;
    return table?.[value] ?? short;
  };
  const singular: Record<ListFilterKey, string> = { accounts: 'Account', providers: 'Provider', models: 'Model', efforts: 'Effort', machines: 'Machine', surfaces: 'Surface', projects: 'Project', agents: 'Agent' };
  for (const key of LIST_FILTER_KEYS) {
    for (const value of filters[key]) chips.push({ key: `${key}:${value}`, label: `${singular[key]}: ${name(key, value)}`, next: { ...filters, [key]: filters[key].filter(v => v !== value) } });
  }
  if (filters.agent_scope !== 'all') chips.push({ key: 'agent_scope', label: filters.agent_scope === 'main' ? 'Main agent only' : 'Subagents only', next: { ...filters, agent_scope: 'all' } });
  return chips;
}

export const clearedFilters = (filters: TokensFilters): TokensFilters => ({ ...DEFAULT_FILTERS, preset: filters.preset, start: filters.start, end: filters.end, timezone: filters.timezone, resolution: filters.resolution });

export type CompositionSegment = { key: 'input_fresh' | 'input_cached' | 'input_cache_write' | 'output' | 'unclassified'; label: string; tokens: number; share: number | null };
export type CompositionView = {
  segments: CompositionSegment[]; total: number; classified: number;
  /** Tokens the headline reports beyond its exclusive components, shown inside the unclassified segment. */
  remainder: number;
  /** Components summing above the headline total: composition is inconsistent and its shares are withheld. */
  inconsistent: boolean;
  reasoning: number | null; reasoning_share_of_output: number | null;
};

/** Exclusive categories that reconcile to the headline total; reasoning stays a subset of output. */
export function compositionView(headline: { total_tokens: number; composition: Composition }): CompositionView {
  const c = headline.composition, total = headline.total_tokens;
  const classified = c.input_fresh + c.input_cached + c.input_cache_write + c.output + c.unclassified;
  const remainder = Math.max(0, total - classified);
  const inconsistent = classified > total;
  const share = (n: number) => (inconsistent || total <= 0 ? null : n / total);
  const segments: CompositionSegment[] = [
    { key: 'input_fresh', label: 'Fresh input', tokens: c.input_fresh, share: share(c.input_fresh) },
    { key: 'input_cached', label: 'Cached input', tokens: c.input_cached, share: share(c.input_cached) },
    { key: 'input_cache_write', label: 'Cache-write input', tokens: c.input_cache_write, share: share(c.input_cache_write) },
    { key: 'output', label: 'Output', tokens: c.output, share: share(c.output) },
    { key: 'unclassified', label: 'Unclassified', tokens: c.unclassified + remainder, share: share(c.unclassified + remainder) },
  ];
  return { segments, total, classified, remainder, inconsistent, reasoning: c.reasoning, reasoning_share_of_output: c.reasoning !== null && c.output > 0 ? c.reasoning / c.output : null };
}

export const compactTokens = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n >= 1e9 ? 2 : 1 }).format(n);
export const exactTokens = (n: number) => new Intl.NumberFormat('en-US').format(Math.round(n));
export const percent = (share: number | null) => (share === null ? '—' : `${(share * 100).toFixed(share * 100 >= 10 ? 0 : 1)}%`);

const dayName = (instant: number, timezone: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(instant);
const clock = (instant: number, timezone: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(instant);

/** A point's interval as the reader sees it, in the display zone; a clipped or partial interval names both ends. */
export function intervalLabel(point: Pick<SeriesPoint, 'start' | 'end' | 'state'>, timezone: string, resolution: Resolution) {
  const start = Date.parse(point.start), end = Date.parse(point.end);
  if (resolution === 'day') {
    const day = dayName(start, timezone);
    const whole = wallClock(start, timezone).hour === 0 && wallClock(end, timezone).hour === 0 && localDateKey(end - 1, timezone) === localDateKey(start, timezone);
    return whole ? day : `${day} · ${clock(start, timezone)} to ${clock(end, timezone)}`;
  }
  return `${dayName(start, timezone)} · ${clock(start, timezone)} to ${clock(end, timezone)}`;
}

export const STATE_LABELS: Record<SeriesPoint['state'], string> = { observed: 'observed', zero: 'no activity recorded', missing: 'no collector coverage', partial: 'still being observed' };

export function seriesSummary(points: SeriesPoint[]) {
  const counts = { observed: 0, zero: 0, missing: 0, partial: 0 };
  let total = 0, calls = 0;
  for (const p of points) { counts[p.state]++; total += p.total_tokens; calls += p.calls; }
  return { counts, total, calls, intervals: points.length };
}

/** Dates for the custom-range inputs, from the resolved range, in the display zone. */
export function rangeDates(range: { start: string; end: string }, timezone: string) {
  return { start: localDateKey(Date.parse(range.start), timezone), end: localDateKey(Date.parse(range.end) - 1, timezone) };
}

export type ResultLike = Pick<UsageQueryResult, 'scope' | 'headline' | 'series' | 'historical' | 'unsupported' | 'notes' | 'request_detail' | 'as_of'>;
