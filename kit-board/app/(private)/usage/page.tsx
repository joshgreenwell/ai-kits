"use client";

import { useEffect, useMemo, useState } from "react";
import { MachineReporters } from "@/components/machine-reporters";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { fetchPrivateJson } from "@/lib/fetch-private-json";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import environmentalFactors from "./environmental-factors.json";
import "@/app/usage-header.css";

interface UsageRow { key: string; total_tokens: number; calls?: number }
interface CostRow extends UsageRow {
  estimated_cost_usd: number;
  priced_tokens: number;
  unpriced_tokens: number;
  input_cost_usd?: number;
  cached_input_cost_usd?: number;
  cache_write_input_cost_usd?: number;
  reasoning_output_cost_usd?: number;
  other_output_cost_usd?: number;
}
interface CostDimensionRow extends CostRow { model: string; reasoning_effort: string; service_tier: string }
interface ApiEquivalentCost {
  kind: "api_equivalent_estimate";
  currency: string;
  estimated_cost_usd: number;
  priced_tokens: number;
  unpriced_tokens: number;
  priced_token_coverage: number;
  missing_service_tier_calls_assumed_standard: number;
  component_costs_usd: {
    input_cost_usd: number;
    cached_input_cost_usd: number;
    cache_write_input_cost_usd: number;
    reasoning_output_cost_usd: number;
    other_output_cost_usd: number;
  };
  by_model: CostRow[];
  by_reasoning_effort: CostRow[];
  by_service_tier: CostRow[];
  by_model_effort_service_tier: CostDimensionRow[];
  pricing_catalog: { version: string; long_context_threshold_tokens: number; sources: { label: string; url: string }[] };
  assumptions: string[];
}
interface EnvironmentalEstimate {
  kind: "inference_equivalent_scenario_estimate";
  methodology_version: string;
  confidence: "low";
  basis: {
    model_calls: number;
    raw_tokens: number;
    fresh_non_cached_tokens: number;
    cached_input_tokens: number;
    average_raw_tokens_per_call: number;
    planning_workload_class: string;
    planning_wh_per_call: number;
    long_context_upper_wh_per_call: number;
  };
  energy_kwh: { efficient_production_floor: number; planning: number; long_context_upper: number };
  direct_water_liters: { efficient_production_floor: number; planning: number; long_context_upper: number };
  operational_co2_kg: { clean_energy_floor: number; planning_us_grid: number; long_context_us_grid: number };
  comparisons_at_planning_scenario: {
    average_showers: number;
    us_home_days_of_electricity: number;
    smartphone_full_charges: number;
    urban_tree_seedlings_grown_10_years: number;
    average_gasoline_vehicle_miles: number;
  };
  reduction_if_calls_drop_10_percent: {
    calls_avoided: number;
    energy_kwh_avoided: number;
    direct_water_liters_avoided: number;
    operational_co2_kg_avoided: number;
  };
  compensation_planning: { operational_co2_kg_to_cover: number; note: string };
  scope: string;
  assumptions: string[];
  sources: { label: string; url: string; supports: string }[];
}
interface TaskRow { label: string; total_tokens: number; sessions: number }
interface DailyRow { date: string; total_tokens: number; calls: number; threads?: number }
interface Totals { total_tokens: number; fresh_non_cached_tokens: number; calls: number; threads: number; root_tasks: number; active_days: number; calendar_days: number; average_per_call: number; average_per_active_day: number }
interface Composition { cached_input_tokens: number; uncached_input_tokens: number; reasoning_output_tokens: number; nonreasoning_output_tokens: number; unclassified_total_only_tokens: number }
interface CurrentReport {
  month: string;
  label: string;
  totals: Totals;
  exclusive_composition: Composition;
  api_equivalent_cost?: ApiEquivalentCost;
  environmental_estimate?: EnvironmentalEstimate;
  by_work_mode: UsageRow[];
  by_project: UsageRow[];
  by_theme: UsageRow[];
  top_root_tasks: TaskRow[];
  top_days: DailyRow[];
  daily: DailyRow[];
  agent_orchestration: { spawns: { total: number; custom: number; generic: number; depths: [number, number][] }; configured_custom_role_count: number; used_custom_roles: string[] };
  knowledge_brain: { direct_tool_calls: number; tool_search_attempts: number; indirect_shell_or_exec_calls: number; game_design_threads: number; game_design_tokens: number };
}
interface ReportEnvelope { schema_version: number; machine_id: string; machine_name: string; report: { generated_at_local: string; data_scope?: string; data_quality?: string; collection?: { kind: string; period_state: "partial" | "complete"; interval_minutes: number }; current: CurrentReport; previous: { label: string; totals: Partial<Totals> }; optimization_recommendations?: string[] } }
interface StoredReport {
  id: number;
  machine_id: string;
  machine_name: string;
  month: string;
  raw_tokens: number;
  fresh_tokens: number;
  cached_input_tokens: number;
  model_calls: number;
  thread_count: number;
  agent_spawns: number;
  custom_agent_spawns: number;
  subagent_tokens: number;
  custom_agent_tokens: number;
  game_design_tokens: number;
  direct_brain_calls: number;
  uploaded_at: string;
  envelope: ReportEnvelope;
}

