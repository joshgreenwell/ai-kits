import factorsJson from './environmental-factors.json';

/**
 * Environmental impact, methodology 2026-08-20.1 reused unchanged (USG-013). The unit that carries a
 * classification is the cohort the metric contract names: one logical population (account and
 * provider) in one source calendar month. A cohort's average raw tokens per model call chooses its
 * planning scenario once, from the whole cohort, and a filter only sums the cohort's selected calls
 * under that class; it never reclassifies. The monthly analyzer's stored estimate for a merged legacy
 * month is carried as it was, under its own method version. Model calls are the only multiplier;
 * tokens, dollars, and allowance movement never stand in for missing call evidence.
 */
export const environmentalFactors = factorsJson;
export const ENVIRONMENTAL_METHODOLOGY_VERSION = factorsJson.methodology_version;

/** The legacy factor key `reasoning_heavy` is a workload-size proxy inferred from raw tokens per call, not measured effort. */
export const WORKLOAD_CLASSES = { frontier_typical: 'frontier_typical', reasoning_heavy: 'high_context_per_call' } as const;
export type FactorKey = keyof typeof WORKLOAD_CLASSES;
export type WorkloadClass = typeof WORKLOAD_CLASSES[FactorKey];

export type ScenarioTriple = { efficient_production_floor: number; planning: number; long_context_upper: number };
export type CarbonTriple = { clean_energy_floor: number; planning_us_grid: number; long_context_us_grid: number };
export type StoredEstimate = {
  methodology_version: string; planning_workload_class: string | null; planning_wh_per_call: number | null;
  energy_kwh: ScenarioTriple; direct_water_liters: ScenarioTriple; operational_co2_kg: CarbonTriple;
};
export type CohortInput = {
  account_id: string; provider: string; month: string; basis: 'buckets' | 'snapshot';
  /** The monthly report subject a snapshot cohort came from; the contract keeps legacy cohorts per subject. */
  subject_key: string | null;
  /** The whole cohort, unfiltered: what the class is inferred from. */
  population: { calls: number; raw_tokens: number };
  /** The part of the cohort inside the selected scope and filters: what the class is applied to. */
  selected: { calls: number; raw_tokens: number };
  /** An open month's class is provisional. A closed month's class is recomputed from the retained ledger on each read; nothing persists a frozen class yet. */
  month_closed: boolean;
  /** The analyzer's own estimate for a merged legacy month, kept under its method version. */
  stored: StoredEstimate | null;
};
export type CohortEstimate = CohortInput & {
  /** `stored`: the analyzer's numbers and version carried whole; `stored_class`: the stored class applied to the selected calls with the current factors; `computed`: classified here. */
  classification: { workload_class: WorkloadClass | null; factor_key: FactorKey | null; planning_wh_per_call: number | null; average_raw_tokens_per_call: number | null; provisional: boolean; source: 'computed' | 'stored' | 'stored_class' };
  methodology_version: string; energy_kwh: ScenarioTriple; direct_water_liters: ScenarioTriple; operational_co2_kg: CarbonTriple;
};
export type EnvironmentalEstimate = {
  kind: 'inference_equivalent_scenario_estimate'; methodology_version: string; methodology_versions: string[]; confidence: 'low';
  basis: { model_calls: number; raw_tokens: number; average_raw_tokens_per_call: number | null; cohorts: CohortEstimate[];
    classification_unit: string; long_context_upper_wh_per_call: number; planning_context_threshold_tokens_per_call: number };
  energy_kwh: ScenarioTriple; direct_water_liters: ScenarioTriple; operational_co2_kg: CarbonTriple;
  scenarios: { key: string; label: string; unit: string; factor: string }[];
  comparisons_at_planning_scenario: { average_showers: number; us_home_days_of_electricity: number; smartphone_full_charges: number; urban_tree_seedlings_grown_10_years: number; average_gasoline_vehicle_miles: number };
  reduction_if_calls_drop_10_percent: { calls_avoided: number; energy_kwh_avoided: number; direct_water_liters_avoided: number; operational_co2_kg_avoided: number };
  compensation_planning: { operational_co2_kg_to_cover: number; note: string };
  coverage: { calls_estimated: number; calls_headline: number; calls_without_class: number; cohorts_provisional: number; cohorts_stored: number; note: string };
  scope: string; assumptions: string[]; sources: { label: string; url: string; supports: string }[];
};

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;
const roundTriple = <T extends Record<string, number>>(value: T): T => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round6(v)])) as T;
const COMPENSATION_NOTE = 'If compensating, use at least the upper operational scenario and a verified durable-removal method. Tree equivalents are illustrations, not offset certificates.';
const REDUCTION = 0.1;

