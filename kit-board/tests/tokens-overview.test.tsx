import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokensOverview } from '@/components/tokens-overview';
import { ProjectAgentBreakdown, ToolKnowledgeCard, agentLabel, projectFilterValue } from '@/components/usage-breakdown-cards';
import { CostBreakdown, CostByDayChart, CostModelTable, ModelOverTimeChart, ModelRanking, ModelSummaryTable, rankedModels } from '@/components/usage-insight-cards';
import { EnvironmentalActions } from '@/components/environmental-impact';
import { DataTable } from '@/components/kit';
import { UsageSeriesChart } from '@/components/usage-series-chart';
import type { ModelLineStyle } from '@/lib/model-colors';
import type { UsageQueryResult } from '@/lib/usage-query';
import { DEFAULT_FILTERS, activeFilterChips, compositionView, seriesSummary } from '@/lib/usage-view';

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

const MAIN_GROUP = 'a'.repeat(64), CHILD_GROUP = 'b'.repeat(64), UNATTRIBUTED_GROUP = 'e'.repeat(64);
const DESK_INSTALL = '00000000-0000-4000-8000-00000000d35c';

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
    effort_series: { rows: [], coverage: empty },
    pricing_inputs: { rows: [], coverage: coverage(2_000, 1_400, 1_400), note: 'fixture pricing coverage' },
    projects: { rows: [
      { state: 'project', project_id: 'p1', label: 'Kit board', filter_value: 'p1', total_tokens: 300, calls: 1, conversations: 1, share: 0.6 },
      { state: 'no_project', project_id: null, label: null, filter_value: 'no_project', total_tokens: 120, calls: 1, conversations: 1, share: 0.24 },
      { state: 'unknown', project_id: null, label: null, filter_value: 'unknown', total_tokens: 80, calls: 0, conversations: 0, share: 0.16 },
      { state: 'no_project', project_id: null, label: 'Chats / no project', filter_value: 'projectless', total_tokens: 0, calls: 0, conversations: 0, share: 0 },
      { state: 'not_reported', project_id: null, label: 'desk: companion update needed', filter_value: `not_reported:${DESK_INSTALL}`, total_tokens: 0, calls: 0, conversations: 0, share: 0 },
    ], coverage: { ...coverage(2_000, 500, 420), note: 'Project evidence: request-covered tokens with a project identity; Unknown project is the remainder.' }, registry: { ...coverage(2_000, 420, 300), note: 'Registry mapping: attributed tokens whose identity maps to a named project.' } },
    agents: { rows: [
      { group_id: MAIN_GROUP, provider: 'claude', role: 'main', name: 'main', builtin: false, instances: 1, sessions: 1, total_tokens: 380, calls: 1, composition: composition(380, 0, 0, 0, null), share: 0.76 },
      { group_id: CHILD_GROUP, provider: 'claude', role: 'subagent', name: 'Explore', builtin: true, instances: 2, sessions: 1, total_tokens: 80, calls: 1, composition: composition(80, 0, 0, 0, null), share: 0.16 },
      { group_id: UNATTRIBUTED_GROUP, provider: 'cursor', role: 'unattributed', name: 'unattributed', builtin: false, instances: 0, sessions: 1, total_tokens: 40, calls: 0, composition: composition(40, 0, 0, 0, null), share: 0.08 },
    ], summary: { main_tokens: 380, subagent_tokens: 80, unattributed_tokens: 40, observed_children: 1, spawns: 2, by_class: { main: 380, builtin: 80, unattributed: 40 } }, coverage: { ...coverage(2_000, 500, 460), note: 'Agent attribution: request-covered tokens carrying an agent identity.' } },
    tools: { invocations: 5, by_tool: [
      { name: 'Read', class: 'builtin', namespace: null, builtin: true, machine: null, synthetic: false, invocations: 3, share: 0.6, children: [] },
      { name: 'search_notes', class: 'mcp', namespace: 'obsidian', builtin: false, machine: null, synthetic: false, invocations: 2, share: 0.4, children: [] },
    ], by_caller: [{ state: 'group', group_id: CHILD_GROUP, provider: 'claude', role: 'subagent', name: 'Explore', builtin: true, invocations: 3 },
      { state: 'none', group_id: null, provider: null, role: null, name: null, builtin: false, invocations: 2 }],
      by_outcome: { succeeded: 3, failed: 1, unknown: 1 }, caller_coverage: { ...coverage(5, 5, 3, 'invocations'), note: 'Reported invocations with a supported caller.' }, outcome_coverage: { ...coverage(5, 5, 4, 'invocations'), note: 'Reported invocations with a supported outcome.' }, unsupported_filters: ['models'] },
    knowledge: { rows: [
      { source_id: 's1', label: 'Fixture vault', state: 'source', accesses: 3, distinct_invocations: 2, distinct_sessions: 1, distinct_agents: 1, by_access_kind: { read: 2, search: 1 }, earlier_configuration_accesses: 1 },
      { source_id: null, label: null, state: 'unassigned', accesses: 1, distinct_invocations: 1, distinct_sessions: 1, distinct_agents: 1, by_access_kind: { unknown: 1 }, earlier_configuration_accesses: 0 },
    ], distinct_invocations: 2, note: 'Per-source access counts overlap when one invocation touches several sources; distinct_invocations is the unduplicated total.', unsupported_filters: ['models'] },
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
      pricing_catalog: { version: 'fixture-v1', versions: { openai: 'fixture-v1', anthropic: 'fixture-v1', xai: 'fixture-v1' }, unit_tokens: 1_000_000, long_context_threshold_tokens: { openai: 272000, anthropic: 200000, xai: 200000 }, sources: [{ label: 'Fixture catalog', url: 'https://example.test/catalog' }], provenance: { openai: 'fixture', anthropic: null, xai: null } }, assumptions: ['Fixture pricing assumption.'] },
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
  assert.match(html, /role="img" aria-label="Tue, Sep 1: 1,000 tokens, 4 calls, observed"/, 'every bar is mirrored for assistive tech with its interval and exact values');
  assert.match(html, /role="img" aria-label="Wed, Sep 2: 0 tokens, 0 calls, no activity recorded"/, 'a zero interval is still named rather than dropped from the mirror');
  assert.match(html, /aria-label="Thu, Sep 3: 0 tokens, 0 calls, no collector coverage"/);
  assert.match(html, /aria-label="Sat, Sep 5 · 00:00 to 15:30: 400 tokens, 3 calls, still being observed"/, 'the clipped current day names both ends');
  assert.match(body, /\+ monthly snapshots/, 'the basis badge discloses merged snapshots');
  assert.match(body, /canonical hourly buckets in scope/, 'and the calls stat names the bucket basis');
  assert.match(body, /Legacy box · 2026-09 · whole source days merged · 600 tokens · method 2026-08-20.1/);
  assert.match(body, /1 stored monthly snapshot in this range is listed and not counted: subject not mapped/);
  assert.match(body, /Monthly snapshots cannot be placed on an hourly series/); assert.match(body, /straddling a range edge/);
  assert.match(body, /Request detail 25% 500 of 2,000 headline tokens carry request records/);
  assert.match(body, /API-equivalent cost estimate Public list-price estimate/);
  assert.match(body, /API equivalent \$1\.25 list-price estimate, not spend · 86% priced/, 'the summary sets the estimate beside the tokens and calls it an estimate');
  assert.match(body, /Busiest day 1K Tue, Sep 1 · 4 calls Average active day 666\.7 over 3 days with activity Tokens per call 222\.2/, 'the activity figures are read from the same bars they sit above');
  assert.match(body, /Tokens by model 1 model, ranked by tokens, with the API-equivalent estimate beside each\. Ranked Graph Table/, 'the model card leads with the ranking and keeps the plot and the ledger');
  assert.match(body, /1 m1 1\.4K tokens 70% 7 calls \$1\.25 \$1,041\.67 \/ 1M · partial/, 'a ranked model carries its estimate and says when part of it is unpriced');
  assert.match(body, /API-equivalent cost estimate Public list-price estimate/);
  assert.match(body, /Estimated API equivalent \$1\.25/);
  assert.match(body, /What the estimate is made of \$1,041\.67 per 1M priced tokens, blended/);
  assert.match(body, /Fresh input \$0\.50 40% Cached input \$0\.10 8\.0% Cache-write input \$0\.15 12% Output · reasoning \$0\.25 20% Output · other \$0\.25 20%/, 'the components are the parts of the one estimate');
  assert.match(body, /Fresh input carries the largest share of the estimate, 40%\. Components are list-price parts/);
  assert.doesNotMatch(body, /Of priced tokens/, 'token shares are withheld while a priced row is only partly priced');
  const colors = new Map([['m1', { color: 'var(--chart-1)' }]]);
  assert.match(renderToStaticMarkup(<CostByDayChart cost={result.cost} colors={colors} empty={null} />), /aria-label="m1, Sep 1, 2026: \$0\.80, 1,000 tokens · 4 calls · 100 unpriced tokens"/, 'cost graph exposes exact model/day evidence');
  assert.match(renderToStaticMarkup(<ModelOverTimeChart result={result} colors={colors} empty={null} />), /aria-label="m1, Tue, Sep 1: 1,000 tokens, 4 calls"/, 'model graph exposes exact interval values');
  assert.match(body, /Environmental impact Inference-equivalent scenarios/);
  assert.match(body, /Electricity · planning 3\.06 Wh/); assert.match(body, /Direct water · planning 0\.918 mL/); assert.match(body, /Operational carbon · planning 1\.206 g CO₂e/);
  assert.match(body, /CO₂e scenario comparison Actions you can take Scenario factors, scope, methodology, and sources Method 2026-08-20\.1\./, 'actions and method detail wait behind two disclosures under the three figures');
  const actionsHtml = renderToStaticMarkup(<EnvironmentalActions estimate={result.environment} />);
  assert.match(text(actionsHtml), /Avoid about 0\.9 comparable calls/);
  assert.match(actionsHtml, /href="https:\/\/climeworks\.com\/actnow"/); assert.match(actionsHtml, /href="https:\/\/store\.b-e-f\.org\/household\/"/); assert.match(actionsHtml, /href="https:\/\/donate\.rewiringamerica\.org\/campaign\/641970\/donate"/);
  assert.match(text(actionsHtml), /none changes the footprint displayed above/);
  assert.match(html, /<nav aria-label="Tokens sections"/);
  for (const anchor of ['activity', 'models', 'cost', 'projects', 'tools', 'footprint', 'coverage']) {
    assert.match(html, new RegExp(`href="#tokens-${anchor}"`), `the jump bar links ${anchor}`);
    assert.match(html, new RegExp(`id="tokens-${anchor}"`), `and ${anchor} is there to land on`);
  }
  assert.match(body, /Tokens over time.*Tokens by model.*API-equivalent cost estimate.*Projects Tokens by the project.*Agents How the same tokens divide.*Tool calls and knowledge sources.*Environmental impact.*What this scope covers/s, 'the sections run in the order the jump bar names them');
  assert.match(body, /All accounts and projects/, 'the landing view shows no active chips');
  assert.match(body, /America\/Chicago/, 'one display zone is named');
});

