import catalogJson from './pricing-catalog.json';

/**
 * API-equivalent pricing (USG-013), the Codex monthly analyzer's catalog rules reproduced for
 * filtered collected activity. Each pricing-input row is a group of canonical requests sharing
 * model, recorded effort, service tier, speed, context band, cache-write TTL, token state, and
 * rate date; a row is priced exactly as the analyzer prices one event: the model's period on the
 * event date, the tier after aliases (missing tier assumed standard and counted), the short or
 * long context band, uncached input at the input rate, cache reads at the cached rate, cache
 * writes at the input rate times the write multiplier, and all output (reasoning included once)
 * at the output rate. Tokens the row reports beyond its priced components stay unpriced with
 * their reason, never priced as free. Nothing here is a subscription bill or an invoice.
 */
type Rates = { input: number; cached_input: number; output: number };
type Period = { effective_from?: string; effective_until?: string; rate_version?: string; rates: Record<string, Record<string, Rates>>; service_tier_aliases?: Record<string, string> };
type ModelConfig = { aliases?: string[]; cache_write_input_multiplier?: number; cache_write_1h_input_multiplier?: number; full_context_window_at_standard_rates?: boolean; periods: Period[] };
type ProviderCatalog = { catalog_version: string; currency: string; unit_tokens: number; long_context_threshold_tokens: number; provenance?: string;
  sources: { label: string; url: string }[]; rules?: Record<string, string>; models: Record<string, ModelConfig> };
export type PricingCatalog = { openai: ProviderCatalog; anthropic: ProviderCatalog; xai: ProviderCatalog };
export type CatalogKey = keyof PricingCatalog;
export const pricingCatalog = catalogJson as unknown as PricingCatalog;

export type PricingInputRow = {
  provider: string | null; model: string | null; reasoning_effort: string | null; service_tier: string | null; speed: string | null;
  context_window_tokens: number | null; cache_write_ttl: string | null; token_state: string | null;
  /** Whether the requests' logged input exceeded the provider's long-context threshold. */
  context_band: 'short' | 'long' | null;
  /** The event date the rate period is chosen for, `YYYY-MM-DD`. */
  rate_date: string | null;
  calls: number; input_fresh: number; input_cached: number; input_cache_write: number; output: number; reasoning: number | null; unclassified: number; total_tokens: number;
};

export const UNPRICED_REASONS = ['model_not_in_catalog', 'no_rate_for_event_date', 'service_tier_or_context_not_priced', 'legacy_total_only'] as const;
export type UnpricedReason = typeof UNPRICED_REASONS[number];

export type PricingRow = {
  model: string; reasoning_effort: string; service_tier: string; catalog: CatalogKey | null;
  calls: number; total_tokens: number; input_tokens: number; cached_input_tokens: number; cache_write_input_tokens: number; output_tokens: number; reasoning_output_tokens: number;
  input_cost_usd: number; cached_input_cost_usd: number; cache_write_input_cost_usd: number; reasoning_output_cost_usd: number; other_output_cost_usd: number; estimated_cost_usd: number;
  priced_tokens: number; unpriced_tokens: number; unpriced_reasons: Partial<Record<UnpricedReason, number>>;
  long_context_calls: number; assumed_standard_calls: number; assumed_cache_write_ttl_calls: number; priority_at_standard_calls: number;
  pricing_service_tiers: string[]; rate_versions: string[];
};
export type PricingSeriesRow = PricingRow & { rate_date: string | null };
export type ApiEquivalentEstimate = {
  kind: 'api_equivalent_estimate'; currency: 'USD'; estimated_cost_usd: number; priced_tokens: number; unpriced_tokens: number; priced_token_coverage: number;
  component_costs_usd: { input_cost_usd: number; cached_input_cost_usd: number; cache_write_input_cost_usd: number; reasoning_output_cost_usd: number; other_output_cost_usd: number };
  missing_service_tier_calls_assumed_standard: number; assumed_cache_write_ttl_calls: number; priority_at_standard_calls: number;
  unpriced_reasons: Partial<Record<UnpricedReason, number>>;
  by_model: PricingRow[]; by_reasoning_effort: PricingRow[]; by_service_tier: PricingRow[]; by_model_effort_service_tier: PricingRow[];
  /** Daily source-price dates by model. Missing dates are gaps, not zero-cost days. */
  series: PricingSeriesRow[];
  pricing_catalog: { version: string; versions: Record<CatalogKey, string>; unit_tokens: number; long_context_threshold_tokens: Record<CatalogKey, number>; sources: { label: string; url: string }[]; provenance: Record<CatalogKey, string | null> };
  assumptions: string[];
};

