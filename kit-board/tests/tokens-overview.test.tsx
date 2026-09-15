import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokensOverview } from '@/components/tokens-overview';
import { CostModelTable, ModelSummaryTable } from '@/components/usage-insight-cards';
import { UsageSeriesChart } from '@/components/usage-series-chart';
import type { UsageQueryResult } from '@/lib/usage-query';
import { DEFAULT_FILTERS, compositionView, seriesSummary } from '@/lib/usage-view';

const composition = (fresh: number, cached: number, write: number, output: number, reasoning: number | null, unclassified = 0) => ({ input_fresh: fresh, input_cached: cached, input_cache_write: write, output, reasoning, unclassified });
const point = (start: string, end: string, tokens: number, calls: number, state: UsageQueryResult['series']['points'][number]['state'], sources: ('buckets' | 'requests' | 'snapshot')[] = ['buckets']) =>
  ({ start, end, total_tokens: tokens, calls, composition: composition(tokens, 0, 0, 0, null), state, sources });
const coverage = (headline: number, eligible: number, classified: number, unit: 'tokens' | 'calls' | 'invocations' = 'tokens') =>
  ({ unit, headline, eligible, classified, applicable: headline ? eligible / headline : 0, complete: eligible ? classified / eligible : 0, note: '' });
const priced = (overrides: Partial<UsageQueryResult['cost']['by_model'][number]> = {}): UsageQueryResult['cost']['by_model'][number] => ({
  model: 'm1', reasoning_effort: '*', service_tier: '*', catalog: 'openai', calls: 7, total_tokens: 1_400, input_tokens: 1_000, cached_input_tokens: 200, cache_write_input_tokens: 100,
  output_tokens: 400, reasoning_output_tokens: 150, input_cost_usd: 0.5, cached_input_cost_usd: 0.1, cache_write_input_cost_usd: 0.15, reasoning_output_cost_usd: 0.25,
  other_output_cost_usd: 0.25, estimated_cost_usd: 1.25, priced_tokens: 1_200, unpriced_tokens: 200, unpriced_reasons: { legacy_total_only: 200 },
  long_context_calls: 0, assumed_standard_calls: 2, assumed_cache_write_ttl_calls: 0, priority_at_standard_calls: 0, pricing_service_tiers: ['standard'], rate_versions: ['fixture-v1'], ...overrides,
});