function formatTokens(value: number) {
  for (const [divisor, suffix] of [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "K"]] as const) {
    if (Math.abs(value) >= divisor) return `${(value / divisor).toFixed(2)}${suffix}`;
  }
  return Math.round(value).toLocaleString();
}

function formatPercent(value: number, signed = false) {
  if (!Number.isFinite(value)) return "n/a";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${(value * 100).toFixed(1)}%`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 1 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

function formatQuantity(value: number, maximumFractionDigits = 1) {
  if (!Number.isFinite(value)) return "n/a";
  if (value > 0 && value < 0.01) return "<0.01";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function formatEnergy(value: number) {
  return value < 1 ? `${formatQuantity(value * 1000, 0)} Wh` : `${formatQuantity(value)} kWh`;
}

function formatWater(value: number) {
  return value < 1 ? `${formatQuantity(value * 1000, 0)} mL` : `${formatQuantity(value)} L`;
}

function formatCarbon(value: number) {
  return value < 1 ? `${formatQuantity(value * 1000, 0)} g` : `${formatQuantity(value)} kg`;
}

function formatMonth(month: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

function fallbackEnvironmentalEstimate(row: StoredReport): EnvironmentalEstimate {
  const factors = environmentalFactors;
  const calls = row.model_calls;
  const averagePerCall = calls ? row.raw_tokens / calls : 0;
  const planningClass = averagePerCall >= factors.planning_context_threshold_tokens_per_call ? "reasoning_heavy" : "frontier_typical";
  const planningWhPerCall = factors.energy_wh_per_call[planningClass];
  const energy = {
    efficient_production_floor: calls * factors.energy_wh_per_call.efficient_production_floor / 1000,
    planning: calls * planningWhPerCall / 1000,
    long_context_upper: calls * factors.energy_wh_per_call.long_context_upper / 1000,
  };
  const water = {
    efficient_production_floor: calls * factors.direct_water.efficient_production_ml_per_call / 1000,
    planning: energy.planning * factors.direct_water.planning_wue_liters_per_kwh,
    long_context_upper: energy.long_context_upper * factors.direct_water.upper_wue_liters_per_kwh,
  };
  const carbon = {
    clean_energy_floor: calls * factors.operational_carbon.clean_energy_kg_per_call,
    planning_us_grid: energy.planning * factors.operational_carbon.us_grid_kg_per_kwh,
    long_context_us_grid: energy.long_context_upper * factors.operational_carbon.us_grid_kg_per_kwh,
  };
  const comparisons = factors.comparisons;
  return {
    kind: "inference_equivalent_scenario_estimate",
    methodology_version: factors.methodology_version,
    confidence: "low",
    basis: {
      model_calls: calls,
      raw_tokens: row.raw_tokens,
      fresh_non_cached_tokens: row.fresh_tokens,
      cached_input_tokens: row.cached_input_tokens,
      average_raw_tokens_per_call: averagePerCall,
      planning_workload_class: planningClass,
      planning_wh_per_call: planningWhPerCall,
      long_context_upper_wh_per_call: factors.energy_wh_per_call.long_context_upper,
    },
    energy_kwh: energy,
    direct_water_liters: water,
    operational_co2_kg: carbon,
    comparisons_at_planning_scenario: {
      average_showers: water.planning / comparisons.average_shower_liters,
      us_home_days_of_electricity: energy.planning / comparisons.us_home_kwh_per_day,
      smartphone_full_charges: energy.planning / comparisons.smartphone_charge_kwh,
      urban_tree_seedlings_grown_10_years: carbon.planning_us_grid / comparisons.urban_tree_seedling_kg_co2_over_10_years,
      average_gasoline_vehicle_miles: carbon.planning_us_grid / comparisons.average_gasoline_vehicle_kg_co2e_per_mile,
    },
    reduction_if_calls_drop_10_percent: {
      calls_avoided: calls * 0.1,
      energy_kwh_avoided: energy.planning * 0.1,
      direct_water_liters_avoided: water.planning * 0.1,
      operational_co2_kg_avoided: carbon.planning_us_grid * 0.1,
    },
    compensation_planning: {
      operational_co2_kg_to_cover: carbon.long_context_us_grid,
      note: "If compensating, use at least the upper operational scenario and a verified durable-removal method. Tree equivalents are illustrations, not offset certificates.",
    },
    scope: factors.scope,
    assumptions: factors.assumptions,
    sources: factors.sources,
  };
}

function aggregateEnvironmental(rows: StoredReport[]) {
  const estimates = rows.map((row) => row.envelope.report.current.environmental_estimate ?? fallbackEnvironmentalEstimate(row));
  const sum = (selector: (estimate: EnvironmentalEstimate) => number) => estimates.reduce((total, estimate) => total + selector(estimate), 0);
  const energy = {
    low: sum((estimate) => estimate.energy_kwh.efficient_production_floor),
    planning: sum((estimate) => estimate.energy_kwh.planning),
    high: sum((estimate) => estimate.energy_kwh.long_context_upper),
  };
  const water = {
    low: sum((estimate) => estimate.direct_water_liters.efficient_production_floor),
    planning: sum((estimate) => estimate.direct_water_liters.planning),
    high: sum((estimate) => estimate.direct_water_liters.long_context_upper),
  };
  const carbon = {
    low: sum((estimate) => estimate.operational_co2_kg.clean_energy_floor),
    planning: sum((estimate) => estimate.operational_co2_kg.planning_us_grid),
    high: sum((estimate) => estimate.operational_co2_kg.long_context_us_grid),
  };
  const comparisons = environmentalFactors.comparisons;
  return {
    energy,
    water,
    carbon,
    equivalents: {
      showers: water.planning / comparisons.average_shower_liters,
      homeDays: energy.planning / comparisons.us_home_kwh_per_day,
      phoneCharges: energy.planning / comparisons.smartphone_charge_kwh,
      treeSeedlings: carbon.planning / comparisons.urban_tree_seedling_kg_co2_over_10_years,
      gasolineCarMiles: carbon.planning / comparisons.average_gasoline_vehicle_kg_co2e_per_mile,
    },
    reduction: {
      calls: sum((estimate) => estimate.reduction_if_calls_drop_10_percent.calls_avoided),
      energy: energy.planning * 0.1,
      water: water.planning * 0.1,
      carbon: carbon.planning * 0.1,
    },
    methodologyVersions: [...new Set(estimates.map((estimate) => estimate.methodology_version))],
  };
}

function aggregateRows(rows: StoredReport[], selector: (report: StoredReport) => UsageRow[]) {
  const values = new Map<string, number>();
  for (const row of rows) {
    for (const item of selector(row)) values.set(item.key, (values.get(item.key) ?? 0) + item.total_tokens);
  }
  return [...values].map(([key, total_tokens]) => ({ key, total_tokens })).sort((a, b) => b.total_tokens - a.total_tokens);
}

function aggregateTasks(rows: StoredReport[]) {
  const values = new Map<string, { total_tokens: number; sessions: number }>();
  for (const row of rows) {
    for (const task of row.envelope.report.current.top_root_tasks ?? []) {
      const current = values.get(task.label) ?? { total_tokens: 0, sessions: 0 };
      current.total_tokens += task.total_tokens;
      current.sessions += task.sessions;
      values.set(task.label, current);
    }
  }
  return [...values].map(([label, value]) => ({ label, ...value })).sort((a, b) => b.total_tokens - a.total_tokens);
}

function aggregateCostDimensions(rows: StoredReport[]) {
  const values = new Map<string, CostDimensionRow>();
  for (const report of rows) {
    for (const item of report.envelope.report.current.api_equivalent_cost?.by_model_effort_service_tier ?? []) {
      const id = [item.model, item.reasoning_effort, item.service_tier].join("\u0000");
      const current = values.get(id) ?? {
        model: item.model,
        reasoning_effort: item.reasoning_effort,
        service_tier: item.service_tier,
        key: id,
        total_tokens: 0,
        calls: 0,
        estimated_cost_usd: 0,
        priced_tokens: 0,
        unpriced_tokens: 0,
      };
      current.total_tokens += item.total_tokens;
      current.calls = (current.calls ?? 0) + (item.calls ?? 0);
      current.estimated_cost_usd += item.estimated_cost_usd;
      current.priced_tokens += item.priced_tokens;
      current.unpriced_tokens += item.unpriced_tokens;
      values.set(id, current);
    }
  }
  return [...values.values()].sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd || b.total_tokens - a.total_tokens);
}

export default function Home() {
  const [reports, setReports] = useState<StoredReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedMonth, setSelectedMonth] = useState("");
  const [selectedMachine, setSelectedMachine] = useState("all");
  const [now, setNow] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (document.hidden || inFlight || controller.signal.aborted) return;
      inFlight = true; setNow(Date.now());
      try {
        const payload = await fetchPrivateJson<{ reports: StoredReport[] }>("/api/reports", controller.signal);
        if (!controller.signal.aborted) { setReports(payload.reports); setError(""); }
      } catch { if (!controller.signal.aborted) setError("Report refresh is temporarily unavailable. Showing the last loaded snapshots."); }
      finally { inFlight = false; if (!controller.signal.aborted) setLoading(false); }
    };
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh(); const timer = setInterval(refresh, 60_000);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);

  const months = useMemo(() => [...new Set(reports.map((row) => row.month))].sort().reverse(), [reports]);
  const activeMonth = selectedMonth || months[0] || "";
  const monthRows = reports.filter((row) => row.month === activeMonth);
  const visibleRows = selectedMachine === "all" ? monthRows : monthRows.filter((row) => row.machine_id === selectedMachine);
  const localMonth = now ? `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, "0")}` : '';
  const partialMonth = activeMonth === localMonth || visibleRows.some(row => row.envelope.report.collection?.period_state === 'partial');
  const hourlyMachines = visibleRows.filter(row => row.envelope.report.collection?.kind === 'hourly_detailed_report').length;
  const rawTotal = visibleRows.reduce((sum, row) => sum + row.raw_tokens, 0);
  const freshTotal = visibleRows.reduce((sum, row) => sum + row.fresh_tokens, 0);
  const calls = visibleRows.reduce((sum, row) => sum + row.model_calls, 0);
  const threads = visibleRows.reduce((sum, row) => sum + row.thread_count, 0);
  const previousTotal = visibleRows.reduce((sum, row) => sum + Number(row.envelope.report.previous.totals.total_tokens ?? 0), 0);
  const previousCalls = visibleRows.reduce((sum, row) => sum + Number(row.envelope.report.previous.totals.calls ?? 0), 0);
  const monthChange = previousTotal ? (rawTotal - previousTotal) / previousTotal : 0;
  const callChange = previousCalls ? (calls - previousCalls) / previousCalls : 0;
  const averagePerCall = calls ? rawTotal / calls : 0;
  const composition = visibleRows.reduce(
    (total, row) => {
      const value = row.envelope.report.current.exclusive_composition;
      total.cached += value.cached_input_tokens;
      total.uncached += value.uncached_input_tokens;
      total.output += value.reasoning_output_tokens + value.nonreasoning_output_tokens + value.unclassified_total_only_tokens;
      return total;
    },
    { cached: 0, uncached: 0, output: 0 },
  );
  const cacheShare = rawTotal ? composition.cached / rawTotal : 0;
  const projects = aggregateRows(visibleRows, (row) => row.envelope.report.current.by_project ?? []);
  const themes = aggregateRows(visibleRows, (row) => row.envelope.report.current.by_theme ?? []);
  const tasks = aggregateTasks(visibleRows);
  const agentSpawns = visibleRows.reduce((sum, row) => sum + row.agent_spawns, 0);
  const customSpawns = visibleRows.reduce((sum, row) => sum + row.custom_agent_spawns, 0);
  const subagentTokens = visibleRows.reduce((sum, row) => sum + row.subagent_tokens, 0);
  const agentShare = rawTotal ? subagentTokens / rawTotal : 0;
  const directBrainCalls = visibleRows.reduce((sum, row) => sum + row.direct_brain_calls, 0);
  const indirectBrainCalls = visibleRows.reduce((sum, row) => sum + row.envelope.report.current.knowledge_brain.indirect_shell_or_exec_calls, 0);
  const gameTokens = visibleRows.reduce((sum, row) => sum + row.game_design_tokens, 0);
  const recommendations = [...new Set(visibleRows.flatMap((row) => row.envelope.report.optimization_recommendations ?? []))].slice(0, 5);
  const costSnapshots = visibleRows.map((row) => row.envelope.report.current.api_equivalent_cost);
  const estimatedCost = costSnapshots.reduce((sum, cost) => sum + Number(cost?.estimated_cost_usd ?? 0), 0);
  const pricedTokens = costSnapshots.reduce((sum, cost) => sum + Number(cost?.priced_tokens ?? 0), 0);
  const explicitlyUnpriced = costSnapshots.reduce((sum, cost) => sum + Number(cost?.unpriced_tokens ?? 0), 0);
  const legacyUnpriced = visibleRows.reduce((sum, row) => sum + (row.envelope.report.current.api_equivalent_cost ? 0 : row.raw_tokens), 0);
  const unpricedTokens = explicitlyUnpriced + legacyUnpriced;
  const pricingCoverage = pricedTokens + unpricedTokens ? pricedTokens / (pricedTokens + unpricedTokens) : 0;
  const assumedTierCalls = costSnapshots.reduce((sum, cost) => sum + Number(cost?.missing_service_tier_calls_assumed_standard ?? 0), 0);
  const reasoningCost = costSnapshots.reduce((sum, cost) => sum + Number(cost?.component_costs_usd?.reasoning_output_cost_usd ?? 0), 0);
  const inputCost = costSnapshots.reduce((sum, cost) => sum + Number(cost?.component_costs_usd?.input_cost_usd ?? 0) + Number(cost?.component_costs_usd?.cache_write_input_cost_usd ?? 0), 0);
  const cachedCost = costSnapshots.reduce((sum, cost) => sum + Number(cost?.component_costs_usd?.cached_input_cost_usd ?? 0), 0);
  const otherOutputCost = costSnapshots.reduce((sum, cost) => sum + Number(cost?.component_costs_usd?.other_output_cost_usd ?? 0), 0);
  const costDimensions = aggregateCostDimensions(visibleRows);
  const fastTokens = costDimensions.filter((row) => ["fast", "priority"].includes(row.service_tier.toLowerCase())).reduce((sum, row) => sum + row.total_tokens, 0);
  const pricingCatalogs = [...new Set(costSnapshots.map((cost) => cost?.pricing_catalog?.version).filter(Boolean))];
  const environment = aggregateEnvironmental(visibleRows);

  const dayTotals = new Map<string, { tokens: number; calls: number }>();
  for (const row of visibleRows) {
    for (const day of row.envelope.report.current.daily ?? []) {
      const value = dayTotals.get(day.date) ?? { tokens: 0, calls: 0 };
      value.tokens += day.total_tokens;
      value.calls += day.calls;
      dayTotals.set(day.date, value);
    }
  }
  const days = [...dayTotals].map(([date, value]) => ({ date, ...value })).sort((a, b) => a.date.localeCompare(b.date));
  const peakDay = days.reduce((peak, day) => day.tokens > peak.tokens ? day : peak, { date: "—", tokens: 0, calls: 0 });
  const maxDay = Math.max(...days.map((day) => day.tokens), 1);
  const selectedLabel = activeMonth ? formatMonth(activeMonth) : "No reports";

  if (loading) return <main><section className="empty-state"><span className="kicker">Token Observatory</span><h1>Loading report history…</h1></section></main>;
  if (error && !reports.length) return <main><section className="empty-state"><span className="kicker">Connection issue</span><h1>{error}</h1></section></main>;
  if (!reports.length) return <main><section className="empty-state"><span className="kicker">Token Observatory</span><h1>Ready for the first monthly upload.</h1><p>The database is connected. Run the token skill with its upload configuration to populate this dashboard.</p></section></main>;

  return (
    <main className="usage-workspace">
      <PageHeader
        className="usage-page-header"
        eyebrow={selectedLabel}
        title="Monthly AI intelligence"
        actions={
          <>
            <MachineReporters machines={monthRows} />
            <Select value={activeMonth} onValueChange={(month) => { setSelectedMonth(month); setSelectedMachine("all"); }}>
              <SelectTrigger className="usage-month-select" aria-label="Report month">
                <SelectValue placeholder="Report month" />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {months.map((month) => <SelectItem key={month} value={month}>{formatMonth(month)}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        }
      />

      {error && <p role="alert" className="telemetry-notice">{error}</p>}
      <p className="detailed-report-status">{partialMonth ? 'Month to date · full report detail' : 'Full monthly report'} · {hourlyMachines ? `${hourlyMachines} of ${visibleRows.length} selected machine reports refresh hourly` : 'Scheduled and manual report snapshots'}. {partialMonth && 'Prior-month percentage comparisons resume after this month closes.'}</p>
      <section className="hero" id="top">
        <div className="hero-grid">
          <div className="headline-number"><div className="metric-label">{selectedMachine === "all" ? "Combined" : "Machine"} raw volume</div><strong>{formatTokens(rawTotal)}</strong>{partialMonth ? <div className="delta"><span>In progress · through each machine’s latest snapshot</span></div> : <div className={`delta ${monthChange >= 0 ? "up" : "down"}`}>{monthChange >= 0 ? "↑" : "↓"} {formatPercent(Math.abs(monthChange))} <span>from prior month</span></div>}</div>
        </div>
        <div className="quick-stats">
          <div><span>Model calls</span><strong>{calls.toLocaleString()}</strong></div>
          <div><span>Average / call</span><strong>{formatTokens(averagePerCall)}</strong></div>
          <div><span>Threads</span><strong>{threads.toLocaleString()}</strong></div>
          <div><span>Game design</span><strong>{formatPercent(rawTotal ? gameTokens / rawTotal : 0)}</strong></div>
        </div>
      </section>

      <section className="overview-grid" aria-label="Usage overview">
        <article className="panel composition-panel">
          <div className="panel-heading"><div><span className="kicker">Context composition</span><h2>Mostly reused, not newly generated.</h2></div><span className="quiet-pill">{formatPercent(cacheShare)} cached</span></div>
          <div className="composition-bar" aria-label={`${formatPercent(cacheShare)} cached input`}><span className="cached" style={{ width: `${cacheShare * 100}%` }} /><span className="fresh" style={{ width: `${rawTotal ? composition.uncached / rawTotal * 100 : 0}%` }} /><span className="output" style={{ width: `${rawTotal ? composition.output / rawTotal * 100 : 0}%` }} /></div>
          <div className="legend-row">
            <div><i className="dot cached-dot" /><span>Cached input</span><strong>{formatTokens(composition.cached)}</strong></div>
            <div><i className="dot fresh-dot" /><span>Uncached input</span><strong>{formatTokens(composition.uncached)}</strong></div>
            <div><i className="dot output-dot" /><span>Output + other</span><strong>{formatTokens(composition.output)}</strong></div>
          </div>
        </article>
        <article className="panel fresh-panel"><span className="kicker">Fresh / non-cached</span><strong className="panel-number">{formatTokens(freshTotal)}</strong><p>{formatPercent(rawTotal ? freshTotal / rawTotal : 0)} of total volume</p><div className="mini-rule"><span /></div><p className="insight">{partialMonth ? "Month-to-date activity; " : `Call count changed ${formatPercent(callChange, true)}; `}average context was {formatTokens(averagePerCall)} per call.</p></article>
      </section>

      <section className="panel activity-panel">
        <div className="panel-heading activity-heading"><div><span className="kicker">Daily volume</span><h2>When activity concentrated.</h2></div><div className="peak-note"><span>Peak</span><strong>{formatTokens(peakDay.tokens)}</strong><small>{peakDay.date}</small></div></div>
        <div className="chart" aria-label={`Daily volume for ${selectedLabel}`}><div className="chart-grid"><span /><span /><span /><span /></div><div className="bars">{days.map((day) => <span key={day.date} title={`${day.date}: ${formatTokens(day.tokens)}`} style={{ height: `${Math.max(4, day.tokens / maxDay * 100)}%` }} className={day.date === peakDay.date ? "peak" : ""} />)}</div></div>
        <div className="chart-axis"><span>{days.at(0)?.date ?? "—"}</span><span>{days.at(Math.floor(days.length / 2))?.date ?? "—"}</span><span>{days.at(-1)?.date ?? "—"}</span></div>
      </section>

      <section className="panel cost-panel" aria-label="API-equivalent cost estimate">
        <div className="panel-heading cost-heading"><div><span className="kicker">API-equivalent pricing</span><h2>What this usage would cost through the API.</h2></div><span className="quiet-pill">{formatPercent(pricingCoverage)} priced</span></div>
        <div className="cost-summary">
          <div className="cost-total"><span>Estimated API cost</span><strong>{formatCurrency(estimatedCost)}</strong><p>This is a comparison estimate—not your Codex subscription bill or credit usage.</p></div>
          <div className="cost-stat-grid">
            <div><span>Priced coverage</span><strong>{formatPercent(pricingCoverage)}</strong><small>{formatTokens(unpricedTokens)} unpriced</small></div>
            <div><span>Fast / Priority</span><strong>{formatPercent(rawTotal ? fastTokens / rawTotal : 0)}</strong><small>{formatTokens(fastTokens)} raw tokens</small></div>
            <div><span>Reasoning output</span><strong>{formatCurrency(reasoningCost)}</strong><small>charged at output rate</small></div>
            <div><span>Tier assumed</span><strong>{assumedTierCalls.toLocaleString()}</strong><small>calls treated as Standard</small></div>
          </div>
        </div>
        <div className="cost-detail-grid">
          <div className="cost-components"><span className="kicker">Cost composition</span>
            <div><span>Uncached input</span><strong>{formatCurrency(inputCost)}</strong></div>
            <div><span>Cached input</span><strong>{formatCurrency(cachedCost)}</strong></div>
            <div><span>Reasoning output</span><strong>{formatCurrency(reasoningCost)}</strong></div>
            <div><span>Other output</span><strong>{formatCurrency(otherOutputCost)}</strong></div>
          </div>
          <div className="cost-table-wrap"><div className="cost-table-head"><span>Model</span><span>Effort</span><span>Speed</span><span>Usage</span><span>Estimate</span></div>
            {costDimensions.slice(0, 10).map((row) => <div className="cost-table-row" key={row.key}><strong>{row.model}</strong><span>{row.reasoning_effort}</span><span>{row.service_tier.replace("assumed_standard", "Standard*")}</span><small>{formatTokens(row.total_tokens)} · {(row.calls ?? 0).toLocaleString()} calls</small><b>{formatCurrency(row.estimated_cost_usd)}</b></div>)}
            {!costDimensions.length && <p className="cost-empty">Re-run this month with the updated analyzer to add model, effort, and speed pricing.</p>}
          </div>
        </div>
        <div className="cost-footnote"><span>Rates {pricingCatalogs.join(", ") || "not recorded"}</span><p>Reasoning effort changes token volume, not the per-token rate. Requests above 272K logged input use long-context pricing. Separate tool fees, images, regional processing, and subscription credits are excluded.</p></div>
      </section>

      <section className="panel environment-panel" aria-label="Environmental scenario estimate">
        <div className="environment-heading">
          <div><span className="kicker">Environmental scenarios</span><h2>A footprint estimate—with the uncertainty left on.</h2></div>
          <span className="scenario-badge">Not metered · inference only</span>
        </div>
        <p className="environment-intro">Codex does not expose datacenter power, water, hardware, location, or grid telemetry. These are call-based analogues: an efficient production floor, a reasoning-heavy planning scenario for this long-context workload, and a long-prompt upper scenario.</p>
        <div className="environment-grid">
          <article className="environment-card energy-card">
            <span className="environment-icon" aria-hidden="true">↯</span><span className="metric-label">Electricity · planning</span>
            <strong>{formatEnergy(environment.energy.planning)}</strong>
            <p>About <b>{formatQuantity(environment.equivalents.homeDays)}</b> U.S. home-days or <b>{formatQuantity(environment.equivalents.phoneCharges, 0)}</b> full smartphone charges.</p>
            <small>{formatEnergy(environment.energy.low)} – {formatEnergy(environment.energy.high)} scenario range</small>
          </article>
          <article className="environment-card water-card">
            <span className="environment-icon" aria-hidden="true">◌</span><span className="metric-label">Direct water · planning</span>
            <strong>{formatWater(environment.water.planning)}</strong>
            <p>Roughly <b>{formatQuantity(environment.equivalents.showers, 2)}</b> average eight-minute showers.</p>
            <small>{formatWater(environment.water.low)} – {formatWater(environment.water.high)} scenario range</small>
          </article>
          <article className="environment-card carbon-card">
            <span className="environment-icon" aria-hidden="true">◇</span><span className="metric-label">Operational CO2e · planning</span>
            <strong>{formatCarbon(environment.carbon.planning)}</strong>
            <p>Same emissions as driving an average gasoline-powered car about <b>{formatQuantity(environment.equivalents.gasolineCarMiles, 0)} miles</b>.</p>
            <small>{formatCarbon(environment.carbon.low)} – {formatCarbon(environment.carbon.high)} scenario range</small>
          </article>
        </div>
        <div className="scenario-track" aria-label="Per-call electricity scenarios">
          <div><span>Efficient production</span><strong>0.24 Wh / call</strong><i style={{ width: "12%" }} /></div>
          <div><span>Planning scenario</span><strong>4.32 Wh / call</strong><i style={{ width: "45%" }} /></div>
          <div><span>Long-context upper</span><strong>33 Wh / call</strong><i style={{ width: "100%" }} /></div>
        </div>
        <div className="impact-actions">
          <div><span className="kicker">A measurable reduction</span><h3>Cutting calls 10% saves about {formatEnergy(environment.reduction.energy)}.</h3><p>That also models {formatWater(environment.reduction.water)} of direct water and {formatCarbon(environment.reduction.carbon)} CO2e avoided. Phase handoffs, bounded agents, and fresh tasks target repeated calls while preserving the useful work.</p></div>
          <div><span className="kicker">Tree planting example</span><h3>About {formatQuantity(environment.equivalents.treeSeedlings, 0)} urban tree seedlings, grown for 10 years.</h3><p>That EPA comparison matches the planning estimate after a decade of growth. It is delayed biological sequestration—not an immediate or verified offset.</p></div>
        </div>
        <details className="methodology-note">
          <summary>Methodology, scope, and sources</summary>
          <p>{environmentalFactors.scope}</p>
          <p>Raw and cached tokens describe workload shape, but are not converted with an invented joules-per-token factor. Method {environment.methodologyVersions.join(", ")} uses observed call counts; an average context above 50K raw tokens per call selects the 4.32 Wh reasoning-heavy planning scenario.</p>
          <div className="source-links">{environmentalFactors.sources.filter((source) => source.url).map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label}<span>↗</span></a>)}</div>
        </details>
      </section>

      <section className="section-block">
        <div className="section-title"><div><span className="kicker">Sources</span><h2>{monthRows.length} machine{monthRows.length === 1 ? "" : "s"}, distinct workflows.</h2></div><p>Each computer publishes the full local analysis. Hourly-enabled collectors refresh the current month; other machines keep their existing upload schedule. Choose a machine to inspect its snapshot.</p></div>
        <div className="machine-grid">
          {monthRows.map((machine, index) => {
            const share = monthRows.reduce((sum, row) => sum + row.raw_tokens, 0);
            const focused = selectedMachine === machine.machine_id;
            return <article className={`machine-card ${index % 2 ? "mint" : "violet"} ${focused ? "selected" : ""}`} key={machine.machine_id}>
              <div className="machine-top"><span className="machine-icon" aria-hidden="true">●</span><span className="machine-share">{formatPercent(share ? machine.raw_tokens / share : 0)} of month</span></div>
              <h3>{machine.machine_name}</h3><p>{formatTokens(machine.game_design_tokens)} game-design · {machine.agent_spawns} agent spawns</p>
              <p className="machine-snapshot-age">{machine.envelope.report.collection?.kind === 'hourly_detailed_report' ? 'Hourly detail · snapshot changed ' : 'Snapshot generated '}{new Date(machine.envelope.report.generated_at_local).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
              <details className="telemetry-details"><summary>Source coverage</summary><p>{machine.envelope.report.data_scope || 'This machine’s uploaded local analysis.'}</p>{machine.envelope.report.data_quality && <p>Data quality: {machine.envelope.report.data_quality.replaceAll('_', ' ')}</p>}<p>Unchanged analysis does not create another snapshot. Check Connections for collector health.</p></details>
              <div className="machine-metrics"><div><span>Raw tokens</span><strong>{formatTokens(machine.raw_tokens)}</strong></div><div><span>Fresh volume</span><strong>{formatTokens(machine.fresh_tokens)}</strong></div></div>
              <Button type="button" variant="outline" className="machine-focus-button" onClick={() => setSelectedMachine(focused ? "all" : machine.machine_id)}>{focused ? "Return to combined report" : "Focus machine report"} <span>→</span></Button>
            </article>;
          })}
        </div>
      </section>

      <section className="bottom-grid">
        <article className="panel driver-panel"><span className="kicker">Largest drivers</span><h2>Where the month went</h2><ol className="driver-list">{projects.slice(0, 5).map((project, index) => <li key={project.key}><span className="rank">{String(index + 1).padStart(2, "0")}</span><div><strong>{project.key}</strong><small>{formatTokens(project.total_tokens)} raw tokens</small></div><b>{formatPercent(rawTotal ? project.total_tokens / rawTotal : 0)}</b></li>)}</ol></article>
        <article className="panel agent-panel"><span className="kicker">Orchestration</span><h2>{agentSpawns.toLocaleString()} agents spawned</h2><div className="agent-ring" style={{ "--agent-share": `${agentShare * 100}%` } as React.CSSProperties}><div><strong>{formatPercent(agentShare)}</strong><span>of volume</span></div></div><div className="agent-stats"><div><strong>{customSpawns}</strong><span>Custom spawns</span></div><div><strong>{directBrainCalls}</strong><span>Direct brain calls</span></div><div><strong>{indirectBrainCalls}</strong><span>Indirect signals</span></div></div></article>
      </section>

      <section className="details-grid">
        <article className="panel detail-panel"><span className="kicker">Task families</span><h2>Largest long-running contexts</h2><div className="task-table">{tasks.slice(0, 8).map((task) => <div key={task.label}><span>{task.label}</span><small>{task.sessions} sessions</small><strong>{formatTokens(task.total_tokens)}</strong></div>)}</div></article>
        <article className="panel detail-panel"><span className="kicker">Measured next actions</span><h2>Reduce volume, preserve quality</h2><ol className="recommendation-list">{recommendations.map((recommendation, index) => <li key={recommendation}><span>{String(index + 1).padStart(2, "0")}</span><p>{recommendation}</p></li>)}</ol><div className="brain-note"><span>Knowledge brain</span><strong>{directBrainCalls} confirmed calls</strong><small>{formatTokens(gameTokens)} game-design tokens</small></div></article>
      </section>

      <section className="theme-strip"><span>Theme split</span>{themes.map((theme) => <div key={theme.key}><strong>{theme.key}</strong><small>{formatTokens(theme.total_tokens)} · {formatPercent(rawTotal ? theme.total_tokens / rawTotal : 0)}</small></div>)}</section>
      <footer><span>Token Observatory</span><p>Local analysis · Authenticated uploads · Historical comparison</p></footer>
    </main>
  );
}
