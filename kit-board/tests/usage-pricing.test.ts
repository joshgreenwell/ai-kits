import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogThresholds, contextBandFor, priceUsage, pricingCatalog, type PricingInputRow } from '../lib/usage-pricing';

const row = (overrides: Partial<PricingInputRow>): PricingInputRow => ({
  provider: 'codex', model: 'gpt-5.6-sol', reasoning_effort: 'high', service_tier: 'priority', speed: null, context_window_tokens: null, cache_write_ttl: null, token_state: 'complete',
  context_band: 'short', rate_date: '2026-09-05', calls: 1, input_fresh: 1_000_000, input_cached: 0, input_cache_write: 0, output: 100_000, reasoning: 20_000, unclassified: 0, total_tokens: 1_100_000, ...overrides,
});

test('the catalog is the analyzer’s, with the Anthropic list prices beside it', () => {
  assert.equal(pricingCatalog.openai.catalog_version, '2026-09-13');
  assert.deepEqual(catalogThresholds(), { openai: 272000, anthropic: 200000 });
  // The band follows the catalog the model prices under, not the provider that observed it.
  const between = { openai: false, anthropic: true };   // logged input between 200,001 and 272,000
  assert.deepEqual([contextBandFor('cursor', 'claude-sonnet-4-5', between), contextBandFor('cursor', 'gpt-5.6-sol', between), contextBandFor('codex', 'gpt-5.6-sol', between), contextBandFor('claude', 'unknown-model', between), contextBandFor(null, 'unknown-model', between)],
    ['long', 'short', 'short', 'long', 'short']);
  assert.equal(pricingCatalog.openai.models['gpt-5.6-sol'].periods[1].rates.fast.short.input, 10);
  assert.equal(pricingCatalog.anthropic.models['claude-fable-5-1'].periods[0].rates.standard.short.cached_input, 0.25, 'Fable 5.1 cache reads at 0.025x');
  // Every Anthropic model that bills the full window carries a long band equal to its short band on every tier; every other model has none.
  for (const [name, config] of Object.entries(pricingCatalog.anthropic.models)) {
    for (const period of config.periods) for (const [tier, bands] of Object.entries(period.rates)) {
      if (config.full_context_window_at_standard_rates) assert.deepEqual(bands.long, bands.short, `${name} ${tier} long band equals short`);
      else assert.equal(bands.long, undefined, `${name} ${tier} has no long band`);
      if (tier === 'batch') assert.deepEqual(bands.short, { input: period.rates.standard.short.input / 2, cached_input: period.rates.standard.short.cached_input / 2, output: period.rates.standard.short.output / 2 }, `${name} batch is half of standard`);
    }
    assert.equal(!!config.periods[0].rates.fast, name === 'claude-opus-5' || name === 'claude-opus-4-8', `${name} fast tier only on Opus 5 and Opus 4.8`);
  }
});

test('OpenAI rows price by period, tier alias, context band, and reasoning inside output', () => {
  const fast = priceUsage([row({})]);
  const dimension = fast.by_model_effort_service_tier[0];
  assert.deepEqual([dimension.pricing_service_tiers, dimension.rate_versions, dimension.estimated_cost_usd], [['fast'], ['gpt-5.6-2026-07-30'], 16], 'priority after July 30 is Fast: $10 input plus $60 output on 100k output');
  assert.deepEqual([dimension.reasoning_output_cost_usd, dimension.other_output_cost_usd, dimension.priced_tokens, dimension.unpriced_tokens], [1.2, 4.8, 1_100_000, 0]);
  const launch = priceUsage([row({ rate_date: '2026-07-15' })]).by_model_effort_service_tier[0];
  assert.deepEqual([launch.pricing_service_tiers, launch.estimated_cost_usd], [['priority'], 20], 'before July 30 the 2.5x Priority rates apply');
  const long = priceUsage([row({ context_band: 'long', service_tier: 'standard' })]).by_model_effort_service_tier[0];
  assert.deepEqual([long.long_context_calls, long.estimated_cost_usd], [1, 10 + 4.5], 'long-context rates when logged input exceeds the threshold');
  const assumed = priceUsage([row({ service_tier: null })]);
  assert.deepEqual([assumed.missing_service_tier_calls_assumed_standard, assumed.by_model_effort_service_tier[0].service_tier, assumed.estimated_cost_usd], [1, 'assumed_standard', 8], 'a missing tier is Standard and counted');
  const written = priceUsage([row({ service_tier: 'standard', input_fresh: 0, input_cached: 400_000, input_cache_write: 600_000, output: 0, reasoning: null, total_tokens: 1_000_000 })]).by_model_effort_service_tier[0];
  assert.deepEqual([written.cached_input_cost_usd, written.cache_write_input_cost_usd], [0.2, 3.75], 'cache reads at the cached rate and cache writes at 1.25x input');
});