const COST_FIELDS = ['input_cost_usd', 'cached_input_cost_usd', 'cache_write_input_cost_usd', 'reasoning_output_cost_usd', 'other_output_cost_usd'] as const;
const SUM_FIELDS = ['calls', 'total_tokens', 'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', ...COST_FIELDS, 'estimated_cost_usd',
  'priced_tokens', 'unpriced_tokens', 'long_context_calls', 'assumed_standard_calls', 'assumed_cache_write_ttl_calls', 'priority_at_standard_calls'] as const;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

const catalogKeys = (catalog: PricingCatalog): CatalogKey[] => Object.keys(catalog) as CatalogKey[];

/** Which catalog a provider's models price under; Cursor and unknown providers search every catalog. */
export function providerCatalogKey(provider: string | null): CatalogKey | null {
  if (provider === 'codex' || provider === 'openai_api') return 'openai';
  if (provider === 'claude' || provider === 'anthropic_api') return 'anthropic';
  if (provider === 'xai') return 'xai';
  return null;
}

export function catalogThresholds(catalog: PricingCatalog = pricingCatalog) {
  return { openai: catalog.openai.long_context_threshold_tokens, anthropic: catalog.anthropic.long_context_threshold_tokens, xai: catalog.xai.long_context_threshold_tokens };
}

/** The catalog a row prices under: the one holding its model, else the provider's default, else none. */
export function catalogForModel(provider: string | null, model: string | null, catalog: PricingCatalog = pricingCatalog): CatalogKey | null {
  const found = model === null ? null : findModel(catalog, provider, model);
  return found?.key ?? providerCatalogKey(provider);
}

/** The context band the catalog prices by, from a request's logged input compared against each catalog's threshold. */
export function contextBandFor(provider: string | null, model: string | null, over: { openai: boolean; anthropic: boolean; xai: boolean }, catalog: PricingCatalog = pricingCatalog): 'short' | 'long' {
  const key = catalogForModel(provider, model, catalog);
  return key !== null && over[key] ? 'long' : 'short';
}

/** Exact or alias match first, as the analyzer does; then a dated Claude id (`-YYYYMMDD`) matches its undated model. */
function findModel(catalog: PricingCatalog, provider: string | null, model: string): { key: CatalogKey; canonical: string; config: ModelConfig } | null {
  const normalized = model.trim().toLowerCase();
  const keys: CatalogKey[] = providerCatalogKey(provider) ? [providerCatalogKey(provider)!] : catalogKeys(catalog);
  const lookup = (name: string, within: CatalogKey[]) => {
    for (const key of within) {
      for (const [canonical, config] of Object.entries(catalog[key].models)) {
        if (name === canonical.toLowerCase() || (config.aliases ?? []).some(alias => alias.toLowerCase() === name)) return { key, canonical, config };
      }
    }
    return null;
  };
  const undated = normalized.replace(/-\d{8}$/, '');
  return lookup(normalized, keys) ?? (undated !== normalized && keys.includes('anthropic') ? lookup(undated, ['anthropic']) : null);
}

/** The analyzer's period rule: the latest period whose `[effective_from, effective_until)` contains the event date. */
function pricingPeriod(config: ModelConfig, eventDate: string) {
  const matches = config.periods.filter(period => (period.effective_from ?? '0000-01-01') <= eventDate && eventDate < (period.effective_until ?? '9999-12-31'));
  return matches.length ? matches.reduce((best, period) => ((period.effective_from ?? '') > (best.effective_from ?? '') ? period : best)) : null;
}

function normalizeTier(value: string | null): { tier: string; assumed: boolean } {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === '' || normalized === 'unknown' || normalized === 'assumed_standard') return { tier: 'standard', assumed: true };
  if (normalized === 'default' || normalized === 'standard') return { tier: 'standard', assumed: false };
  return { tier: normalized, assumed: false };
}

function emptyRow(model: string, effort: string, tier: string, catalog: CatalogKey | null): PricingRow {
  return { model, reasoning_effort: effort, service_tier: tier, catalog, calls: 0, total_tokens: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0,
    reasoning_output_tokens: 0, input_cost_usd: 0, cached_input_cost_usd: 0, cache_write_input_cost_usd: 0, reasoning_output_cost_usd: 0, other_output_cost_usd: 0, estimated_cost_usd: 0,
    priced_tokens: 0, unpriced_tokens: 0, unpriced_reasons: {}, long_context_calls: 0, assumed_standard_calls: 0, assumed_cache_write_ttl_calls: 0, priority_at_standard_calls: 0,
    pricing_service_tiers: [], rate_versions: [] };
}