test('project and agent cards read their rows, coverage, and selection from the result and apply reversible filters', () => {
  const result = synthetic();
  const html = render();
  const body = text(html);
  assert.match(body, /Named projects 1 4 state buckets kept inside the total/);
  assert.match(body, /Attribution coverage 21% 420 of 2,000 headline tokens carry a project/);
  assert.match(body, /In an app project 71% 300 of 420 placed tokens land in a project an app defines/);
  assert.match(body, /Kit board 300 60% 1 1/); assert.match(body, /No project 120 24% 1 1/); assert.match(body, /Unknown 80 16% 0 0/, 'No project and Unknown stay separate rows');
  assert.match(body, /Chats \/ no project 0 0\.0% 0 0/, 'a projectless app chat reads as its own row');
  assert.match(body, /desk: companion update needed 0 0\.0% 0 0/, 'a machine that has not reported projects is named');
  assert.match(body, /Main agent 380 76% of attributable tokens/); assert.match(body, /Subagents 80 16% · 1 distinct observed child/); assert.match(body, /Unattributed 40 8\.0%/); assert.match(body, /Spawn events 2/);
  assert.match(body, /Role classes Main 380 Built-in 80 Unattributed 40/);
  assert.match(body, /Claude Code main agent Main 1 1 380 76% 1/, 'one row per provider, role and name');
  assert.match(body, /Claude Code Explore built-in Subagent 2 1 80 16% 1/, 'a group counts its instances and sessions and tags a built-in');
  assert.match(body, /Cursor unattributed Unattributed 0 1 40 8\.0% 0/, 'missing identity stays unattributed with nothing invented');
  assert.match(body, /Forked Codex subagent rollouts record their parent session and agent, so their tokens count under Codex main/, 'the forked-rollout gap is stated');
  assert.match(body, /do not say whether a user or a model asked for the delegation/);
  assert.match(html, /aria-pressed="false"[^>]*>Main agents</); assert.match(html, /aria-pressed="false"[^>]*>Subagents</);
  assert.doesNotMatch(html, /data-state="selected"/, 'nothing is selected on the landing view');

  assert.deepEqual(result.projects.rows.map(projectFilterValue), ['p1', 'no_project', 'unknown', 'projectless', `not_reported:${DESK_INSTALL}`], 'every row applies a value of its own');
  assert.deepEqual(result.agents.rows.map(agentLabel), ['Claude Code · main agent', 'Claude Code · Explore', 'Cursor · unattributed']);

  const filters = { ...DEFAULT_FILTERS, projects: ['no_project'], agents: [CHILD_GROUP], agent_scope: 'subagent' as const };
  const selectedHtml = render({ filters });
  assert.match(selectedHtml, /data-state="selected"[^>]*>(?:(?!<\/tr>).)*No project/s, 'the state bucket row shows as selected');
  assert.match(selectedHtml, /data-state="selected"[^>]*>(?:(?!<\/tr>).)*Explore/s, 'the agent row shows as selected');
  assert.match(selectedHtml, /aria-pressed="false"[^>]*>Subagents</, 'the card role buttons are a local view, independent of the page-wide agent scope');
  const selectedBody = text(selectedHtml);
  assert.match(selectedBody, /filtering: No project/); assert.match(selectedBody, /filtering: Claude Code · Explore/);
  assert.match(selectedBody, /Project: No project/); assert.match(selectedBody, /Agent: Claude Code · Explore/, 'the drill-down chip carries the agent name rather than a bare group id');
  assert.match(selectedBody, /Subagents only/); assert.match(selectedBody, /Clear all/, 'every drill-down is reversible from the filter bar');
  assert.deepEqual(activeFilterChips(filters, { agents: { [CHILD_GROUP]: 'Claude Code · Explore' } }).map(c => c.label), ['Project: No project', 'Agent: Claude Code · Explore', 'Subagents only']);
  assert.deepEqual(activeFilterChips({ ...DEFAULT_FILTERS, agents: [CHILD_GROUP] }).map(c => c.label), ['Agent: agent group bbbbbbbb'], 'an unnamed group id falls back to a short id');

  // The projectless and per-machine rows apply values of their own, so each selects only itself.
  for (const [value, name] of [['projectless', 'Chats / no project'], [`not_reported:${DESK_INSTALL}`, 'desk: companion update needed']]) {
    const rowHtml = render({ filters: { ...DEFAULT_FILTERS, projects: [value] } });
    assert.equal((rowHtml.match(/data-state="selected"/g) ?? []).length, 1, `${name} selects one row`);
    assert.match(rowHtml, new RegExp(`data-state="selected"[^>]*>(?:(?!</tr>).)*${name.replace('/', '\\/')}`, 's'));
    assert.match(text(rowHtml), new RegExp(`filtering: ${name.replace('/', '\\/')}`));
    assert.match(text(rowHtml), new RegExp(`Project: ${name.replace('/', '\\/')}`), 'the chip names the row, not a wider bucket');
  }

  const applied: Parameters<typeof ProjectAgentBreakdown>[0]['filters'][] = [];
  const captured = renderToStaticMarkup(<ProjectAgentBreakdown result={result} filters={DEFAULT_FILTERS} onFiltersChange={next => applied.push(next)} />);
  assert.match(captured, /Select a row to filter the whole page to that project; select it again, or remove the chip above, to go back/);
  assert.match(captured, /Select an agent to filter the whole page to it/);

  const bare = synthetic();
  bare.projects = { rows: [], coverage: coverage(2_000, 0, 0), registry: coverage(2_000, 0, 0) };
  bare.agents = { rows: [], summary: { main_tokens: 0, subagent_tokens: 0, unattributed_tokens: 0, observed_children: 0, spawns: 0, by_class: {} }, coverage: coverage(2_000, 0, 0) };
  const bareBody = text(render({ result: bare }));
  assert.match(bareBody, /No project evidence in scope/); assert.match(bareBody, /No agent evidence in scope/); assert.match(bareBody, /Attribution coverage 0\.0% 0 of 2,000 headline tokens carry a project/); assert.match(bareBody, /In an app project — 0 of 0 placed tokens/, "mapping over nothing is withheld");
  assert.match(bareBody, /Main agent 0 — of attributable tokens/, 'shares are withheld rather than divided by zero');
});