/** A synthetic query result the way the layer returns it: two accounts, one project, a merged snapshot, one uncovered day, one partial day. */
function synthetic(): UsageQueryResult {
  const points = [
    point('2026-09-01T05:00:00.000Z', '2026-09-02T05:00:00.000Z', 1_000, 4, 'observed'),
    point('2026-09-02T05:00:00.000Z', '2026-09-03T05:00:00.000Z', 0, 0, 'zero'),
    point('2026-09-03T05:00:00.000Z', '2026-09-04T05:00:00.000Z', 0, 0, 'missing', []),
    point('2026-09-04T05:00:00.000Z', '2026-09-05T05:00:00.000Z', 600, 2, 'observed', ['snapshot']),
    point('2026-09-05T05:00:00.000Z', '2026-09-05T20:30:00.000Z', 400, 3, 'partial'),
  ];
  const empty = coverage(0, 0, 0);
  return {
    as_of: '2026-09-05T20:30:00.000Z',
    scope: { range: { preset: 'month_to_date', start: '2026-09-01T05:00:00.000Z', end: '2026-09-05T20:30:00.000Z', timezone: 'America/Chicago', anchored_to_now: true, resolution: 'day' },
      accounts: [{ id: 'claude-a', provider: 'claude', label: 'Claude personal' }, { id: 'codex-b', provider: 'codex', label: 'Codex primary' }],
      machines: [{ id: '11111111-1111-4111-8111-111111111111', account_id: 'claude-a', machine_label: 'desk', mode: 'companion' }],
      filters: { accounts: [], providers: [], models: [], efforts: [], machines: [], surfaces: [], projects: [], agent_scope: 'all', agents: [] }, detail_filters: [] },
    headline: { total_tokens: 2_000, calls: 9, conversations: 5, composition: composition(900, 500, 100, 400, 150, 50), basis: 'buckets', unfilterable_tokens: 0, unfilterable_calls: 0, uncovered_request_tokens: 0,
      snapshot_tokens: 600, snapshot_calls: 2, last_observation: '2026-09-05T20:00:00.000Z' },
    series: { resolution: 'day', points, excludes_snapshot_tokens: 0 },
    by_model: [{ model: 'm1', total_tokens: 1_400, calls: 7, composition: composition(1_400, 0, 0, 0, null), share: 0.7, basis: 'buckets' }],
    model_series: [{ model: 'm1', points: [{ start: points[0].start, total_tokens: 1_000, calls: 4 }, { start: points[4].start, total_tokens: 400, calls: 3 }] }],
    pricing_inputs: { rows: [], coverage: coverage(2_000, 1_400, 1_400), note: 'fixture pricing coverage' },
    projects: { rows: [], coverage: empty, registry: empty },
    agents: { rows: [], summary: { main_tokens: 0, subagent_tokens: 0, unattributed_tokens: 0, observed_children: 0, spawns: 0, by_class: {} }, coverage: empty },
    tools: { invocations: 0, by_tool: [], by_caller: [], by_outcome: {}, caller_coverage: coverage(0, 0, 0, 'invocations'), outcome_coverage: coverage(0, 0, 0, 'invocations'), unsupported_filters: [] },
    knowledge: { rows: [], distinct_invocations: 0, note: '' },
    environmental_inputs: { cohorts: [], coverage: coverage(9, 9, 9, 'calls'), note: '' },
    cost: { kind: 'api_equivalent_estimate', currency: 'USD', estimated_cost_usd: 1.25, priced_tokens: 1_200, unpriced_tokens: 200, priced_token_coverage: 1_200 / 1_400,
      component_costs_usd: { input_cost_usd: 0.5, cached_input_cost_usd: 0.1, cache_write_input_cost_usd: 0.15, reasoning_output_cost_usd: 0.25, other_output_cost_usd: 0.25 },
      missing_service_tier_calls_assumed_standard: 2, assumed_cache_write_ttl_calls: 0, priority_at_standard_calls: 0, unpriced_reasons: { legacy_total_only: 200 },
      by_model: [priced()], by_reasoning_effort: [priced({ model: '*', reasoning_effort: 'high' })], by_service_tier: [priced({ model: '*', service_tier: 'assumed_standard' })],
      by_model_effort_service_tier: [priced({ reasoning_effort: 'high', service_tier: 'assumed_standard' })],
      series: [
        { ...priced({ calls: 4, total_tokens: 1_000, priced_tokens: 900, unpriced_tokens: 100, estimated_cost_usd: 0.8 }), rate_date: '2026-09-01' },
        { ...priced({ calls: 3, total_tokens: 400, priced_tokens: 300, unpriced_tokens: 100, estimated_cost_usd: 0.45 }), rate_date: '2026-09-05' },
      ],
      pricing_catalog: { version: 'fixture-v1', versions: { openai: 'fixture-v1', anthropic: 'fixture-v1' }, unit_tokens: 1_000_000, long_context_threshold_tokens: { openai: 272000, anthropic: 200000 }, sources: [{ label: 'Fixture catalog', url: 'https://example.test/catalog' }], provenance: { openai: 'fixture', anthropic: null } }, assumptions: ['Fixture pricing assumption.'] },
    environment: { kind: 'inference_equivalent_scenario_estimate', methodology_version: '2026-08-20.1', methodology_versions: ['2026-08-20.1'], confidence: 'low',
      basis: { model_calls: 9, raw_tokens: 2_000, average_raw_tokens_per_call: 222, cohorts: [], classification_unit: '', long_context_upper_wh_per_call: 33, planning_context_threshold_tokens_per_call: 50_000 },
      energy_kwh: { efficient_production_floor: 0.00216, planning: 0.00306, long_context_upper: 0.297 }, direct_water_liters: { efficient_production_floor: 0.00234, planning: 0.000918, long_context_upper: 0.5643 }, operational_co2_kg: { clean_energy_floor: 0.00027, planning_us_grid: 0.001206, long_context_us_grid: 0.117018 },
      scenarios: [], comparisons_at_planning_scenario: { average_showers: 0, us_home_days_of_electricity: 0, smartphone_full_charges: 0, urban_tree_seedlings_grown_10_years: 0, average_gasoline_vehicle_miles: 0 },
      reduction_if_calls_drop_10_percent: { calls_avoided: 0.9, energy_kwh_avoided: 0.000306, direct_water_liters_avoided: 0.000092, operational_co2_kg_avoided: 0.000121 }, compensation_planning: { operational_co2_kg_to_cover: 0.117018, note: '' },
      coverage: { calls_estimated: 9, calls_headline: 9, calls_without_class: 0, cohorts_provisional: 0, cohorts_stored: 0, note: '' }, scope: '', assumptions: [], sources: [] },
    historical: { snapshots: [
      { subject_key: 'legacy-box', machine_name: 'Legacy box', month: '2026-09', status: 'partial', produced_at: null, account_id: 'claude-a', source_timezone: 'America/Chicago', total_tokens: 600, calls: 2, threads: null, daily_rows: 1, merged: 'days', reason: null, merged_tokens: 600, merged_calls: 2, methodology_version: '2026-08-20.1', pricing_catalog: null, estimated_cost_usd: null },
      { subject_key: 'other-box', machine_name: null, month: '2026-09', status: 'complete', produced_at: null, account_id: null, source_timezone: null, total_tokens: 50, calls: 1, threads: null, daily_rows: 0, merged: 'none', reason: 'subject_not_mapped', merged_tokens: 0, merged_calls: 0, methodology_version: null, pricing_catalog: null, estimated_cost_usd: null },
    ], note: '' },
    request_detail: { covered_tokens: 500, covered_calls: 2, coverage: coverage(2_000, 2_000, 500) },
    unsupported: ['Monthly snapshots cannot be placed on an hourly series.'], notes: ['2 hourly bucket(s) straddling a range edge are excluded rather than prorated.'],
  };
}