/** Prices one input row and folds it into the dimension row it belongs to. */
function priceInto(target: PricingRow, row: PricingInputRow, catalog: PricingCatalog) {
  const inputTokens = row.input_fresh + row.input_cached + row.input_cache_write;
  const outputTokens = row.output;
  const total = row.total_tokens;
  // Token columns accumulate the row's own sums for every row, priced or not, as the analyzer's add_usage does;
  // the clamped component split below is used for costs only, as in price_token_event.
  target.calls += row.calls; target.total_tokens += total;
  target.input_tokens += inputTokens; target.cached_input_tokens += row.input_cached; target.cache_write_input_tokens += row.input_cache_write;
  target.output_tokens += outputTokens; target.reasoning_output_tokens += row.reasoning ?? 0;
  const cached = Math.min(inputTokens, Math.max(0, row.input_cached));
  const cacheWrite = Math.min(Math.max(0, inputTokens - cached), Math.max(0, row.input_cache_write));
  const uncached = Math.max(0, inputTokens - cached - cacheWrite);
  const reasoning = Math.min(outputTokens, Math.max(0, row.reasoning ?? 0));
  const otherOutput = Math.max(0, outputTokens - reasoning);
  const unpriced = (reason: UnpricedReason, tokens: number) => {
    target.unpriced_tokens += tokens;
    target.unpriced_reasons[reason] = (target.unpriced_reasons[reason] ?? 0) + tokens;
  };
  const found = row.model === null ? null : findModel(catalog, row.provider, row.model);
  if (!found) { unpriced('model_not_in_catalog', total); return; }
  const provider = catalog[found.key];
  const period = pricingPeriod(found.config, row.rate_date ?? '0000-01-01');
  if (!period) { unpriced('no_rate_for_event_date', total); return; }
  const { tier, assumed } = normalizeTier(row.service_tier);
  // Fast is chosen from the recorded speed where a catalog prices it per model: Anthropic's Opus 5.5, Opus 5
  // and Opus 4.8, and xAI's Grok 4.7 Fast. OpenAI reaches its fast tier through the priority alias instead.
  const fastRequested = (found.key === 'anthropic' || found.key === 'xai') && (row.speed ?? '').toLowerCase() === 'fast' && period.rates.fast;
  const pricingTier = fastRequested ? 'fast' : (period.service_tier_aliases?.[tier] ?? tier);
  if (found.key === 'anthropic' && tier === 'priority') target.priority_at_standard_calls += row.calls;
  const band = row.context_band ?? 'short';
  const rates = period.rates[pricingTier]?.[band];
  if (!target.pricing_service_tiers.includes(pricingTier)) target.pricing_service_tiers.push(pricingTier);
  if (period.rate_version && !target.rate_versions.includes(period.rate_version)) target.rate_versions.push(period.rate_version);
  if (assumed) target.assumed_standard_calls += row.calls;
  if (band === 'long') target.long_context_calls += row.calls;
  if (!rates) { unpriced('service_tier_or_context_not_priced', total); return; }
  const unit = provider.unit_tokens;
  const ttl = (row.cache_write_ttl ?? '').toLowerCase();
  const writeMultiplier = found.key === 'anthropic' && ttl === '1h' ? (found.config.cache_write_1h_input_multiplier ?? 2) : (found.config.cache_write_input_multiplier ?? 1);
  if (found.key === 'anthropic' && cacheWrite > 0 && ttl !== '1h' && ttl !== '5m') target.assumed_cache_write_ttl_calls += row.calls;
  target.input_cost_usd += uncached / unit * rates.input;
  target.cached_input_cost_usd += cached / unit * rates.cached_input;
  target.cache_write_input_cost_usd += cacheWrite / unit * rates.input * writeMultiplier;
  target.reasoning_output_cost_usd += reasoning / unit * rates.output;
  target.other_output_cost_usd += otherOutput / unit * rates.output;
  const priced = inputTokens + outputTokens;
  target.priced_tokens += priced;
  if (total > priced) unpriced('legacy_total_only', total - priced);
}