test('the tool card keeps invocations, model calls, and spawns apart and lists knowledge sources with overlapping counts labeled', () => {
  const result = synthetic();
  const html = render();
  const body = text(html);
  assert.match(body, /Tool invocations 5 each invocation once; results and status updates are not counted again/);
  assert.match(body, /Model calls 9 a separate count/); assert.match(body, /Agent spawns 2 a separate count/);
  assert.match(body, /Caller attribution 60% 3 of 5 invocations name their caller/);
  assert.match(body, /Outcomes succeeded 3 failed 1 unknown 1 · 1 without a recorded outcome/);
  assert.match(body, /model filter not applied to tools/);
  assert.match(body, /Read built-in built-in 3 60%/); assert.match(body, /search_notes MCP · obsidian 2 40%/);
  assert.match(body, /Claude Code · Explore built-in Subagent 3/); assert.match(body, /No caller recorded not recorded 2/);
  assert.match(body, /Knowledge sources Tool calls that touched a configured vault or connector/);
  assert.match(body, /model filter not applied to knowledge access 1 configured source 2 distinct tool calls Configure sources/, 'the knowledge area reports its own unapplied filters');
  assert.match(html, /href="\/settings\/sources"/, 'the card links to source configuration in global Settings');
  assert.match(body, /Fixture vault 3 2 1 1 2 1 0 0 1/, 'accesses, distinct tool calls, sessions, agents, read/search/write/unknown, earlier-configuration accesses');
  assert.match(body, /Unassigned identity not yet named 1 1 1 1 0 0 0 1 —/);
  assert.match(body, /Per-source access counts overlap when one invocation touches several sources/);
  assert.match(body, /shows access, not that the answer used its contents, and no token cost is assigned to a source/);
  assert.match(body, /Tool invocations, model calls, and agent spawns are three different counts and are never summed/);

  const bare = synthetic();
  bare.tools = { invocations: 0, by_tool: [], by_caller: [], by_outcome: {}, caller_coverage: coverage(0, 0, 0, 'invocations'), outcome_coverage: coverage(0, 0, 0, 'invocations'), unsupported_filters: [] };
  bare.knowledge = { rows: [], distinct_invocations: 0, note: '', unsupported_filters: [] };
  const bareBody = text(renderToStaticMarkup(<ToolKnowledgeCard result={bare} />));
  assert.match(bareBody, /Tool invocations 0/); assert.match(bareBody, /Outcomes not collected for these invocations; success and failure are unknown rather than assumed/);
  assert.match(bareBody, /No tool invocations in scope/); assert.match(bareBody, /No caller attribution/); assert.match(bareBody, /No knowledge-source access in scope/);
  assert.match(bareBody, /Caller attribution —/, 'coverage over nothing is withheld, not shown as complete');
});