/** The method's threshold rule on a population's average raw tokens per call. */
export function classifyPopulation(population: { calls: number; raw_tokens: number }) {
  const f = environmentalFactors;
  const average = population.calls > 0 ? population.raw_tokens / population.calls : null;
  if (average === null) return { workload_class: null, factor_key: null, planning_wh_per_call: null, average_raw_tokens_per_call: null };
  const factorKey: FactorKey = average >= f.planning_context_threshold_tokens_per_call ? 'reasoning_heavy' : 'frontier_typical';
  return { workload_class: WORKLOAD_CLASSES[factorKey], factor_key: factorKey, planning_wh_per_call: f.energy_wh_per_call[factorKey], average_raw_tokens_per_call: average };
}

/** The three scenarios for a call count under a planning factor, exactly as the analyzer and the page fallback compute them. */
export function scenarioEstimate(calls: number, planningWhPerCall: number) {
  const f = environmentalFactors;
  const energy: ScenarioTriple = { efficient_production_floor: calls * f.energy_wh_per_call.efficient_production_floor / 1000, planning: calls * planningWhPerCall / 1000, long_context_upper: calls * f.energy_wh_per_call.long_context_upper / 1000 };
  const water: ScenarioTriple = { efficient_production_floor: calls * f.direct_water.efficient_production_ml_per_call / 1000, planning: energy.planning * f.direct_water.planning_wue_liters_per_kwh, long_context_upper: energy.long_context_upper * f.direct_water.upper_wue_liters_per_kwh };
  const carbon: CarbonTriple = { clean_energy_floor: calls * f.operational_carbon.clean_energy_kg_per_call, planning_us_grid: energy.planning * f.operational_carbon.us_grid_kg_per_kwh, long_context_us_grid: energy.long_context_upper * f.operational_carbon.us_grid_kg_per_kwh };
  return { energy_kwh: energy, direct_water_liters: water, operational_co2_kg: carbon };
}

function comparisons(energyPlanning: number, waterPlanning: number, carbonPlanning: number) {
  const c = environmentalFactors.comparisons;
  return { average_showers: waterPlanning / c.average_shower_liters, us_home_days_of_electricity: energyPlanning / c.us_home_kwh_per_day, smartphone_full_charges: energyPlanning / c.smartphone_charge_kwh,
    urban_tree_seedlings_grown_10_years: carbonPlanning / c.urban_tree_seedling_kg_co2_over_10_years, average_gasoline_vehicle_miles: carbonPlanning / c.average_gasoline_vehicle_kg_co2e_per_mile };
}

/** The exact analyzer/page-fallback shape for one monthly report, kept for the historical dashboard. */
export function legacyEstimateForReport(report: { model_calls: number; raw_tokens: number; fresh_non_cached_tokens: number; cached_input_tokens: number }) {
  const f = environmentalFactors;
  const classification = classifyPopulation({ calls: report.model_calls, raw_tokens: report.raw_tokens });
  const planningWh = classification.planning_wh_per_call ?? f.energy_wh_per_call.frontier_typical;
  const { energy_kwh, direct_water_liters, operational_co2_kg } = scenarioEstimate(report.model_calls, planningWh);
  return {
    kind: 'inference_equivalent_scenario_estimate' as const, methodology_version: f.methodology_version, confidence: 'low' as const,
    basis: { model_calls: report.model_calls, raw_tokens: report.raw_tokens, fresh_non_cached_tokens: report.fresh_non_cached_tokens, cached_input_tokens: report.cached_input_tokens,
      average_raw_tokens_per_call: classification.average_raw_tokens_per_call ?? 0, planning_workload_class: classification.factor_key ?? 'frontier_typical',
      planning_wh_per_call: planningWh, long_context_upper_wh_per_call: f.energy_wh_per_call.long_context_upper },
    energy_kwh, direct_water_liters, operational_co2_kg,
    comparisons_at_planning_scenario: comparisons(energy_kwh.planning, direct_water_liters.planning, operational_co2_kg.planning_us_grid),
    reduction_if_calls_drop_10_percent: { calls_avoided: report.model_calls * REDUCTION, energy_kwh_avoided: energy_kwh.planning * REDUCTION, direct_water_liters_avoided: direct_water_liters.planning * REDUCTION, operational_co2_kg_avoided: operational_co2_kg.planning_us_grid * REDUCTION },
    compensation_planning: { operational_co2_kg_to_cover: operational_co2_kg.long_context_us_grid, note: COMPENSATION_NOTE },
    scope: f.scope, assumptions: f.assumptions, sources: f.sources,
  };
}