test('unpriced activity stays visible with its reason', () => {
  const estimate = priceUsage([
    row({ model: 'mystery-model', total_tokens: 500 }),
    row({ model: 'gpt-6-astra', rate_date: '2026-09-01', total_tokens: 700 }),
    row({ provider: 'claude', model: 'claude-sonnet-5', service_tier: 'flex', total_tokens: 900 }),
    row({ service_tier: 'standard', total_tokens: 1_200_000 }),
    row({ model: null, total_tokens: 11 }),
  ]);
  assert.deepEqual(estimate.unpriced_reasons, { model_not_in_catalog: 511, no_rate_for_event_date: 700, service_tier_or_context_not_priced: 900, legacy_total_only: 100_000 });
  assert.deepEqual([estimate.priced_tokens, estimate.unpriced_tokens, estimate.estimated_cost_usd], [1_100_000, 102_111, 8]);
  assert.ok(estimate.priced_token_coverage > 0.9 && estimate.priced_token_coverage < 1);
});

test('Anthropic rows reproduce the Mac analyzer’s Opus 5 and Fable 5.1 rows and honor batch, fast, priority, and TTL rules', () => {
  const opus = priceUsage([
    row({ provider: 'claude', model: 'claude-opus-5', reasoning_effort: null, service_tier: 'standard', cache_write_ttl: '5m', input_fresh: 6_440, input_cached: 279_509_506, input_cache_write: 5_668_885, output: 2_427_015, reasoning: 0, total_tokens: 287_611_846 }),
    row({ provider: 'claude', model: 'claude-opus-5', reasoning_effort: null, service_tier: 'standard', cache_write_ttl: '1h', input_fresh: 0, input_cached: 0, input_cache_write: 3_210_652, output: 0, reasoning: 0, total_tokens: 3_210_652 }),
  ]);
  const model = opus.by_model.find(m => m.model === 'claude-opus-5')!;
  assert.equal(model.estimated_cost_usd, 267.999379, 'matches the stored September report row to the cent and beyond');
  assert.deepEqual([model.input_cost_usd, model.cached_input_cost_usd, model.cache_write_input_cost_usd, model.other_output_cost_usd], [0.0322, 139.754753, 67.537051, 60.675375]);
  assert.deepEqual([model.priced_tokens, model.unpriced_tokens, model.input_tokens, model.output_tokens, model.cached_input_tokens, model.cache_write_input_tokens], [290_822_498, 0, 288_395_483, 2_427_015, 279_509_506, 8_879_537], 'token columns match the stored row');
  const fable = priceUsage([row({ provider: 'claude', model: 'claude-fable-5-1', service_tier: 'standard', input_fresh: 0, input_cached: 92_106_355, input_cache_write: 0, output: 0, reasoning: 0, total_tokens: 92_106_355 })]);
  assert.equal(fable.by_model[0].cached_input_cost_usd, 23.026589);
  const batch = priceUsage([row({ provider: 'claude', model: 'claude-sonnet-5', service_tier: 'batch', reasoning: 0, total_tokens: 1_100_000 })]).by_model[0];
  assert.equal(batch.estimated_cost_usd, 1 + 0.5, 'batch halves input and output');
  const fastOpus = priceUsage([row({ provider: 'claude', model: 'claude-opus-4-8', service_tier: 'standard', speed: 'fast', reasoning: 0, total_tokens: 1_100_000 })]).by_model_effort_service_tier[0];
  assert.deepEqual([fastOpus.pricing_service_tiers, fastOpus.estimated_cost_usd], [['fast'], 10 + 5]);
  const fastSonnet = priceUsage([row({ provider: 'claude', model: 'claude-sonnet-5', service_tier: 'standard', speed: 'fast', reasoning: 0, total_tokens: 1_100_000 })]).by_model_effort_service_tier[0];
  assert.deepEqual([fastSonnet.pricing_service_tiers, fastSonnet.estimated_cost_usd], [['standard'], 2 + 1], 'a model without fast rates prices at standard');
  const priority = priceUsage([row({ provider: 'claude', model: 'claude-sonnet-5', service_tier: 'priority', reasoning: 0, total_tokens: 1_100_000 })]);
  assert.deepEqual([priority.priority_at_standard_calls, priority.estimated_cost_usd], [1, 3]);
  const assumedTtl = priceUsage([row({ provider: 'claude', model: 'claude-sonnet-5', service_tier: 'standard', input_fresh: 0, input_cache_write: 1_000_000, output: 0, reasoning: 0, total_tokens: 1_000_000 })]);
  assert.deepEqual([assumedTtl.assumed_cache_write_ttl_calls, assumedTtl.estimated_cost_usd], [1, 2.5]);
  assert.ok(opus.assumptions.some(a => a.includes('Anthropic rates')) && !opus.assumptions.some(a => a.includes('July 30')), 'assumptions follow the catalogs actually used');
  // Claude 4.6 and later bill the full window at standard rates; earlier models' long-context premium is not modeled.
  const longOpus = priceUsage([row({ provider: 'claude', model: 'claude-opus-5', service_tier: 'standard', context_band: 'long', input_fresh: 300_000, output: 1_000, reasoning: 0, total_tokens: 301_000 })]);
  assert.deepEqual([longOpus.estimated_cost_usd, longOpus.unpriced_tokens, longOpus.by_model[0].long_context_calls], [1.525, 0, 1]);
  const longSonnet45 = priceUsage([row({ provider: 'claude', model: 'claude-sonnet-4-5', service_tier: 'standard', context_band: 'long', input_fresh: 300_000, output: 1_000, reasoning: 0, total_tokens: 301_000 })]);
  assert.deepEqual([longSonnet45.estimated_cost_usd, longSonnet45.unpriced_reasons], [0, { service_tier_or_context_not_priced: 301_000 }]);
  const longBatch = priceUsage([row({ provider: 'claude', model: 'claude-sonnet-4-6', service_tier: 'batch', context_band: 'long', input_fresh: 300_000, output: 1_000, reasoning: 0, total_tokens: 301_000 })]);
  assert.equal(longBatch.estimated_cost_usd, (300_000 * 1.5 + 1_000 * 7.5) / 1e6, 'batch long is half of standard');
  const longFast = priceUsage([row({ provider: 'claude', model: 'claude-opus-5', service_tier: 'standard', speed: 'fast', context_band: 'long', input_fresh: 300_000, output: 1_000, reasoning: 0, total_tokens: 301_000 })]);
  assert.deepEqual([longFast.by_model_effort_service_tier[0].pricing_service_tiers, longFast.estimated_cost_usd], [['fast'], (300_000 * 10 + 1_000 * 50) / 1e6], 'fast long is the fast rate');
  // Dated Claude ids price as their undated model, through the aliases or the date suffix.
  const dated = priceUsage([row({ provider: 'claude', model: 'claude-haiku-4-5-20251001', service_tier: 'standard', reasoning: 0, total_tokens: 1_100_000 }),
    row({ provider: 'claude', model: 'claude-sonnet-5-20260301', service_tier: 'standard', reasoning: 0, total_tokens: 1_100_000 }), row({ provider: 'claude', model: 'claude-3-5-haiku-20241022', service_tier: 'standard', reasoning: 0, total_tokens: 1_100_000 })]);
  assert.deepEqual(dated.by_model.map(m => [m.model, m.estimated_cost_usd]).sort(), [['claude-3-5-haiku-20241022', 1.2], ['claude-haiku-4-5-20251001', 1.5], ['claude-sonnet-5-20260301', 3]]);
  // The dated retry never reaches the OpenAI catalog, whatever the provider.
  const datedOpenAi = priceUsage([row({ model: 'gpt-5.5-20260423', total_tokens: 100 }), row({ provider: 'cursor', model: 'gpt-5.5-20260423', total_tokens: 100 }), row({ provider: null, model: 'gpt-5.6-sol-20260901', total_tokens: 100 })]);
  assert.deepEqual([datedOpenAi.estimated_cost_usd, datedOpenAi.unpriced_reasons], [0, { model_not_in_catalog: 300 }]);
  // A single undated period prices a request of any date.
  assert.equal(priceUsage([row({ provider: 'claude', model: 'claude-opus-5', service_tier: 'standard', reasoning: 0, rate_date: '2025-12-15', total_tokens: 1_100_000 })]).estimated_cost_usd, 7.5);
});