test('an exec row expands to the nested calls it ran, and a child whose exec is outside the range keeps its own row', () => {
  const result = synthetic();
  result.tools = { ...result.tools, invocations: 9, by_tool: [
    { name: 'exec', class: 'builtin', namespace: null, builtin: true, machine: null, synthetic: false, invocations: 2, share: 2 / 9,
      children: [{ name: 'run_query', namespace: 'Fixture DB (connector)', invocations: 4, outcomes: { succeeded: 3, failed: 1 } }] },
    { name: 'exec (outside range)', class: 'builtin', namespace: null, builtin: true, machine: null, synthetic: true, invocations: 0, share: 0,
      children: [{ name: 'list_items', namespace: 'fixture-server', invocations: 1, outcomes: { succeeded: 1 } }] },
    { name: 'h:0123…', class: 'mcp', namespace: null, builtin: false, machine: 'desk', synthetic: false, invocations: 2, share: 2 / 9, children: [] },
  ] };
  const body = text(renderToStaticMarkup(<ToolKnowledgeCard result={result} />));
  assert.match(body, /exec built-in built-in 4 nested calls · 1 tool/, 'the exec row offers its children');
  assert.match(body, /exec \(outside range\) built-in built-in 1 nested call · 1 tool/);
  assert.match(body, /h:0123… MCP · unnamed on desk 2/, 'an unlabeled hash reads as a short hash with its machine');
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
  const hoursHtml = render({ result: hourly, filters: { ...DEFAULT_FILTERS, resolution: 'hour' } });
  assert.match(hoursHtml, /aria-label="Sat, Sep 5 · 09:00 to 10:00: 100 tokens, 1 calls, observed"/, 'hour intervals are named in the display zone'); assert.match(text(hoursHtml), /600 snapshot tokens count in the total but cannot be placed on hours/);
  const inFlight = render({ result: hourly, filters: { ...DEFAULT_FILTERS, resolution: 'day', timezone: 'UTC' }, loading: true });
  assert.match(text(inFlight), /updating…/); assert.match(inFlight, /aria-label="Sat, Sep 5 · 09:00 to 10:00: 100 tokens, 1 calls, observed"/, 'the last good result keeps its own resolution and zone while new filters load');
  assert.match(renderToStaticMarkup(<TokensOverview filters={{ ...DEFAULT_FILTERS, resolution: 'hour' }} onFiltersChange={() => {}} result={hourly} vocabulary={vocabulary} error={null} stale={false} loading={false} onRetry={() => {}} now={0} />), /Sat, Sep 5 · 09:00 to 10:00: 100 tokens/);
});