function finish(row: PricingRow): PricingRow {
  row.estimated_cost_usd = COST_FIELDS.reduce((sum, field) => sum + row[field], 0);
  for (const field of [...COST_FIELDS, 'estimated_cost_usd'] as const) row[field] = round6(row[field]);
  row.pricing_service_tiers.sort(); row.rate_versions.sort();
  return row;
}

function aggregate(rows: PricingRow[], key: 'model' | 'reasoning_effort' | 'service_tier'): PricingRow[] {
  const groups = new Map<string, PricingRow>();
  for (const row of rows) {
    const group = groups.get(row[key]) ?? emptyRow(key === 'model' ? row.model : '*', key === 'reasoning_effort' ? row.reasoning_effort : '*', key === 'service_tier' ? row.service_tier : '*', null);
    for (const field of SUM_FIELDS) group[field] += row[field];
    for (const [reason, tokens] of Object.entries(row.unpriced_reasons)) group.unpriced_reasons[reason as UnpricedReason] = (group.unpriced_reasons[reason as UnpricedReason] ?? 0) + tokens!;
    for (const tier of row.pricing_service_tiers) if (!group.pricing_service_tiers.includes(tier)) group.pricing_service_tiers.push(tier);
    for (const version of row.rate_versions) if (!group.rate_versions.includes(version)) group.rate_versions.push(version);
    group.catalog = group.calls === row.calls ? row.catalog : group.catalog === row.catalog ? group.catalog : null;
    groups.set(row[key], group);
  }
  return [...groups.values()].map(group => { for (const field of [...COST_FIELDS, 'estimated_cost_usd'] as const) group[field] = round6(group[field]); group.pricing_service_tiers.sort(); group.rate_versions.sort(); return group; })
    .sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd || b.total_tokens - a.total_tokens);
}

const GENERAL_ASSUMPTIONS = [
  'This is an API-equivalent estimate at public list prices, not a subscription bill, credit calculation, or invoice.',
  'Reasoning tokens are included in output tokens and use the model’s output-token rate; effort has no separate per-token surcharge.',
  'Missing service-tier metadata is assumed Standard and counted; unknown effort stays unknown.',
  'Tokens a record reports beyond its classified components stay unpriced (legacy_total_only); models, dates, tiers, or context bands the catalog does not cover stay unpriced with their reason.',
  'Separate tool-call, image, audio, web-search, regional-processing, Scale Tier, Reserved Tier, and subscription-credit charges are excluded.',
  'Rate periods are chosen by each request\u2019s calendar date in America/Chicago, the analyzers\u2019 machine-local zone; the display zone never changes a price.',
];
const OPENAI_ASSUMPTIONS = [
  'Recorded priority requests use Priority rates before July 30, 2026 and Fast rates on or after that date.',
  'For pre-July 30 GPT-5.6 Priority traffic, the estimate applies the then-current 2.5x Priority multiplier.',
  'Per-request long-context rates apply when logged input exceeds 272K tokens.',
];
const XAI_ASSUMPTIONS = [
  'xAI rates are the public list prices read on September 17, 2026, with Grok 4.7 added from them on September 22, 2026, and are applied to a request of any date; price changes before that date are not modeled.',
  'Per-request long-context rates apply when logged input reaches 200K tokens.',
  'Priority is priced at 2x standard list rates as published; batch, regional, and server-side tool-invocation surcharges are excluded.',
  'Grok 4.7 Fast, sold only through Cursor and Grok Build, prices from its own published table when a request records fast speed; Cursor does not record speed for Grok today, so such requests price at standard.',
];
const ANTHROPIC_ASSUMPTIONS = [
  'Anthropic rates are the public list prices read on September 14, 2026 and re-verified on September 22, 2026, when Opus 5.5 was added, and are applied to a request of any date; price changes before that date are not modeled.',
  'Cache reads use each model’s cache-hit rate; cache writes use the 5-minute (1.25x) or 1-hour (2x) rate as recorded, and an unrecorded TTL is assumed 5-minute and counted.',
  'Batch is priced at 50% with cache multipliers stacked; priority is priced at standard list rates and flagged; flex is left unpriced; fast applies to Opus 5.5, Opus 5, and Opus 4.8 from the recorded speed.',
  'Claude 4.6 and later bill the full context window at standard rates, so their requests over 200K input price at the same rates; the long-context premium of earlier models is not modeled and their requests over 200K input stay unpriced.',
  'Dated Claude model ids (a trailing -YYYYMMDD) price as their undated model.',
];