const vocabulary = { accounts: [{ value: 'claude-a', label: 'Claude personal' }, { value: 'codex-b', label: 'Codex primary' }], projects: [{ value: 'p1', label: 'Kit board' }], machines: [], models: [{ value: 'm1', label: 'm1' }], efforts: [] };
const render = (props: Partial<Parameters<typeof TokensOverview>[0]> = {}) => renderToStaticMarkup(
  <TokensOverview filters={DEFAULT_FILTERS} onFiltersChange={() => {}} result={synthetic()} vocabulary={vocabulary} error={null} stale={false} loading={false} onRetry={() => {}} now={Date.parse('2026-09-05T20:30:00.000Z')} {...props} />,
);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');

test('the rendered headline, composition, and series agree with the query result', () => {
  const result = synthetic();
  const html = render();
  const body = text(html);
  assert.match(body, /Observed tokens in the selected scope 2K/, 'the compact headline');
  assert.match(body, /Exact total 2,000 tokens/, 'the exact total');
  assert.match(body, /Model calls 9/); assert.match(body, /Conversations 5/);
  assert.match(body, /Last observation Sep 5, 3:00 PM 30 min ago · America\/Chicago/, 'last observation in the display zone, relative to now');
  const view = compositionView(result.headline);
  for (const segment of view.segments) assert.match(html, new RegExp(`composition-${segment.key}[^>]*>${segment.tokens.toLocaleString('en-US')} `), `${segment.key} count is rendered`);
  assert.match(body, /Fresh input 900 45%/); assert.match(body, /Cached input 500 25%/); assert.match(body, /Cache-write input 100 5\.0%/); assert.match(body, /Output 400 20%/); assert.match(body, /Unclassified 100 5\.0%/, 'the 50 reported-only tokens join the 50 unclassified');
  assert.equal(view.segments.reduce((n, s) => n + s.tokens, 0), result.headline.total_tokens, 'the legend reconciles to the headline');
  assert.match(body, /Reasoning is 150 of the output tokens \(38%\) and is not added again/);
  const summary = seriesSummary(result.series.points);
  assert.match(body, /5 intervals · 2 observed · 1 recorded as zero · 1 without collector coverage · 1 still being observed\. Bars sum to 2,000 tokens/);
  assert.equal(summary.total, result.headline.total_tokens - 0, 'day sums equal the headline when nothing is excluded from the series');
  assert.match(html, /aria-label="Tue, Sep 1: 1,000 tokens, 4 calls, observed"[^>]*tabindex="0"/, 'each bar names its interval and exact values; the first is the one tab stop');
  assert.match(html, /aria-label="Wed, Sep 2: 0 tokens, 0 calls, no activity recorded"[^>]*tabindex="-1"/, 'the other bars are reached with the arrow keys');
  assert.match(html, /aria-label="Thu, Sep 3: 0 tokens, 0 calls, no collector coverage"/);
  assert.match(html, /aria-label="Sat, Sep 5 · 00:00 to 15:30: 400 tokens, 3 calls, still being observed"/, 'the clipped current day names both ends');
  assert.match(body, /hourly buckets \+ monthly snapshots/, 'the basis badge discloses merged snapshots');
  assert.match(body, /Legacy box · 2026-09 · whole source days merged · 600 tokens · method 2026-08-20.1/);
  assert.match(body, /1 stored monthly snapshot in this range is listed and not counted: subject not mapped/);
  assert.match(body, /Monthly snapshots cannot be placed on an hourly series/); assert.match(body, /straddling a range edge/);
  assert.match(body, /Request detail 25% 500 of 2,000 headline tokens carry request records/);
  assert.match(body, /API-equivalent cost estimate Public list-price estimate/);
  assert.match(body, /Tokens by model Which recorded models contributed/);
  assert.match(body, /Environmental impact Inference-equivalent scenarios/);
  assert.match(body, /Actions you can take/);
  assert.match(body, /Estimated API equivalent \$1\.25/);
  assert.match(html, /aria-label="m1, Sep 1, 2026: \$0\.80, 1,000 tokens · 4 calls · 100 unpriced tokens"/, 'cost graph exposes exact model/day evidence');
  assert.match(html, /aria-label="m1, Tue, Sep 1: 1,000 tokens, 4 calls"/, 'model graph exposes exact interval values');
  assert.match(body, /Electricity · planning 3\.06 Wh/); assert.match(body, /Direct water · planning 0\.918 mL/); assert.match(body, /Operational carbon · planning 1\.206 g CO₂e/);
  assert.match(body, /Avoid about 0\.9 comparable calls/);
  assert.match(html, /href="https:\/\/climeworks\.com\/actnow"/); assert.match(html, /href="https:\/\/store\.b-e-f\.org\/household\/"/); assert.match(html, /href="https:\/\/donate\.rewiringamerica\.org\/campaign\/641970\/donate"/);
  assert.match(body, /none changes the footprint displayed above/);
  assert.match(body, /Next in this order.*Project and agent breakdowns \(USG-021\), Tool calls and knowledge sources \(USG-022\)/);
  assert.match(body, /All accounts and projects/, 'the landing view shows no active chips');
  assert.match(body, /America\/Chicago/, 'one display zone is named');
});