test('unpriced rows keep their token columns, as the analyzer’s rows do', () => {
  const [unknown] = priceUsage([row({ model: 'mystery-model', input_fresh: 800, input_cached: 200, output: 100, reasoning: 40, total_tokens: 1_100 })]).by_model;
  assert.deepEqual([unknown.input_tokens, unknown.cached_input_tokens, unknown.output_tokens, unknown.reasoning_output_tokens, unknown.total_tokens, unknown.unpriced_tokens], [1_000, 200, 100, 40, 1_100, 1_100]);
  const [flex] = priceUsage([row({ provider: 'claude', model: 'claude-sonnet-5', service_tier: 'flex', input_fresh: 800, input_cached: 200, output: 100, reasoning: 40, total_tokens: 1_100 })]).by_model;
  assert.deepEqual([flex.input_tokens, flex.cached_input_tokens, flex.output_tokens, flex.reasoning_output_tokens, flex.unpriced_reasons], [1_000, 200, 100, 40, { service_tier_or_context_not_priced: 1_100 }]);
  // Columns are the row's own sums; the clamped split applies to costs only, as in the analyzer.
  const [over] = priceUsage([row({ service_tier: 'standard', output: 100, reasoning: 150, total_tokens: 1_000_100 })]).by_model;
  assert.deepEqual([over.reasoning_output_tokens, over.reasoning_output_cost_usd, over.other_output_cost_usd], [150, 0.003, 0]);
});