test('request and tool cards wait instead of flashing empty while their section is still loading', () => {
  const result = synthetic();
  result.request_detail = { covered_tokens: 0, covered_calls: 0, coverage: coverage(2_000, 0, 0) };
  const body = text(render({ result, pending: { requests: true, tools: true, knowledge: true } }));
  assert.match(body, /Loading projects/);
  assert.match(body, /Loading agents/);
  assert.match(body, /Loading tool calls/);
  assert.doesNotMatch(body, /No project evidence in scope/);
  assert.doesNotMatch(body, /No tool invocations in scope/);
  assert.match(body, /Request detail … reading request records in the selected range/);
  assert.match(body, /Observed tokens in the selected scope 2K/, 'the headline from overview stays visible');
  const toolsReady = text(render({ result, pending: { requests: false, tools: false, knowledge: true } }));
  assert.match(toolsReady, /Tool invocations 5/);
  assert.match(toolsReady, /Loading knowledge sources/);
  assert.doesNotMatch(toolsReady, /Loading tool calls/);
});

test('cost/model tables preserve exact values and a large legend starts readable', () => {
  const result = synthetic();
  const colors = new Map([['m1', { color: 'var(--chart-1)' }]]);
  const cost = text(renderToStaticMarkup(<CostModelTable rows={result.cost.by_model} />));
  assert.match(cost, /m1 7 1,400 86% \$1\.25/);
    const models = text(renderToStaticMarkup(<ModelSummaryTable result={result} colors={colors} />));
    assert.match(models, /Model Calls Tokens Share Fresh Cached Cache write Output m1 7 1,400 70% 1\.4K 0 0 0/, 'one column per composition part, exact values preserved');
    const emptyCost = text(renderToStaticMarkup(<CostModelTable rows={[]} />));
    assert.match(emptyCost, /No priced model activity/);
    assert.doesNotMatch(emptyCost, /source price date|request records carrying pricing/);

  const legend = renderToStaticMarkup(<UsageSeriesChart categories={[{ key: 'd', label: 'Day', shortLabel: 'D' }]}
    series={Array.from({ length: 6 }, (_, index) => ({ key: `m${index}`, label: `Model ${index}`, color: `var(--chart-${index % 5 + 1})`, values: [index + 1] }))}
    unit="tokens" formatValue={value => `${value} tokens`} formatAxis={String} />);
  assert.match(legend, /aria-pressed="false"[^>]*>.*Model 5/s, 'the sixth line remains discoverable in the legend without crowding the initial graph');
  assert.match(legend, /Show all/);
});