test('detail filters, unfilterable buckets, and a failed refresh are explained without dropping the last good result', () => {
  const result = synthetic();
  result.headline = { ...result.headline, basis: 'requests', total_tokens: 500, calls: 2, unfilterable_tokens: 1_500, unfilterable_calls: 7, composition: composition(300, 100, 0, 100, null) };
  result.scope = { ...result.scope, detail_filters: ['projects'] };
  const filters = { ...DEFAULT_FILTERS, projects: ['p1'], accounts: ['claude-a'] };
  const body = text(render({ result, filters, error: 'Usage is temporarily unavailable. Retry, or wait for the next refresh.', stale: true }));
  assert.match(body, /The latest refresh failed/); assert.match(body, /have not changed/); assert.match(body, /last good ·/);
  assert.match(body, /Exact total 500 tokens/, 'the last good figures stay up');
  assert.match(body, /request detail/); assert.match(body, /1,500 tokens and 7 calls in the selected hourly buckets carry no request detail and are excluded, not matched/);
  assert.match(body, /Project: Kit board/); assert.match(body, /Account: Claude personal/); assert.match(body, /Clear all/);
  assert.match(body, /Reasoning within output is not reported separately for this scope/);
  const failed = text(render({ result: null, error: 'Usage is temporarily unavailable. Retry, or wait for the next refresh.' }));
  assert.match(failed, /Usage is temporarily unavailable/); assert.doesNotMatch(failed, /Exact total/);
  const loading = text(render({ result: null, loading: true }));
  assert.match(loading, /Loading usage/);
});

