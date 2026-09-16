import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPopulation, environmentalFactors, estimateEnvironment, legacyEstimateForReport, type CohortInput } from '../lib/environmental-estimate';

const r6 = (value: number) => Math.round(value * 1e6) / 1e6;
const cohort = (overrides: Partial<CohortInput>): CohortInput => ({
  account_id: 'codex-a', provider: 'codex', month: '2026-09', basis: 'buckets', subject_key: null, population: { calls: 1000, raw_tokens: 60_000_000 }, selected: { calls: 1000, raw_tokens: 60_000_000 }, month_closed: false, stored: null, ...overrides,
});

test('the threshold rule and factors are the 2026-08-20.1 method, relabeled', () => {
  assert.equal(environmentalFactors.methodology_version, '2026-08-20.1');
  assert.deepEqual([classifyPopulation({ calls: 2, raw_tokens: 100_000 }).workload_class, classifyPopulation({ calls: 2, raw_tokens: 99_998 }).workload_class], ['high_context_per_call', 'frontier_typical'], 'at least 50,000 raw tokens per call is the heavy class');
  assert.deepEqual([classifyPopulation({ calls: 2, raw_tokens: 100_000 }).factor_key, classifyPopulation({ calls: 2, raw_tokens: 100_000 }).planning_wh_per_call], ['reasoning_heavy', 4.32]);
  assert.deepEqual(classifyPopulation({ calls: 0, raw_tokens: 0 }), { workload_class: null, factor_key: null, planning_wh_per_call: null, average_raw_tokens_per_call: null }, 'no calls means no class, never an invented average');
});

test('the legacy shape reproduces the analyzer’s stored September estimate', () => {
  const estimate = legacyEstimateForReport({ model_calls: 8682, raw_tokens: 1_115_198_320, fresh_non_cached_tokens: 41_025_264, cached_input_tokens: 1_074_173_056 });
  const round = (value: Record<string, number>) => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, r6(v)]));
  assert.deepEqual(round(estimate.energy_kwh), { efficient_production_floor: 2.08368, planning: 37.50624, long_context_upper: 286.506 });
  assert.deepEqual(round(estimate.direct_water_liters), { efficient_production_floor: 2.25732, planning: 11.251872, long_context_upper: 544.3614 });
  assert.deepEqual(round(estimate.operational_co2_kg), { clean_energy_floor: 0.26046, planning_us_grid: 14.777459, long_context_us_grid: 112.883364 });
  assert.deepEqual(round(estimate.comparisons_at_planning_scenario), { average_showers: 0.148622, us_home_days_of_electricity: 1.318861, smartphone_full_charges: 1974.012632, urban_tree_seedlings_grown_10_years: 0.246291, average_gasoline_vehicle_miles: 37.601676 });
  assert.deepEqual(round(estimate.reduction_if_calls_drop_10_percent), { calls_avoided: 868.2, energy_kwh_avoided: 3.750624, direct_water_liters_avoided: 1.125187, operational_co2_kg_avoided: 1.477746 });
  assert.deepEqual([estimate.basis.planning_workload_class, estimate.basis.planning_wh_per_call, r6(estimate.compensation_planning.operational_co2_kg_to_cover)], ['reasoning_heavy', 4.32, 112.883364]);
});

test('cohorts classify from their whole month and a filter sums selected calls under that class', () => {
  const heavy = cohort({ population: { calls: 100, raw_tokens: 6_000_000 }, selected: { calls: 100, raw_tokens: 6_000_000 }, month_closed: true });
  const light = cohort({ account_id: 'claude-b', provider: 'claude', population: { calls: 200, raw_tokens: 2_000_000 }, selected: { calls: 200, raw_tokens: 2_000_000 } });
  const full = estimateEnvironment([heavy, light], { headlineCalls: 300 });
  assert.deepEqual(full.basis.cohorts.map(c => [c.classification.workload_class, c.classification.provisional]), [['frontier_typical', true], ['high_context_per_call', false]]);
  assert.equal(full.energy_kwh.planning, r6(100 * 4.32 / 1000 + 200 * 0.34 / 1000));
  assert.deepEqual([full.coverage.calls_estimated, full.coverage.calls_headline, full.coverage.cohorts_provisional], [300, 300, 1]);
  // A model filter keeps only a light slice of the heavy cohort: the class stays heavy because the cohort did.
  const filtered = estimateEnvironment([{ ...heavy, selected: { calls: 10, raw_tokens: 10_000 } }], { headlineCalls: 10 });
  assert.deepEqual([filtered.basis.cohorts[0].classification.workload_class, filtered.energy_kwh.planning], ['high_context_per_call', r6(10 * 4.32 / 1000)]);
  assert.equal(filtered.reduction_if_calls_drop_10_percent.calls_avoided, 1);
  assert.equal(filtered.compensation_planning.operational_co2_kg_to_cover, filtered.operational_co2_kg.long_context_us_grid);
  assert.equal(filtered.scenarios.length, 9);
});