function estimateCohort(cohort: CohortInput): CohortEstimate {
  const f = environmentalFactors;
  const zero = { energy_kwh: { efficient_production_floor: 0, planning: 0, long_context_upper: 0 }, direct_water_liters: { efficient_production_floor: 0, planning: 0, long_context_upper: 0 }, operational_co2_kg: { clean_energy_floor: 0, planning_us_grid: 0, long_context_us_grid: 0 } };
  const average = cohort.population.calls > 0 ? cohort.population.raw_tokens / cohort.population.calls : null;
  const storedKey = cohort.stored?.planning_workload_class as FactorKey | undefined;
  const storedClassKnown = typeof storedKey === 'string' && Object.hasOwn(WORKLOAD_CLASSES, storedKey);
  if (cohort.stored && cohort.selected.calls === cohort.population.calls) {
    // A merged legacy month, wholly selected, keeps the analyzer's numbers and method; nothing is recomputed or split.
    return { ...cohort, methodology_version: cohort.stored.methodology_version,
      classification: { workload_class: storedClassKnown ? WORKLOAD_CLASSES[storedKey!] : null, factor_key: storedClassKnown ? storedKey! : null,
        planning_wh_per_call: cohort.stored.planning_wh_per_call, average_raw_tokens_per_call: average, provisional: false, source: 'stored' },
      energy_kwh: cohort.stored.energy_kwh, direct_water_liters: cohort.stored.direct_water_liters, operational_co2_kg: cohort.stored.operational_co2_kg };
  }
  if (storedClassKnown) {
    // Part of a legacy month: the stored class is kept and applied to the selected calls with the current factors, under the current version.
    const planningWh = f.energy_wh_per_call[storedKey!];
    return { ...cohort, methodology_version: f.methodology_version,
      classification: { workload_class: WORKLOAD_CLASSES[storedKey!], factor_key: storedKey!, planning_wh_per_call: planningWh, average_raw_tokens_per_call: average, provisional: false, source: 'stored_class' },
      ...scenarioEstimate(cohort.selected.calls, planningWh) };
  }
  const classification = classifyPopulation(cohort.population);
  // No population calls means no class: the selected calls are disclosed as unestimated, never given a default factor.
  const scenarios = classification.planning_wh_per_call === null ? zero : scenarioEstimate(cohort.selected.calls, classification.planning_wh_per_call);
  return { ...cohort, methodology_version: f.methodology_version, classification: { ...classification, provisional: !cohort.month_closed, source: 'computed' }, ...scenarios };
}

