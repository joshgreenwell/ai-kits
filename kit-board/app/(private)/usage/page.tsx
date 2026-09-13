"use client";

import { useEffect, useMemo, useState } from "react";
import { MachineReporters } from "@/components/machine-reporters";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Workspace } from "@/components/workspace";
import { EmptyState, SparkBars, Stat, StatGroup } from "@/components/kit";
import { fetchPrivateJson } from "@/lib/fetch-private-json";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import environmentalFactors from "./environmental-factors.json";

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
  // Models the analyzer could not price: the catalog it ships is the only rate source.
  const unpricedModels = (() => {
    const totals = new Map<string, number>();
    for (const cost of costSnapshots) for (const row of cost?.by_model ?? []) if (row.unpriced_tokens > 0) totals.set(row.key, (totals.get(row.key) ?? 0) + row.unpriced_tokens);
    return [...totals].sort((a, b) => b[1] - a[1]);
  })();
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

  if (loading)
    return (
      <Workspace>
        <EmptyState title="Loading report history…" description="Reading the uploaded monthly analyses." />
      </Workspace>
    );
  if (error && !reports.length)
    return (
      <Workspace>
        <Alert variant="destructive">
          <AlertTitle>Connection issue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </Workspace>
    );
  if (!reports.length)
    return (
      <Workspace>
        <EmptyState
          title="Ready for the first monthly upload"
          description="The database is connected. Run the token skill with its upload configuration to populate this dashboard."
        />
      </Workspace>
    );

  const composedTotal = rawTotal || 1;

  return (
    <Workspace>
      <PageHeader
        eyebrow={selectedLabel}
        title="Monthly AI intelligence"
        description={`${partialMonth ? "Month to date · full report detail" : "Full monthly report"} · ${hourlyMachines ? `${hourlyMachines} of ${visibleRows.length} selected machine reports refresh hourly` : "Scheduled and manual report snapshots"}.${partialMonth ? " Prior-month percentage comparisons resume after this month closes." : ""}`}
        actions={
          <>
            <MachineReporters machines={monthRows} />
            <Select value={activeMonth} onValueChange={(month) => { setSelectedMonth(month); setSelectedMachine("all"); }}>
              <SelectTrigger aria-label="Report month" className="w-[180px]">
                <SelectValue placeholder="Report month" />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {months.map((month) => <SelectItem key={month} value={month}>{formatMonth(month)}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        }
      />

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Some data could not be refreshed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Headline volume ---------------------------------------------------- */}
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardDescription>{selectedMachine === "all" ? "Combined" : "Machine"} raw volume</CardDescription>
          <CardTitle className="font-mono text-4xl leading-none font-medium tracking-tight tabular-nums">
            {formatTokens(rawTotal)}
          </CardTitle>
          <CardAction>
            {partialMonth ? (
              <Badge variant="outline">In progress · through each machine’s latest snapshot</Badge>
            ) : (
              <Badge variant={monthChange >= 0 ? "soft-warning" : "soft"}>
                {monthChange >= 0 ? "↑" : "↓"} {formatPercent(Math.abs(monthChange))} from prior month
              </Badge>
            )}
          </CardAction>
        </CardHeader>
        <StatGroup className="border-border border-t">
          <Stat label="Model calls" value={calls.toLocaleString()} />
          <Stat label="Average / call" value={formatTokens(averagePerCall)} />
          <Stat label="Threads" value={threads.toLocaleString()} />
          <Stat label="Game design" value={formatPercent(rawTotal ? gameTokens / rawTotal : 0)} />
        </StatGroup>
      </Card>

      {/* Context composition -------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Context composition</CardTitle>
            <CardDescription>Mostly reused, not newly generated.</CardDescription>
            <CardAction><Badge variant="soft">{formatPercent(cacheShare)} cached</Badge></CardAction>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div
              className="border-border flex h-3 overflow-hidden rounded-sm border"
              role="img"
              aria-label={`${formatPercent(cacheShare)} cached input, ${formatTokens(composition.uncached)} uncached input, ${formatTokens(composition.output)} output`}
            >
              <span className="bg-primary" style={{ width: `${(composition.cached / composedTotal) * 100}%` }} />
              <span className="bg-chart-2" style={{ width: `${(composition.uncached / composedTotal) * 100}%` }} />
              <span className="bg-chart-4" style={{ width: `${(composition.output / composedTotal) * 100}%` }} />
            </div>
            <dl className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-4">
              {[
                ["Cached input", composition.cached, "bg-primary"],
                ["Uncached input", composition.uncached, "bg-chart-2"],
                ["Output + other", composition.output, "bg-chart-4"],
              ].map(([label, value, tone]) => (
                <div key={label as string}>
                  <dt className="text-muted-foreground flex items-center gap-2 text-xs">
                    <i className={`block size-2 rounded-xs ${tone as string}`} aria-hidden="true" />
                    {label as string}
                  </dt>
                  <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatTokens(value as number)}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fresh / non-cached</CardTitle>
            <CardDescription>{formatPercent(rawTotal ? freshTotal / rawTotal : 0)} of total volume</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-primary font-mono text-3xl leading-none font-medium tracking-tight tabular-nums">
              {formatTokens(freshTotal)}
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {partialMonth ? "Month-to-date activity; " : `Call count changed ${formatPercent(callChange, true)}; `}
              average context was {formatTokens(averagePerCall)} per call.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Daily volume --------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Daily volume</CardTitle>
          <CardDescription>When activity concentrated.</CardDescription>
          <CardAction>
            <div className="text-right">
              <span className="text-muted-foreground block text-[10px] font-semibold tracking-wider uppercase">Peak</span>
              <span className="block font-mono text-lg font-medium tabular-nums">{formatTokens(peakDay.tokens)}</span>
              <span className="text-muted-foreground block font-mono text-[10px]">{peakDay.date}</span>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {days.length ? (
            <SparkBars
              values={days.map((day) => day.tokens)}
              axis={[days.at(0)?.date ?? "—", days.at(Math.floor(days.length / 2))?.date ?? "—", days.at(-1)?.date ?? "—"]}
              formatValue={formatTokens}
            />
          ) : (
            <EmptyState title="No daily detail in this month’s upload" />
          )}
        </CardContent>
      </Card>

      {/* API-equivalent cost --------------------------------------------------- */}
      <Card className="gap-0 overflow-hidden py-0" aria-label="API-equivalent cost estimate">
        <CardHeader className="p-4">
          <CardTitle className="text-base">API-equivalent pricing</CardTitle>
          <CardDescription>What this usage would cost through the API.</CardDescription>
          <CardAction><Badge variant="outline">{formatPercent(pricingCoverage)} priced</Badge></CardAction>
        </CardHeader>

        <div className="border-border grid gap-4 border-t p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div>
            <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Estimated API cost</span>
            <p className="text-primary mt-2 font-mono text-3xl leading-none font-medium tracking-tight tabular-nums">
              {formatCurrency(estimatedCost)}
            </p>
            <p className="text-muted-foreground mt-2 max-w-[46ch] text-sm leading-relaxed">
              This is a comparison estimate — not your Codex subscription bill or credit usage.
            </p>
          </div>
          <StatGroup className="border-border rounded-lg border">
            <Stat label="Priced coverage" value={formatPercent(pricingCoverage)} caption={`${formatTokens(unpricedTokens)} unpriced`} />
            <Stat label="Fast / Priority" value={formatPercent(rawTotal ? fastTokens / rawTotal : 0)} caption={`${formatTokens(fastTokens)} raw tokens`} />
            <Stat label="Reasoning output" value={formatCurrency(reasoningCost)} caption="charged at output rate" />
            <Stat label="Tier assumed" value={assumedTierCalls.toLocaleString()} caption="calls treated as Standard" />
          </StatGroup>
        </div>

        {unpricedModels.length > 0 && (
          <div className="border-border border-t px-4 py-3">
            <p className="text-muted-foreground text-xs leading-relaxed">
              <span className="text-foreground font-semibold">Unpriced models:</span>{' '}
              {unpricedModels.map(([model, tokens]) => `${model} (${formatTokens(tokens)})`).join(', ')}.
              {' '}These are missing from the analyzer’s pricing catalog{pricingCatalogs.length ? ` (rates ${pricingCatalogs.join(', ')})` : ''}; add their rates there and the next hourly refresh prices the remaining {formatPercent(1 - pricingCoverage)}.
            </p>
          </div>
        )}

        <div className="border-border grid gap-4 border-t p-4 md:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
          <div>
            <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Cost composition</span>
            <dl className="mt-2 grid">
              {[
                ["Uncached input", inputCost],
                ["Cached input", cachedCost],
                ["Reasoning output", reasoningCost],
                ["Other output", otherOutputCost],
              ].map(([label, value]) => (
                <div key={label as string} className="border-border flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0">
                  <dt className="text-muted-foreground text-sm">{label as string}</dt>
                  <dd className="font-mono text-sm font-medium tabular-nums">{formatCurrency(value as number)}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="border-border overflow-hidden rounded-lg border">
            {costDimensions.length ? (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="bg-card uppercase">Model</TableHead>
                    <TableHead className="bg-card uppercase">Effort</TableHead>
                    <TableHead className="bg-card uppercase">Speed</TableHead>
                    <TableHead className="bg-card uppercase">Usage</TableHead>
                    <TableHead className="bg-card text-right uppercase">Estimate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {costDimensions.slice(0, 10).map((row) => (
                    <TableRow key={row.key} className="even:bg-foreground/[0.03] border-b-0">
                      <TableCell className="font-medium">{row.model}</TableCell>
                      <TableCell className="text-muted-foreground">{row.reasoning_effort}</TableCell>
                      <TableCell className="text-muted-foreground">{row.service_tier.replace("assumed_standard", "Standard*")}</TableCell>
                      <TableCell className="text-muted-foreground font-mono text-xs">
                        {formatTokens(row.total_tokens)} · {(row.calls ?? 0).toLocaleString()} calls
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCurrency(row.estimated_cost_usd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-4">
                <EmptyState title="No model-level pricing in this upload" description="Re-run this month with the updated analyzer to add model, effort, and speed pricing." />
              </div>
            )}
          </div>
        </div>

        <div className="bg-muted border-border border-t p-4">
          <p className="text-muted-foreground text-xs leading-relaxed">
            <span className="text-foreground font-mono">Rates {pricingCatalogs.join(", ") || "not recorded"}</span> — reasoning
            effort changes token volume, not the per-token rate. Requests above 272K logged input use
            long-context pricing. Separate tool fees, images, regional processing, and subscription
            credits are excluded.
          </p>
        </div>
      </Card>

      {/* Environmental scenarios ------------------------------------------------ */}
      <Card className="gap-0 overflow-hidden py-0" aria-label="Environmental scenario estimate">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Environmental scenarios</CardTitle>
          <CardDescription>A footprint estimate — with the uncertainty left on.</CardDescription>
          <CardAction><Badge variant="soft-warning">Not metered · inference only</Badge></CardAction>
        </CardHeader>

        <div className="border-border border-t p-4">
          <p className="text-muted-foreground max-w-[80ch] text-sm leading-relaxed">
            Codex does not expose datacenter power, water, hardware, location, or grid telemetry.
            These are call-based analogues: an efficient production floor, a reasoning-heavy planning
            scenario for this long-context workload, and a long-prompt upper scenario.
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {[
              { label: "Electricity · planning", value: formatEnergy(environment.energy.planning), range: `${formatEnergy(environment.energy.low)} – ${formatEnergy(environment.energy.high)}`, body: <>About <b className="text-foreground">{formatQuantity(environment.equivalents.homeDays)}</b> U.S. home-days or <b className="text-foreground">{formatQuantity(environment.equivalents.phoneCharges, 0)}</b> full smartphone charges.</> },
              { label: "Direct water · planning", value: formatWater(environment.water.planning), range: `${formatWater(environment.water.low)} – ${formatWater(environment.water.high)}`, body: <>Roughly <b className="text-foreground">{formatQuantity(environment.equivalents.showers, 2)}</b> average eight-minute showers.</> },
              { label: "Operational CO2e · planning", value: formatCarbon(environment.carbon.planning), range: `${formatCarbon(environment.carbon.low)} – ${formatCarbon(environment.carbon.high)}`, body: <>Same emissions as driving an average gasoline car about <b className="text-foreground">{formatQuantity(environment.equivalents.gasolineCarMiles, 0)} miles</b>.</> },
            ].map((scenario) => (
              <div key={scenario.label} className="border-border grid gap-2 rounded-lg border p-4">
                <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">{scenario.label}</span>
                <strong className="font-mono text-2xl leading-none font-medium tracking-tight tabular-nums">{scenario.value}</strong>
                <p className="text-muted-foreground text-sm leading-relaxed">{scenario.body}</p>
                <span className="text-muted-foreground font-mono text-[10px]">{scenario.range} scenario range</span>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-2" aria-label="Per-call electricity scenarios">
            {[
              ["Efficient production", "0.24 Wh / call", 12],
              ["Planning scenario", "4.32 Wh / call", 45],
              ["Long-context upper", "33 Wh / call", 100],
            ].map(([label, value, width]) => (
              <div key={label as string} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
                <span className="text-sm">{label as string}</span>
                <span className="font-mono text-sm tabular-nums">{value as string}</span>
                <span className="bg-muted border-border col-span-2 h-1.5 overflow-hidden rounded-xs border">
                  <span className="bg-primary/70 block h-full" style={{ width: `${width as number}%` }} />
                </span>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="border-border grid gap-2 rounded-lg border p-4">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">A measurable reduction</span>
              <h3 className="text-sm font-semibold">Cutting calls 10% saves about {formatEnergy(environment.reduction.energy)}.</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                That also models {formatWater(environment.reduction.water)} of direct water and {formatCarbon(environment.reduction.carbon)} CO2e
                avoided. Phase handoffs, bounded agents, and fresh tasks target repeated calls while preserving the useful work.
              </p>
            </div>
            <div className="border-border grid gap-2 rounded-lg border p-4">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Tree planting example</span>
              <h3 className="text-sm font-semibold">About {formatQuantity(environment.equivalents.treeSeedlings, 0)} urban tree seedlings, grown for 10 years.</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                That EPA comparison matches the planning estimate after a decade of growth. It is
                delayed biological sequestration — not an immediate or verified offset.
              </p>
            </div>
          </div>

          <details className="border-border mt-4 rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-semibold">Methodology, scope, and sources</summary>
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{environmentalFactors.scope}</p>
            <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
              Raw and cached tokens describe workload shape, but are not converted with an invented
              joules-per-token factor. Method {environment.methodologyVersions.join(", ")} uses observed call counts; an average
              context above 50K raw tokens per call selects the 4.32 Wh reasoning-heavy planning scenario.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {environmentalFactors.sources.filter((source) => source.url).map((source) => (
                <Button key={source.url} variant="outline" size="xs" asChild>
                  <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
                </Button>
              ))}
            </div>
          </details>
        </div>
      </Card>

      {/* Sources ---------------------------------------------------------------- */}
      <section className="grid gap-4">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold tracking-tight">
            {monthRows.length} machine{monthRows.length === 1 ? "" : "s"}, distinct workflows
          </h2>
          <p className="text-muted-foreground max-w-[80ch] text-sm leading-relaxed">
            Each computer publishes the full local analysis. Hourly-enabled collectors refresh the
            current month; other machines keep their existing upload schedule. Choose a machine to
            inspect its snapshot.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {monthRows.map((machine) => {
            const share = monthRows.reduce((sum, row) => sum + row.raw_tokens, 0);
            const focused = selectedMachine === machine.machine_id;
            return (
              <Card key={machine.machine_id} className={focused ? "border-primary" : undefined}>
                <CardHeader>
                  <CardDescription>{formatPercent(share ? machine.raw_tokens / share : 0)} of month</CardDescription>
                  <CardTitle className="text-base">{machine.machine_name}</CardTitle>
                  {focused ? <CardAction><Badge variant="soft">focused</Badge></CardAction> : null}
                </CardHeader>
                <CardContent className="grid gap-3">
                  <p className="text-muted-foreground text-sm">
                    {formatTokens(machine.game_design_tokens)} game-design · {machine.agent_spawns} agent spawns
                  </p>
                  <p className="text-muted-foreground font-mono text-[11px]">
                    {machine.envelope.report.collection?.kind === "hourly_detailed_report" ? "Hourly detail · snapshot changed " : "Snapshot generated "}
                    {new Date(machine.envelope.report.generated_at_local).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </p>
                  <dl className="border-border flex flex-wrap gap-x-6 border-t pt-3">
                    <div>
                      <dt className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Raw tokens</dt>
                      <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatTokens(machine.raw_tokens)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Fresh volume</dt>
                      <dd className="mt-1 font-mono text-lg font-medium tabular-nums">{formatTokens(machine.fresh_tokens)}</dd>
                    </div>
                  </dl>
                  <details>
                    <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[11px]">Source coverage</summary>
                    <p className="text-muted-foreground mt-2 text-xs leading-relaxed">{machine.envelope.report.data_scope || "This machine’s uploaded local analysis."}</p>
                    {machine.envelope.report.data_quality && (
                      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">Data quality: {machine.envelope.report.data_quality.replaceAll("_", " ")}</p>
                    )}
                    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">Unchanged analysis does not create another snapshot. Check Connections for collector health.</p>
                  </details>
                  <Button type="button" variant={focused ? "secondary" : "outline"} size="sm" onClick={() => setSelectedMachine(focused ? "all" : machine.machine_id)}>
                    {focused ? "Return to combined report" : "Focus machine report"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Drivers and orchestration ------------------------------------------------ */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">Largest drivers</CardTitle>
            <CardDescription>Where the month went</CardDescription>
          </CardHeader>
          <ol className="border-border border-t">
            {projects.slice(0, 5).map((project, index) => (
              <li key={project.key} className="border-border flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
                <span className="text-muted-foreground w-6 font-mono text-xs tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{project.key}</span>
                  <span className="text-muted-foreground block font-mono text-[11px]">{formatTokens(project.total_tokens)} raw tokens</span>
                </span>
                <span className="font-mono text-sm font-medium tabular-nums">{formatPercent(rawTotal ? project.total_tokens / rawTotal : 0)}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">{agentSpawns.toLocaleString()} agents spawned</CardTitle>
            <CardDescription>Orchestration</CardDescription>
          </CardHeader>
          <CardContent className="border-border border-t p-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground text-sm">Share of volume</span>
              <span className="font-mono text-2xl leading-none font-medium tabular-nums">{formatPercent(agentShare)}</span>
            </div>
            <div className="bg-muted border-border mt-3 h-2 overflow-hidden rounded-sm border">
              <span className="bg-primary block h-full" style={{ width: `${Math.min(100, agentShare * 100)}%` }} />
            </div>
          </CardContent>
          <StatGroup className="border-border border-t">
            <Stat label="Custom spawns" value={customSpawns} />
            <Stat label="Direct brain calls" value={directBrainCalls} />
            <Stat label="Indirect signals" value={indirectBrainCalls} />
          </StatGroup>
        </Card>
      </div>

      {/* Task families and next actions -------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">Task families</CardTitle>
            <CardDescription>Largest long-running contexts</CardDescription>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="bg-card uppercase">Task</TableHead>
                <TableHead className="bg-card uppercase">Sessions</TableHead>
                <TableHead className="bg-card text-right uppercase">Tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.slice(0, 8).map((task) => (
                <TableRow key={task.label} className="even:bg-foreground/[0.03] border-b-0">
                  <TableCell className="max-w-[28ch] truncate font-medium">{task.label}</TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs tabular-nums">{task.sessions}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatTokens(task.total_tokens)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">Measured next actions</CardTitle>
            <CardDescription>Reduce volume, preserve quality</CardDescription>
          </CardHeader>
          <ol className="border-border border-t">
            {recommendations.map((recommendation, index) => (
              <li key={recommendation} className="border-border flex gap-3 border-b px-4 py-2.5 last:border-b-0">
                <span className="text-muted-foreground w-6 shrink-0 font-mono text-xs tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                <p className="text-muted-foreground text-sm leading-relaxed">{recommendation}</p>
              </li>
            ))}
          </ol>
          <div className="bg-muted border-border flex flex-wrap items-baseline justify-between gap-3 border-t p-4">
            <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Knowledge brain</span>
            <span className="font-mono text-sm font-medium tabular-nums">{directBrainCalls} confirmed calls</span>
            <span className="text-muted-foreground font-mono text-[11px]">{formatTokens(gameTokens)} game-design tokens</span>
          </div>
        </Card>
      </div>

      {/* Theme split ----------------------------------------------------------------- */}
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Theme split</CardTitle>
        </CardHeader>
        <StatGroup className="border-border border-t">
          {themes.map((theme) => (
            <Stat
              key={theme.key}
              label={theme.key}
              value={formatTokens(theme.total_tokens)}
              caption={formatPercent(rawTotal ? theme.total_tokens / rawTotal : 0)}
            />
          ))}
        </StatGroup>
      </Card>

      <footer className="text-muted-foreground border-border border-t pt-4 font-mono text-[11px]">
        Token Observatory · local analysis · authenticated uploads · historical comparison
      </footer>
    </Workspace>
  );
}