test('the model ranking joins each model to its estimate, marks what is unpriced, and shows the top eight first', () => {
  const result = synthetic();
  result.by_model = [
    { model: 'm1', total_tokens: 1_400, calls: 7, composition: composition(1_400, 0, 0, 0, null), share: 0.7, basis: 'buckets' },
    { model: 'unpriced-model', total_tokens: 400, calls: 2, composition: composition(400, 0, 0, 0, null), share: 0.2, basis: 'buckets' },
    ...Array.from({ length: 8 }, (_, index) => ({ model: `tail-${index}`, total_tokens: 20 - index, calls: 1, composition: composition(20 - index, 0, 0, 0, null), share: 0.01, basis: 'buckets' as const })),
  ];
  const ranked = rankedModels(result);
  assert.deepEqual(ranked.slice(0, 2).map(row => [row.model, row.tokens, row.usd, row.priced, row.unpriced]), [['m1', 1_400, 1.25, 1_200, 200], ['unpriced-model', 400, 0, 0, 400]], 'a model without price rows keeps its tokens and counts them unpriced');
  const colors = new Map<string, ModelLineStyle>();
  const body = text(renderToStaticMarkup(<ModelRanking rows={ranked} colors={colors} />));
  assert.match(body, /2 unpriced-model 400 tokens 20% 2 calls not priced/, 'no price reads as not priced, never as \$0.00');
  assert.match(body, /8 tail-5/); assert.doesNotMatch(body, /tail-6/, 'the ninth model waits behind the toggle');
  assert.match(body, /Show all 10 models/);
});