/** Sums preclassified cohorts for the selected scope and returns the full, labeled estimate. */
export function estimateEnvironment(cohorts: CohortInput[], { headlineCalls }: { headlineCalls: number }): EnvironmentalEstimate {
  const f = environmentalFactors;
  const estimated = cohorts.map(estimateCohort).sort((a, b) => a.month.localeCompare(b.month) || a.account_id.localeCompare(b.account_id));
  const sum = (pick: (c: CohortEstimate) => number) => estimated.reduce((n, c) => n + pick(c), 0);
  // Derived figures come from the unrounded sums, as the analyzer derives them; rounding is the last step.
  const energyRaw = { efficient_production_floor: sum(c => c.energy_kwh.efficient_production_floor), planning: sum(c => c.energy_kwh.planning), long_context_upper: sum(c => c.energy_kwh.long_context_upper) };
  const waterRaw = { efficient_production_floor: sum(c => c.direct_water_liters.efficient_production_floor), planning: sum(c => c.direct_water_liters.planning), long_context_upper: sum(c => c.direct_water_liters.long_context_upper) };
  const carbonRaw = { clean_energy_floor: sum(c => c.operational_co2_kg.clean_energy_floor), planning_us_grid: sum(c => c.operational_co2_kg.planning_us_grid), long_context_us_grid: sum(c => c.operational_co2_kg.long_context_us_grid) };
  const energy = roundTriple(energyRaw), water = roundTriple(waterRaw), carbon = roundTriple(carbonRaw);
  const calls = sum(c => c.selected.calls), rawTokens = sum(c => c.selected.raw_tokens);
  const callsEstimated = sum(c => (c.classification.planning_wh_per_call !== null ? c.selected.calls : 0));
  return {
    kind: 'inference_equivalent_scenario_estimate', methodology_version: f.methodology_version, confidence: 'low',
    methodology_versions: [...new Set(estimated.map(c => c.methodology_version))].sort(),
    basis: { model_calls: calls, raw_tokens: rawTokens, average_raw_tokens_per_call: calls > 0 ? rawTokens / calls : null,
      cohorts: estimated.map(c => ({ ...c, energy_kwh: roundTriple(c.energy_kwh), direct_water_liters: roundTriple(c.direct_water_liters), operational_co2_kg: roundTriple(c.operational_co2_kg) })),
      classification_unit: 'methodology version + account and provider + source calendar month; a filter sums the cohort’s selected calls under its class and never reclassifies it',
      long_context_upper_wh_per_call: f.energy_wh_per_call.long_context_upper, planning_context_threshold_tokens_per_call: f.planning_context_threshold_tokens_per_call },
    energy_kwh: energy, direct_water_liters: water, operational_co2_kg: carbon,
    scenarios: [
      { key: 'efficient_production_floor', label: 'Efficient production floor', unit: 'kWh', factor: `${f.energy_wh_per_call.efficient_production_floor} Wh per call` },
      { key: 'planning', label: 'Planning scenario', unit: 'kWh', factor: `${f.energy_wh_per_call.frontier_typical} Wh per call, or ${f.energy_wh_per_call.reasoning_heavy} Wh per call for a cohort averaging at least ${f.planning_context_threshold_tokens_per_call.toLocaleString('en-US')} raw tokens per call` },
      { key: 'long_context_upper', label: 'Long-context upper scenario', unit: 'kWh', factor: `${f.energy_wh_per_call.long_context_upper} Wh per call` },
      { key: 'water_efficient', label: 'Direct water, efficient floor', unit: 'L', factor: `${f.direct_water.efficient_production_ml_per_call} mL per call` },
      { key: 'water_planning', label: 'Direct water, planning', unit: 'L', factor: `planning kWh × ${f.direct_water.planning_wue_liters_per_kwh} L/kWh` },
      { key: 'water_upper', label: 'Direct water, upper', unit: 'L', factor: `upper kWh × ${f.direct_water.upper_wue_liters_per_kwh} L/kWh` },
      { key: 'carbon_clean', label: 'Operational CO2e, clean-energy floor', unit: 'kg CO2e', factor: `${f.operational_carbon.clean_energy_kg_per_call} kg per call` },
      { key: 'carbon_planning', label: 'Operational CO2e, planning on the U.S. grid', unit: 'kg CO2e', factor: `planning kWh × ${f.operational_carbon.us_grid_kg_per_kwh} kg/kWh` },
      { key: 'carbon_upper', label: 'Operational CO2e, upper on the U.S. grid', unit: 'kg CO2e', factor: `upper kWh × ${f.operational_carbon.us_grid_kg_per_kwh} kg/kWh` },
    ],
    comparisons_at_planning_scenario: roundTriple(comparisons(energyRaw.planning, waterRaw.planning, carbonRaw.planning_us_grid)),
    reduction_if_calls_drop_10_percent: roundTriple({ calls_avoided: calls * REDUCTION, energy_kwh_avoided: energyRaw.planning * REDUCTION, direct_water_liters_avoided: waterRaw.planning * REDUCTION, operational_co2_kg_avoided: carbonRaw.planning_us_grid * REDUCTION }),
    compensation_planning: { operational_co2_kg_to_cover: round6(carbonRaw.long_context_us_grid), note: COMPENSATION_NOTE },
    coverage: { calls_estimated: callsEstimated, calls_headline: headlineCalls, calls_without_class: Math.max(0, headlineCalls - callsEstimated),
      cohorts_provisional: estimated.filter(c => c.classification.provisional).length, cohorts_stored: estimated.filter(c => c.classification.source === 'stored').length,
      note: 'Only selected calls with a classified cohort are estimated; calls without call-level evidence stay unestimated rather than filled from tokens, dollars, or allowance movement. A closed month\u2019s class is recomputed from the retained ledger on each read, so a later backfill into that month can change it.' },
    scope: f.scope,
    assumptions: [...f.assumptions.map(a => a.replace('the 4.32 Wh reasoning-heavy planning scenario', 'the 4.32 Wh high-context-per-call planning scenario (the factor file\u2019s reasoning_heavy key)')),
      'The planning class the factor file calls reasoning_heavy is a workload-size proxy inferred from raw tokens per call, reported here as high_context_per_call; it does not measure reasoning effort.'],
    sources: f.sources,
  };
}