function pricedDimensionRows(inputs: PricingInputRow[], catalog: PricingCatalog) {
  const dimensions = new Map<string, PricingRow>();
  for (const input of inputs) {
    const model = input.model ?? 'unknown', effort = input.reasoning_effort ?? 'unknown', tier = input.service_tier ?? 'assumed_standard';
    const found = input.model === null ? null : findModel(catalog, input.provider, input.model);
    const key = `${model}\0${effort}\0${tier}`;
    const row = dimensions.get(key) ?? emptyRow(model, effort, tier, found?.key ?? null);
    priceInto(row, input, catalog);
    dimensions.set(key, row);
  }
  return [...dimensions.values()].map(finish).sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd || b.total_tokens - a.total_tokens);
}

function priceSeries(inputs: PricingInputRow[], catalog: PricingCatalog): PricingSeriesRow[] {
  const groups = new Map<string, { rateDate: string | null; rows: PricingInputRow[] }>();
  for (const input of inputs) {
    const model = input.model ?? 'unknown';
    const key = `${input.rate_date ?? 'unknown'}\0${model}`;
    const group = groups.get(key) ?? { rateDate: input.rate_date, rows: [] };
    group.rows.push(input);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => aggregate(pricedDimensionRows(group.rows, catalog), 'model').map(row => ({ ...row, rate_date: group.rateDate })))
    .sort((a, b) => (a.rate_date ?? '').localeCompare(b.rate_date ?? '') || a.model.localeCompare(b.model));
}

/** Prices grouped request detail and returns the analyzer-shaped estimate with its catalog provenance. */
export function priceUsage(inputs: PricingInputRow[], catalog: PricingCatalog = pricingCatalog): ApiEquivalentEstimate {
  const rows = pricedDimensionRows(inputs, catalog);
  const sum = (field: typeof SUM_FIELDS[number]) => rows.reduce((total, row) => total + row[field], 0);
  const unpricedReasons: Partial<Record<UnpricedReason, number>> = {};
  for (const row of rows) for (const [reason, tokens] of Object.entries(row.unpriced_reasons)) unpricedReasons[reason as UnpricedReason] = (unpricedReasons[reason as UnpricedReason] ?? 0) + tokens!;
  const priced = sum('priced_tokens'), unpriced = sum('unpriced_tokens');
  const used = new Set(rows.map(row => row.catalog).filter((key): key is CatalogKey => key !== null));
  return {
    kind: 'api_equivalent_estimate', currency: 'USD', estimated_cost_usd: round6(sum('estimated_cost_usd')), priced_tokens: priced, unpriced_tokens: unpriced,
    priced_token_coverage: priced + unpriced > 0 ? priced / (priced + unpriced) : 0,
    component_costs_usd: Object.fromEntries(COST_FIELDS.map(field => [field, round6(sum(field))])) as ApiEquivalentEstimate['component_costs_usd'],
    missing_service_tier_calls_assumed_standard: sum('assumed_standard_calls'), assumed_cache_write_ttl_calls: sum('assumed_cache_write_ttl_calls'), priority_at_standard_calls: sum('priority_at_standard_calls'),
    unpriced_reasons: unpricedReasons,
    by_model: aggregate(rows, 'model'), by_reasoning_effort: aggregate(rows, 'reasoning_effort'), by_service_tier: aggregate(rows, 'service_tier'), by_model_effort_service_tier: rows,
    series: priceSeries(inputs, catalog),
    pricing_catalog: {
      version: catalogKeys(catalog).map(key => `${key} ${catalog[key].catalog_version}`).join('; '),
      versions: Object.fromEntries(catalogKeys(catalog).map(key => [key, catalog[key].catalog_version])) as Record<CatalogKey, string>,
      unit_tokens: catalog.openai.unit_tokens, long_context_threshold_tokens: catalogThresholds(catalog),
      sources: catalogKeys(catalog).flatMap(key => catalog[key].sources),
      provenance: Object.fromEntries(catalogKeys(catalog).map(key => [key, catalog[key].provenance ?? null])) as Record<CatalogKey, string | null>,
    },
    assumptions: [...GENERAL_ASSUMPTIONS, ...(used.has('openai') || !used.size ? OPENAI_ASSUMPTIONS : []), ...(used.has('anthropic') || !used.size ? ANTHROPIC_ASSUMPTIONS : []), ...(used.has('xai') || !used.size ? XAI_ASSUMPTIONS : [])],
  };
}