test('the cost breakdown shows token shares only when every priced row is priced in full', () => {
  const result = synthetic();
  const whole = { ...result.cost, component_costs_usd: { input_cost_usd: 1, cached_input_cost_usd: 3, cache_write_input_cost_usd: 0.5, reasoning_output_cost_usd: 0, other_output_cost_usd: 1.5 }, estimated_cost_usd: 6,
    by_model: [priced({ unpriced_tokens: 0, priced_tokens: 1_400, estimated_cost_usd: 6, reasoning_output_tokens: 0 })] };
  const html = renderToStaticMarkup(<CostBreakdown cost={whole} />);
  const body = text(html);
  assert.match(body, /Component Estimate Of estimate Of priced tokens/);
  assert.match(body, /Fresh input \$1\.00 17% 50% Cached input \$3\.00 50% 14% Cache-write input \$0\.50 8\.3% 7\.1% Output \$1\.50 25% 29%/, 'fresh is input less cached and cache-write; output is one row when no reasoning cost is reported');
  assert.match(body, /Cached input carries the largest share of the estimate, 50%, from 14% of 1,400 priced tokens/);
  assert.match(html, /role="img" aria-label="Fresh input 17% of the estimate, Cached input 50% of the estimate, Cache-write input 8\.3% of the estimate, Output 25% of the estimate"/);
  assert.equal(renderToStaticMarkup(<CostBreakdown cost={{ ...whole, component_costs_usd: { input_cost_usd: 0, cached_input_cost_usd: 0, cache_write_input_cost_usd: 0, reasoning_output_cost_usd: 0, other_output_cost_usd: 0 } }} />), '', 'nothing to break down renders nothing');
});

test('a limited ledger shows its first rows, keeps a selected row past the limit, and offers the rest', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: `r${index}`, value: 100 - index }));
  const columns = [{ id: 'id', header: 'Row', cell: (row: typeof rows[number]) => row.id }, { id: 'value', header: 'Value', numeric: true, sortValue: (row: typeof rows[number]) => row.value, cell: (row: typeof rows[number]) => row.value }];
  const body = text(renderToStaticMarkup(<DataTable columns={columns} rows={rows} getRowId={row => row.id} defaultSort={{ id: 'value', dir: 'desc' }} limit={8} selectedId="r10" />));
  assert.match(body, /r7 93/); assert.doesNotMatch(body, /r8 92/); assert.doesNotMatch(body, /r9 91/);
  assert.match(body, /r10 90/, 'the selected row stays in view');
  assert.match(body, /Show all 12 rows/);
  const short = text(renderToStaticMarkup(<DataTable columns={columns} rows={rows.slice(0, 5)} getRowId={row => row.id} limit={8} />));
  assert.doesNotMatch(short, /Show all/, 'no toggle when everything already fits');
});
