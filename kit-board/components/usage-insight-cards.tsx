'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, Disclosure, EmptyState, Stat, StatGroup, type Column } from '@/components/kit';
import { UsageSeriesChart, modelColors, type ChartCategory, type ChartSeries } from '@/components/usage-series-chart';
import { UNKNOWN_MODEL_COLOR, type ModelLineStyle } from '@/lib/model-colors';
import type { PricingRow } from '@/lib/usage-pricing';
import type { UsageQueryResult } from '@/lib/usage-query';
import { compactTokens, exactTokens, intervalLabel, percent } from '@/lib/usage-view';

/** A card's chosen view is a per-viewer convenience; an unreadable or stale value falls back to the first. */
function useViewPreference<T extends string>(key: string, views: readonly T[]) {
  const [view, setViewState] = useState<T>(views[0]);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored && (views as readonly string[]).includes(stored)) setViewState(stored as T);
    } catch { /* per-viewer convenience only */ }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const setView = (next: string) => {
    if (!(views as readonly string[]).includes(next)) return;
    setViewState(next as T);
    try { window.localStorage.setItem(key, next); } catch { /* per-viewer convenience only */ }
  };
  return [view, setView] as const;
}

export function formatUsd(value: number) {
  if (value === 0) return '$0.00';
  const digits = Math.abs(value) < 0.01 ? 6 : 2;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

const modelLabel = (model: string) => model === 'unknown' ? 'Unknown model' : model;
const tierLabel = (tier: string) => tier === 'assumed_standard' ? 'Standard (assumed)' : tier.replaceAll('_', ' ');
const priceCoverage = (row: PricingRow) => percent(row.priced_tokens + row.unpriced_tokens ? row.priced_tokens / (row.priced_tokens + row.unpriced_tokens) : null);
const dateLabel = (date: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const shortDate = (date: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
function calendarDates(observed: string[]) {
  if (!observed.length) return [];
  const start = Date.parse(`${observed[0]}T00:00:00Z`), end = Date.parse(`${observed.at(-1)}T00:00:00Z`);
  const dates: string[] = [];
  for (let at = start; at <= end; at += 86_400_000) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}

export function CostModelTable({ rows, empty }: { rows: PricingRow[]; empty?: ReactNode }) {
  if (!rows.length) return empty ?? <EmptyState title="No priced model activity" description="This scope has no collected model rows to price. The token figures on this page are unaffected." />;
  const columns: Column<PricingRow>[] = [
    { id: 'model', header: 'Model', sortValue: row => row.model, cell: row => <span className="font-mono text-xs">{modelLabel(row.model)}</span> },
    { id: 'calls', header: 'Calls', numeric: true, sortValue: row => row.calls, cell: row => exactTokens(row.calls) },
    { id: 'tokens', header: 'Tokens', numeric: true, sortValue: row => row.total_tokens, cell: row => exactTokens(row.total_tokens) },
    { id: 'priced', header: 'Priced', numeric: true, sortValue: row => row.priced_tokens, cell: row => priceCoverage(row) },
    { id: 'estimate', header: 'Estimate', numeric: true, sortValue: row => row.estimated_cost_usd, cell: row => <span className="font-semibold">{formatUsd(row.estimated_cost_usd)}</span> },
  ];
  return <DataTable columns={columns} rows={rows} getRowId={row => row.model} defaultSort={{ id: 'estimate', dir: 'desc' }} />;
}

function CostPeriodTable({ rows }: { rows: UsageQueryResult['cost']['series'] }) {
  if (!rows.length) return null;
  const columns: Column<UsageQueryResult['cost']['series'][number] & { id: string }>[] = [
    { id: 'date', header: 'Source price date', sortValue: row => row.rate_date ?? '', cell: row => <span className="font-mono text-xs">{row.rate_date ? dateLabel(row.rate_date) : 'Unknown date'}</span> },
    { id: 'model', header: 'Model', sortValue: row => row.model, cell: row => <span className="font-mono text-xs">{modelLabel(row.model)}</span> },
    { id: 'tokens', header: 'Tokens', numeric: true, sortValue: row => row.total_tokens, cell: row => exactTokens(row.total_tokens) },
    { id: 'unpriced', header: 'Unpriced', numeric: true, sortValue: row => row.unpriced_tokens, cell: row => exactTokens(row.unpriced_tokens) },
    { id: 'estimate', header: 'Estimate', numeric: true, sortValue: row => row.estimated_cost_usd, cell: row => formatUsd(row.estimated_cost_usd) },
  ];
  const data = rows.map((row, index) => ({ ...row, id: `${row.rate_date}:${row.model}:${index}` }));
  return (
    <Disclosure title="View daily model values">
      <DataTable columns={columns} rows={data} getRowId={row => row.id} defaultSort={{ id: 'date', dir: 'asc' }} />
    </Disclosure>
  );
}

function CostDimensionTable({ rows }: { rows: PricingRow[] }) {
  if (!rows.length) return null;
  const data = rows.map((row, index) => ({ ...row, id: `${row.model}:${row.reasoning_effort}:${row.service_tier}:${index}` }));
  const columns: Column<typeof data[number]>[] = [
    { id: 'model', header: 'Model', sortValue: row => row.model, cell: row => <span className="font-mono text-xs">{modelLabel(row.model)}</span> },
    { id: 'effort', header: 'Effort', sortValue: row => row.reasoning_effort, cell: row => row.reasoning_effort === 'unknown' ? 'Unknown' : row.reasoning_effort },
    { id: 'tier', header: 'Service tier', sortValue: row => row.service_tier, cell: row => tierLabel(row.service_tier) },
    { id: 'calls', header: 'Calls', numeric: true, sortValue: row => row.calls, cell: row => exactTokens(row.calls) },
    { id: 'tokens', header: 'Tokens', numeric: true, sortValue: row => row.total_tokens, cell: row => exactTokens(row.total_tokens) },
    { id: 'estimate', header: 'Estimate', numeric: true, sortValue: row => row.estimated_cost_usd, cell: row => formatUsd(row.estimated_cost_usd) },
  ];
  return (
    <Disclosure title="View effort and service-tier detail">
      <DataTable columns={columns} rows={data} getRowId={row => row.id} defaultSort={{ id: 'estimate', dir: 'desc' }} />
    </Disclosure>
  );
}

const lineStyle = (colors: Map<string, ModelLineStyle>, model: string) => colors.get(model) ?? { color: UNKNOWN_MODEL_COLOR };

type CostComponents = UsageQueryResult['cost']['component_costs_usd'];

/**
 * What the estimate is made of, in the same colours as the token composition above it, so a reader can
 * set "96% of tokens are cache reads" beside "cache reads are 57% of the estimate". Token shares come
 * from the pricing rows themselves and are shown only when every priced row is priced in full; a share
 * over a mixed basis would compare two different populations.
 */
function costParts(cost: UsageQueryResult['cost']) {
  const c: CostComponents = cost.component_costs_usd;
  const priced = cost.by_model.filter(row => row.priced_tokens > 0);
  const exact = priced.length > 0 && priced.every(row => row.unpriced_tokens === 0);
  const sum = (pick: (row: PricingRow) => number) => priced.reduce((total, row) => total + pick(row), 0);
  const tokens = exact ? {
    fresh: sum(row => row.input_tokens - row.cached_input_tokens - row.cache_write_input_tokens),
    cached: sum(row => row.cached_input_tokens), write: sum(row => row.cache_write_input_tokens),
    reasoning: sum(row => row.reasoning_output_tokens), other: sum(row => row.output_tokens - row.reasoning_output_tokens),
  } : null;
  const tokenTotal = tokens ? tokens.fresh + tokens.cached + tokens.write + tokens.reasoning + tokens.other : 0;
  // Reasoning is priced as part of output; it is split out only where a provider reported it, and never shown as a zero it did not report.
  const split = c.reasoning_output_cost_usd > 0;
  const parts = [
    { key: 'fresh', label: 'Fresh input', className: 'bg-chart-2', usd: c.input_cost_usd, tokens: tokens?.fresh },
    { key: 'cached', label: 'Cached input', className: 'bg-primary', usd: c.cached_input_cost_usd, tokens: tokens?.cached },
    { key: 'write', label: 'Cache-write input', className: 'bg-chart-4', usd: c.cache_write_input_cost_usd, tokens: tokens?.write },
    ...(split
      ? [{ key: 'reasoning', label: 'Output · reasoning', className: 'bg-chart-3/60', usd: c.reasoning_output_cost_usd, tokens: tokens?.reasoning },
         { key: 'other', label: 'Output · other', className: 'bg-chart-3', usd: c.other_output_cost_usd, tokens: tokens?.other }]
      : [{ key: 'output', label: 'Output', className: 'bg-chart-3', usd: c.other_output_cost_usd, tokens: tokens ? tokens.other + tokens.reasoning : undefined }]),
  ];
  const usdTotal = parts.reduce((total, part) => total + part.usd, 0);
  return {
    usdTotal, tokenTotal, exact,
    parts: parts.map(part => ({ ...part, usdShare: usdTotal ? part.usd / usdTotal : null, tokenShare: tokens && tokenTotal ? (part.tokens ?? 0) / tokenTotal : null })),
  };
}

export function CostBreakdown({ cost }: { cost: UsageQueryResult['cost'] }) {
  const { parts, usdTotal, tokenTotal, exact } = costParts(cost);
  if (!usdTotal) return null;
  const heaviest = [...parts].sort((a, b) => b.usd - a.usd)[0];
  return (
    <div className="grid gap-3" data-testid="cost-breakdown">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">What the estimate is made of</span>
        {cost.priced_tokens ? <span className="text-muted-foreground font-mono text-[10.5px] tabular-nums">{formatUsd(cost.estimated_cost_usd / cost.priced_tokens * 1_000_000)} per 1M priced tokens, blended</span> : null}
      </div>
      <div className="bg-muted flex h-2.5 overflow-hidden rounded-full" role="img" aria-label={parts.filter(p => p.usd > 0).map(p => `${p.label} ${percent(p.usdShare)} of the estimate`).join(', ')}>
        {parts.map(part => part.usd > 0 ? <span key={part.key} className={part.className} style={{ width: `${(part.usdShare ?? 0) * 100}%` }} title={`${part.label}: ${formatUsd(part.usd)}`} /> : null)}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground text-[10px] tracking-wider uppercase">
            <th scope="col" className="py-1 text-left font-semibold">Component</th>
            <th scope="col" className="py-1 text-right font-semibold">Estimate</th>
            <th scope="col" className="py-1 text-right font-semibold">Of estimate</th>
            {exact ? <th scope="col" className="py-1 text-right font-semibold">Of priced tokens</th> : null}
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {parts.map(part => (
            <tr key={part.key} className="border-border border-t" data-testid={`cost-${part.key}`}>
              <th scope="row" className="py-1.5 text-left font-sans font-normal">
                <span className="flex items-center gap-2"><span aria-hidden="true" className={`size-2.5 shrink-0 rounded-xs ${part.className}`} />{part.label}</span>
              </th>
              <td className="py-1.5 text-right">{formatUsd(part.usd)}</td>
              <td className="py-1.5 text-right">{percent(part.usdShare)}</td>
              {exact ? <td className="text-muted-foreground py-1.5 text-right">{percent(part.tokenShare)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {heaviest.label} carries the largest share of the estimate, {percent(heaviest.usdShare)}
        {exact && heaviest.tokenShare !== null ? `, from ${percent(heaviest.tokenShare)} of ${exactTokens(tokenTotal)} priced tokens` : ''}.
        {' '}Components are list-price parts of the same estimate and add up to it.
      </p>
    </div>
  );
}

const COST_VIEWS = ['breakdown', 'graph', 'table'] as const;

/** The estimate per model per calendar date, costliest model first; a date with no row is a gap, not a zero. */
export function CostByDayChart({ cost, colors, empty }: { cost: UsageQueryResult['cost']; colors: Map<string, ModelLineStyle>; empty: ReactNode }) {
  const dates = calendarDates([...new Set(cost.series.flatMap(row => row.rate_date ? [row.rate_date] : []))].sort());
  const categories: ChartCategory[] = dates.map(date => ({ key: date, label: dateLabel(date), shortLabel: shortDate(date) }));
  const series: ChartSeries[] = [...cost.by_model].sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd).map(model => ({
    key: model.model, label: modelLabel(model.model), ...lineStyle(colors, model.model),
    values: dates.map(date => cost.series.find(row => row.rate_date === date && row.model === model.model)?.estimated_cost_usd ?? null),
    details: dates.map(date => {
      const row = cost.series.find(item => item.rate_date === date && item.model === model.model);
      return row ? `${exactTokens(row.total_tokens)} tokens · ${exactTokens(row.calls)} calls · ${exactTokens(row.unpriced_tokens)} unpriced tokens` : null;
    }),
  }));
  if (!series.length || !categories.length) return <>{empty}</>;
  return <UsageSeriesChart categories={categories} series={series} unit="estimated USD" formatValue={formatUsd} formatAxis={formatUsd} />;
}

export function ApiCostCard({ result, colors }: { result: UsageQueryResult; colors: Map<string, ModelLineStyle> }) {
  const [view, setView] = useViewPreference('observatory.tokens.cost-view.v2', COST_VIEWS);
  const cost = result.cost;
  const unpricedReasons = Object.entries(cost.unpriced_reasons);
  const coverage = result.pricing_inputs.coverage;
  /*
    An estimate of $0.00 over billions of tokens reads as a broken card unless the card says why.
    Name the shortfall in the reader's own numbers: no model to look up, not a missing request field.
  */
  const noEvidence = (
    <EmptyState
      title="No priced model activity in this scope"
      description={`A list-price estimate needs a model and a rate date. Hourly buckets supply both from collected totals; request records add effort, tier, and long-context when they are the headline. ${exactTokens(coverage.classified)} of ${exactTokens(coverage.headline)} headline tokens carry a model here, so there is nothing to price.`}
    />
  );

  return (
    <Card id="tokens-cost" className="scroll-mt-28 gap-0 overflow-hidden py-0" aria-label="API-equivalent cost estimate">
      {/* The tabs own the card, so the header, the figures, and the plot stay one reading rather than stacked panels. */}
      <Tabs value={view} onValueChange={setView} className="gap-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">API-equivalent cost estimate</CardTitle>
          <CardDescription>Public list-price estimate for the selected scope. It is not subscription spend, credits, an invoice, or an actual bill.</CardDescription>
          <CardAction>
            <TabsList aria-label="API-equivalent cost view">
              <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
              <TabsTrigger value="graph">By day</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
          </CardAction>
        </CardHeader>
        <StatGroup className="border-border border-y">
          <Stat label="Estimated API equivalent" value={formatUsd(cost.estimated_cost_usd)} caption="USD · public list price on collected activity" />
          <Stat label="Priced tokens" value={exactTokens(cost.priced_tokens)} caption={`${percent(cost.priced_token_coverage)} of tokens carrying price inputs`} />
          <Stat label="Unpriced tokens" value={exactTokens(cost.unpriced_tokens)} caption={unpricedReasons.length ? unpricedReasons.map(([reason, tokens]) => `${reason.replaceAll('_', ' ')} ${compactTokens(tokens)}`).join(' · ') : 'none in pricing inputs'} />
          <Stat label="Input evidence" value={percent(coverage.headline ? coverage.classified / coverage.headline : null)} caption={`${exactTokens(coverage.classified)} of ${exactTokens(coverage.headline)} headline tokens carry a model`} />
        </StatGroup>
        <div className="grid gap-4 p-4">
          <TabsContent value="breakdown">
            {cost.estimated_cost_usd > 0 ? <CostBreakdown cost={cost} /> : noEvidence}
          </TabsContent>
          <TabsContent value="graph">
            <CostByDayChart cost={cost} colors={colors} empty={noEvidence} />
          </TabsContent>
          <TabsContent value="table" className="grid gap-4">
            <CostModelTable rows={cost.by_model} empty={noEvidence} />
            <CostPeriodTable rows={cost.series} />
            <CostDimensionTable rows={cost.by_model_effort_service_tier} />
          </TabsContent>
          <Disclosure title="Catalog, coverage, and assumptions" contentClassName="text-muted-foreground grid gap-3 text-xs leading-relaxed">
            <p>Catalog {cost.pricing_catalog.version}. Rates are per {exactTokens(cost.pricing_catalog.unit_tokens)} tokens. {coverage.note}</p>
            <p>{exactTokens(cost.missing_service_tier_calls_assumed_standard)} calls assumed Standard service tier · {exactTokens(cost.assumed_cache_write_ttl_calls)} calls assumed a 5-minute cache-write TTL · {exactTokens(cost.priority_at_standard_calls)} Anthropic priority calls priced at Standard and flagged.</p>
            <ul className="grid gap-1">{cost.assumptions.map(assumption => <li key={assumption}>• {assumption}</li>)}</ul>
            <div className="flex flex-wrap gap-2">{cost.pricing_catalog.sources.map(source => <Button key={`${source.label}:${source.url}`} variant="outline" size="xs" asChild><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></Button>)}</div>
          </Disclosure>
        </div>
        <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed">Cost lines use the Chicago calendar date of each hourly bucket, or each request&apos;s activity when a detail filter makes requests the headline. A missing date is a gap, not a zero-cost day. Hiding a line or switching this view does not change the selected scope or the token headline.</p>
      </Tabs>
    </Card>
  );
}

type ModelRow = UsageQueryResult['by_model'][number];

export function ModelSummaryTable({ result, colors }: { result: UsageQueryResult; colors: Map<string, ModelLineStyle> }) {
  if (!result.by_model.length) return <EmptyState title="No model attribution in this scope" description="The selected total may include historical snapshots or activity that did not record a model." />;
  const rows = result.by_model;
  const sum = (pick: (row: ModelRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const composition = (pick: (row: ModelRow) => number, header: string): Column<ModelRow> => ({
    id: header, header, numeric: true, sortValue: pick,
    cell: row => compactTokens(pick(row)),
    footer: compactTokens(sum(pick)),
  });
  const columns: Column<ModelRow>[] = [
    { id: 'model', header: 'Model', sortValue: row => row.model, footer: `Total · ${rows.length} ${rows.length === 1 ? 'model' : 'models'}`, cell: row => (
      <span className="inline-flex max-w-[26ch] items-center gap-2" title={row.model}>
        <i aria-hidden className="inline-block size-1.5 shrink-0 rounded-xs" style={{ background: lineStyle(colors, row.model).color }} />
        <span className="truncate font-mono">{modelLabel(row.model)}</span>
      </span>
    ) },
    { id: 'calls', header: 'Calls', numeric: true, sortValue: row => row.calls, cell: row => exactTokens(row.calls), footer: exactTokens(sum(row => row.calls)) },
    { id: 'tokens', header: 'Tokens', numeric: true, sortValue: row => row.total_tokens, cell: row => exactTokens(row.total_tokens), footer: exactTokens(sum(row => row.total_tokens)) },
    // A withheld share sorts below every known one rather than pretending to be zero.
    { id: 'share', header: 'Share', numeric: true, sortValue: row => row.share ?? -1, cell: row => percent(row.share),
      footer: percent(result.headline.total_tokens ? sum(row => row.total_tokens) / result.headline.total_tokens : null) },
    composition(row => row.composition.input_fresh, 'Fresh'),
    composition(row => row.composition.input_cached, 'Cached'),
    composition(row => row.composition.input_cache_write, 'Cache write'),
    composition(row => row.composition.output, 'Output'),
  ];
  return <DataTable columns={columns} rows={rows} getRowId={row => row.model} defaultSort={{ id: 'tokens', dir: 'desc' }} />;
}

export type RankedModel = { model: string; tokens: number; share: number | null; calls: number; usd: number; priced: number; unpriced: number };

/** Tokens and their list-price estimate on one row per model, joined by model name; a model with no price inputs says so rather than reading as free. */
export function rankedModels(result: UsageQueryResult): RankedModel[] {
  const costs = new Map<string, { usd: number; priced: number; unpriced: number }>();
  for (const row of result.cost.by_model) {
    const entry = costs.get(row.model) ?? { usd: 0, priced: 0, unpriced: 0 };
    entry.usd += row.estimated_cost_usd; entry.priced += row.priced_tokens; entry.unpriced += row.unpriced_tokens;
    costs.set(row.model, entry);
  }
  return [...result.by_model].sort((a, b) => b.total_tokens - a.total_tokens).map(row => {
    const cost = costs.get(row.model);
    return { model: row.model, tokens: row.total_tokens, share: row.share, calls: row.calls, usd: cost?.usd ?? 0, priced: cost?.priced ?? 0, unpriced: cost?.unpriced ?? row.total_tokens };
  });
}

const RANKED_PREVIEW = 8;

export function ModelRanking({ rows, colors }: { rows: RankedModel[]; colors: Map<string, ModelLineStyle> }) {
  const [all, setAll] = useState(false);
  const top = rows[0]?.tokens || 1;
  const shown = all ? rows : rows.slice(0, RANKED_PREVIEW);
  const columns = 'sm:grid-cols-[minmax(0,15rem)_minmax(3rem,1fr)_4.5rem_3.5rem_5rem_7rem]';
  return (
    <div className="grid" data-testid="model-ranking">
      <div aria-hidden="true" className={`text-muted-foreground hidden gap-x-4 px-4 pb-2 text-[10px] font-semibold tracking-wider uppercase sm:grid ${columns}`}>
        <span>Model</span><span>Relative volume</span><span className="text-right">Tokens</span><span className="text-right">Share</span><span className="text-right">Calls</span><span className="text-right">Estimate</span>
      </div>
      <ol className="border-border divide-border divide-y border-t">
        {shown.map((row, index) => {
          const priced = row.priced > 0;
          return (
            <li key={row.model} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 ${columns}`}>
              <span className="flex min-w-0 items-center gap-2" title={row.model}>
                <span className="text-muted-foreground w-4 shrink-0 font-mono text-[10.5px] tabular-nums">{index + 1}</span>
                <i aria-hidden className="inline-block size-2 shrink-0 rounded-xs" style={{ background: lineStyle(colors, row.model).color }} />
                <span className="truncate font-mono text-xs">{modelLabel(row.model)}</span>
              </span>
              <span aria-hidden="true" className="bg-muted order-2 col-span-2 h-1.5 overflow-hidden rounded-full sm:order-none sm:col-span-1">
                <span className="bg-primary/70 block h-full rounded-full" style={{ width: `${Math.max(0.5, (row.tokens / top) * 100)}%` }} />
              </span>
              <span className="text-muted-foreground order-3 col-span-2 flex gap-3 font-mono text-[10.5px] tabular-nums sm:order-none sm:col-span-1 sm:contents sm:text-xs">
                <span className="sm:text-foreground sm:text-right" title={`${exactTokens(row.tokens)} tokens`}>{compactTokens(row.tokens)}<span className="sm:hidden"> tokens</span></span>
                <span className="sm:text-right">{percent(row.share)}</span>
                <span className="sm:text-right">{exactTokens(row.calls)}<span className="sm:hidden"> calls</span></span>
              </span>
              <span className="order-1 grid justify-items-end text-right sm:order-none">
                {priced
                  ? <span className="font-mono text-xs font-semibold tabular-nums">{formatUsd(row.usd)}</span>
                  : <span className="text-muted-foreground text-xs">not priced</span>}
                {priced ? <span className="text-muted-foreground font-mono text-[10px] tabular-nums">{formatUsd(row.usd / row.priced * 1_000_000)} / 1M{row.unpriced > 0 ? ' · partial' : ''}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {rows.length > RANKED_PREVIEW ? (
        <div className="border-border border-t px-4 py-2">
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground -ml-1.5 px-1.5 font-normal" aria-expanded={all} onClick={() => setAll(value => !value)}>
            {all ? `Show the top ${RANKED_PREVIEW}` : `Show all ${rows.length} models`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const MODEL_VIEWS = ['ranked', 'graph', 'table'] as const;

/** One card for "where the tokens go": a ranked reading with the estimate beside each model, the lines over time, and the full composition ledger. */
/** One line per model over the series intervals; an interval without collector coverage, or covered only by snapshots, is a gap. */
export function ModelOverTimeChart({ result, colors, empty }: { result: UsageQueryResult; colors: Map<string, ModelLineStyle>; empty: ReactNode }) {
  const categories: ChartCategory[] = result.series.points.map(point => {
    const label = intervalLabel(point, result.scope.range.timezone, result.series.resolution);
    return { key: point.start, label, shortLabel: label.split(' · ')[0] };
  });
  const indexed = new Map(result.model_series.map(model => [model.model, new Map(model.points.map(point => [point.start, point]))]));
  const series: ChartSeries[] = rankedModels(result).map(model => {
    const values = indexed.get(model.model);
    return {
      key: model.model, label: modelLabel(model.model), ...lineStyle(colors, model.model),
      values: result.series.points.map(point => point.state === 'missing' || (point.sources.length > 0 && point.sources.every(source => source === 'snapshot'))
        ? null : values?.get(point.start)?.total_tokens ?? 0),
      details: result.series.points.map(point => {
        const value = values?.get(point.start);
        return value ? `${exactTokens(value.calls)} calls` : point.state === 'missing' ? 'no collector coverage' : 'no calls for this model';
      }),
    };
  });
  if (!series.length) return <>{empty}</>;
  return <UsageSeriesChart categories={categories} series={series} unit="tokens" formatValue={value => `${exactTokens(value)} tokens`} formatAxis={compactTokens} />;
}

export function TokensByModelCard({ result, colors }: { result: UsageQueryResult; colors: Map<string, ModelLineStyle> }) {
  const [view, setView] = useViewPreference('observatory.tokens.model-view.v2', MODEL_VIEWS);
  const ranked = rankedModels(result);
  const attributed = result.by_model.reduce((sum, row) => sum + row.total_tokens, 0);
  const unattributed = Math.max(0, result.headline.total_tokens - attributed);
  const empty = <EmptyState title="No model attribution in this scope" description="The selected token total remains visible above, but these records do not carry a model breakdown." />;

  return (
    <Card id="tokens-models" className="scroll-mt-28 gap-0 overflow-hidden py-0" aria-label="Tokens by model">
      <Tabs value={view} onValueChange={setView} className="gap-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Tokens by model</CardTitle>
          <CardDescription>{ranked.length ? `${ranked.length} ${ranked.length === 1 ? 'model' : 'models'}, ranked by tokens, with the API-equivalent estimate beside each.` : 'Which models the selected tokens went to.'}</CardDescription>
          <CardAction>
            <TabsList aria-label="Tokens by model view">
              <TabsTrigger value="ranked">Ranked</TabsTrigger>
              <TabsTrigger value="graph">Graph</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
          </CardAction>
        </CardHeader>
        {/* The plot is inset; the ranking and the ledger run to the card's own edge, the way a shadcn table sits in a card. */}
        <TabsContent value="ranked">
          {ranked.length ? <ModelRanking rows={ranked} colors={colors} /> : <div className="p-4">{empty}</div>}
        </TabsContent>
        <TabsContent value="graph" className="p-4 pt-6">
          <ModelOverTimeChart result={result} colors={colors} empty={empty} />
        </TabsContent>
        <TabsContent value="table">
          <ModelSummaryTable result={result} colors={colors} />
        </TabsContent>
        <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed">
          {exactTokens(attributed)} of {exactTokens(result.headline.total_tokens)} headline tokens are attributed to a recorded model.
          {unattributed > 0 ? ` ${exactTokens(unattributed)} tokens remain outside this breakdown, including snapshots without model detail.` : ' The model rows reconcile to the headline.'}
          {' '}Estimates are public list price, not spend; a model without price inputs is marked rather than counted as free. A missing point on the graph means model detail is unavailable for that interval; it is not drawn as zero.
        </p>
      </Tabs>
    </Card>
  );
}

/** Where the tokens went, then what they would cost at list price: the model card leads because the cost card's parts refer back to it. */
export function UsageInsightCards({ result }: { result: UsageQueryResult }) {
  const colors = modelColors([...result.by_model.map(row => row.model), ...result.cost.by_model.map(row => row.model)]);
  return <><TokensByModelCard result={result} colors={colors} /><ApiCostCard result={result} colors={colors} /></>;
}