test('the Windows analyzer’s stored September dimension rows are reproduced', () => {
  // Two by_model_effort_service_tier rows from the stored pc-workstation report: priority after July 30 prices as Fast, default as Standard.
  const estimate = priceUsage([
    row({ model: 'gpt-5.6-sol', reasoning_effort: 'xhigh', service_tier: 'priority', calls: 2850, input_fresh: 9_430_909, input_cached: 380_696_064, input_cache_write: 0, output: 1_343_442, reasoning: 503_345, total_tokens: 392_059_692 }),
    row({ model: 'gpt-6-astra', reasoning_effort: 'high', service_tier: 'default', calls: 1508, input_fresh: 8_490_224, input_cached: 197_178_112, input_cache_write: 0, output: 1_073_937, reasoning: 243_605, total_tokens: 207_083_007 }),
  ]);
  const sol = estimate.by_model_effort_service_tier.find(r => r.model === 'gpt-5.6-sol')!, astra = estimate.by_model_effort_service_tier.find(r => r.model === 'gpt-6-astra')!;
  assert.deepEqual([sol.input_cost_usd, sol.cached_input_cost_usd, sol.reasoning_output_cost_usd, sol.other_output_cost_usd, sol.estimated_cost_usd, sol.priced_tokens, sol.unpriced_tokens, sol.pricing_service_tiers, sol.rate_versions],
    [94.30909, 380.696064, 30.2007, 50.40582, 555.611674, 391_470_415, 589_277, ['fast'], ['gpt-5.6-2026-07-30']]);
  assert.deepEqual([astra.input_cost_usd, astra.cached_input_cost_usd, astra.reasoning_output_cost_usd, astra.other_output_cost_usd, astra.estimated_cost_usd, astra.priced_tokens, astra.unpriced_tokens, astra.pricing_service_tiers, astra.rate_versions],
    [84.90224, 197.178112, 12.18025, 41.5166, 335.777202, 206_742_273, 340_734, ['standard'], ['gpt-6-astra-2026-09-13']]);
  assert.deepEqual([estimate.estimated_cost_usd, estimate.unpriced_reasons], [891.388876, { legacy_total_only: 930_011 }]);
});

test('aggregations reconcile to the dimension rows and the catalog provenance travels with the estimate', () => {
  const estimate = priceUsage([row({}), row({ reasoning_effort: 'low', service_tier: 'standard' }), row({ provider: 'claude', model: 'claude-opus-5', service_tier: 'standard', reasoning: 0 })]);
  const total = (rows: { estimated_cost_usd: number }[]) => Math.round(rows.reduce((n, r) => n + r.estimated_cost_usd, 0) * 1e6) / 1e6;
  assert.deepEqual([total(estimate.by_model), total(estimate.by_reasoning_effort), total(estimate.by_service_tier), total(estimate.by_model_effort_service_tier)], Array(4).fill(estimate.estimated_cost_usd));
  assert.equal(estimate.by_model.find(m => m.model === 'gpt-5.6-sol')?.calls, 2);
  assert.deepEqual(estimate.pricing_catalog.versions, { openai: '2026-09-13', anthropic: '2026-09-14' });
  assert.ok(estimate.pricing_catalog.sources.length >= 8 && estimate.pricing_catalog.provenance.openai?.includes('verbatim'));
});