test('a merged legacy month keeps its stored estimate and method, and no calls means no estimate', () => {
  const stored = { methodology_version: '2026-07-01.0', planning_workload_class: 'reasoning_heavy', planning_wh_per_call: 4.32,
    energy_kwh: { efficient_production_floor: 1, planning: 2, long_context_upper: 3 }, direct_water_liters: { efficient_production_floor: 0.1, planning: 0.2, long_context_upper: 0.3 }, operational_co2_kg: { clean_energy_floor: 0.01, planning_us_grid: 0.02, long_context_us_grid: 0.03 } };
  const whole = estimateEnvironment([cohort({ basis: 'snapshot', month: '2026-07', population: { calls: 50, raw_tokens: 100 }, selected: { calls: 50, raw_tokens: 100 }, month_closed: true, stored })], { headlineCalls: 50 });
  assert.deepEqual([whole.energy_kwh.planning, whole.methodology_versions, whole.basis.cohorts[0].classification.source, whole.coverage.cohorts_stored], [2, ['2026-07-01.0'], 'stored', 1]);
  const part = estimateEnvironment([cohort({ basis: 'snapshot', month: '2026-07', population: { calls: 50, raw_tokens: 100 }, selected: { calls: 10, raw_tokens: 20 }, month_closed: true, stored })], { headlineCalls: 10 });
  assert.deepEqual([part.energy_kwh.planning, part.basis.cohorts[0].classification.workload_class, part.basis.cohorts[0].classification.source, part.basis.cohorts[0].methodology_version, part.methodology_versions],
    [r6(10 * 4.32 / 1000), 'high_context_per_call', 'stored_class', '2026-08-20.1', ['2026-08-20.1']], 'a partly selected legacy month keeps its stored class, is computed with the current factors, and says so');
  // The stored class is applied with the current factor, whatever per-call figure the old method stored; an unknown or prototype-named class classifies afresh.
  const oldFactor = estimateEnvironment([cohort({ basis: 'snapshot', month: '2026-07', population: { calls: 50, raw_tokens: 100 }, selected: { calls: 10, raw_tokens: 20 }, month_closed: true, stored: { ...stored, planning_wh_per_call: 4.0 } })], { headlineCalls: 10 });
  assert.deepEqual([oldFactor.energy_kwh.planning, oldFactor.basis.cohorts[0].classification.planning_wh_per_call], [r6(10 * 4.32 / 1000), 4.32]);
  for (const planning_workload_class of ['something_else', 'toString', null]) {
    const fresh = estimateEnvironment([cohort({ basis: 'snapshot', month: '2026-07', population: { calls: 50, raw_tokens: 100 }, selected: { calls: 10, raw_tokens: 20 }, month_closed: true, stored: { ...stored, planning_workload_class } })], { headlineCalls: 10 });
    assert.deepEqual([fresh.basis.cohorts[0].classification.source, fresh.basis.cohorts[0].classification.workload_class, fresh.energy_kwh.planning], ['computed', 'frontier_typical', r6(10 * 0.34 / 1000)], `stored class ${planning_workload_class}`);
  }
  // Mixed methods in one estimate: a stored legacy month beside a provisional computed month.
  const mixed = estimateEnvironment([cohort({ basis: 'snapshot', month: '2026-07', population: { calls: 50, raw_tokens: 100 }, selected: { calls: 50, raw_tokens: 100 }, month_closed: true, stored }), cohort({})], { headlineCalls: 1050 });
  assert.deepEqual([mixed.methodology_versions, mixed.coverage.cohorts_stored, mixed.coverage.cohorts_provisional, mixed.energy_kwh.planning], [['2026-07-01.0', '2026-08-20.1'], 1, 1, r6(2 + 1000 * 4.32 / 1000)], 'the default cohort averages 60,000 tokens per call, so it is the heavy class');
  // A cohort whose population has no calls gets no class and no default factor; its selected calls are disclosed.
  const unclassified = estimateEnvironment([cohort({ population: { calls: 0, raw_tokens: 0 }, selected: { calls: 5, raw_tokens: 500 } })], { headlineCalls: 5 });
  assert.deepEqual([unclassified.energy_kwh.planning, unclassified.basis.cohorts[0].classification.workload_class, unclassified.coverage.calls_estimated, unclassified.coverage.calls_without_class], [0, null, 0, 5]);
  // Derived figures come from unrounded sums: four frontier calls give 0.001363 miles, as the analyzer computes, not 0.001364.
  const four = estimateEnvironment([cohort({ population: { calls: 4, raw_tokens: 400 }, selected: { calls: 4, raw_tokens: 400 } })], { headlineCalls: 4 });
  assert.equal(four.comparisons_at_planning_scenario.average_gasoline_vehicle_miles, 0.001363);
  assert.ok(four.assumptions.some(a => a.includes('high-context-per-call planning scenario')) && !four.assumptions.some(a => a.includes('reasoning-heavy planning scenario')), 'the returned assumptions carry the relabel');
  assert.ok(four.assumptions.at(-1)?.includes('workload-size proxy') && four.assumptions.at(-1)?.includes('does not measure reasoning effort'), 'the relabel note is appended');
  assert.ok(four.coverage.note.includes('recomputed from the retained ledger on each read'), 'the coverage note discloses that no class is persisted');
  const none = estimateEnvironment([], { headlineCalls: 0 });
  assert.deepEqual([none.energy_kwh.planning, none.basis.model_calls, none.coverage.calls_estimated, none.basis.average_raw_tokens_per_call], [0, 0, 0, null]);
  const missing = estimateEnvironment([], { headlineCalls: 40 });
  assert.equal(missing.coverage.calls_without_class, 40, 'calls without cohort evidence are disclosed, not estimated');
});