test('an inconsistent composition withholds shares and a hourly series labels hours', () => {
  const result = synthetic();
  result.headline = { ...result.headline, composition: composition(1_900, 300, 0, 0, null) };
  const body = text(render({ result }));
  assert.match(body, /components exceed the total/); assert.match(body, /Known components add up to 2,200 tokens against a reported total of 2,000; shares are withheld rather than clamped/);
  const hourly = synthetic();
  hourly.series = { resolution: 'hour', points: [point('2026-09-05T14:00:00.000Z', '2026-09-05T15:00:00.000Z', 100, 1, 'observed')], excludes_snapshot_tokens: 600 };
  const hours = text(render({ result: hourly, filters: { ...DEFAULT_FILTERS, resolution: 'hour' } }));
  assert.match(hours, /Hourly totals in America\/Chicago/); assert.match(hours, /600 snapshot tokens count in the total but cannot be placed on hours/);
  const inFlight = text(render({ result: hourly, filters: { ...DEFAULT_FILTERS, resolution: 'day', timezone: 'UTC' }, loading: true }));
  assert.match(inFlight, /updating…/); assert.match(inFlight, /Hourly totals in America\/Chicago/, 'the last good result keeps its own resolution and zone while new filters load');
  assert.match(renderToStaticMarkup(<TokensOverview filters={{ ...DEFAULT_FILTERS, resolution: 'hour' }} onFiltersChange={() => {}} result={hourly} vocabulary={vocabulary} error={null} stale={false} loading={false} onRetry={() => {}} now={0} />), /Sat, Sep 5 · 09:00 to 10:00: 100 tokens/);
});

test('cost/model tables preserve exact values and a large legend starts readable', () => {
  const result = synthetic();
  const colors = new Map([['m1', 'var(--chart-1)']]);
  const cost = text(renderToStaticMarkup(<CostModelTable rows={result.cost.by_model} />));
  assert.match(cost, /m1 7 1,400 86% \$1\.25/);
  const models = text(renderToStaticMarkup(<ModelSummaryTable result={result} colors={colors} />));
  assert.match(models, /m1 7 1,400 70% 1\.4K \/ 0 \/ 0 \/ 0/);

  const legend = renderToStaticMarkup(<UsageSeriesChart categories={[{ key: 'd', label: 'Day', shortLabel: 'D' }]}
    series={Array.from({ length: 6 }, (_, index) => ({ key: `m${index}`, label: `Model ${index}`, color: `var(--chart-${index % 5 + 1})`, values: [index + 1] }))}
    unit="tokens" formatValue={value => `${value} tokens`} formatAxis={String} />);
  assert.match(legend, /Top 5 shown initially/);
  assert.match(legend, /aria-pressed="false"[^>]*>.*Model 5/s, 'the sixth line remains discoverable in the legend without crowding the initial graph');
  assert.match(legend, /Show all/);
});
