'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, Disclosure, EmptyState, Stat, StatGroup, type Column } from '@/components/kit';
import { UsageSeriesChart, modelColors, type ChartCategory, type ChartSeries } from '@/components/usage-series-chart';
import type { PricingRow } from '@/lib/usage-pricing';
import type { UsageQueryResult } from '@/lib/usage-query';
import { compactTokens, exactTokens, intervalLabel, percent } from '@/lib/usage-view';

type View = 'graph' | 'table';
/** Long ledgers scroll inside the card rather than growing it; the card's own edge is the only frame. */

function useViewPreference(key: string) {
  const [view, setViewState] = useState<View>('graph');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'graph' || stored === 'table') setViewState(stored);
    } catch { /* per-viewer convenience only */ }
  }, [key]);
  const setView = (next: View) => {
    setViewState(next);
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
  if (!rows.length) return empty ?? <EmptyState title="No request pricing evidence" description="This scope has no request records carrying pricing dimensions. The collected token totals are unaffected." />;
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

export function ApiCostCard({ result, colors }: { result: UsageQueryResult; colors: Map<string, string> }) {
  const [view, setView] = useViewPreference('observatory.tokens.cost-view.v1');
  const cost = result.cost;
  const dates = calendarDates([...new Set(cost.series.flatMap(row => row.rate_date ? [row.rate_date] : []))].sort());
  const categories: ChartCategory[] = dates.map(date => ({ key: date, label: dateLabel(date), shortLabel: shortDate(date) }));
  const series: ChartSeries[] = cost.by_model.map(model => ({
    key: model.model, label: modelLabel(model.model), color: colors.get(model.model) ?? 'var(--muted-foreground)',
    values: dates.map(date => cost.series.find(row => row.rate_date === date && row.model === model.model)?.estimated_cost_usd ?? null),
    details: dates.map(date => {
      const row = cost.series.find(item => item.rate_date === date && item.model === model.model);
      return row ? `${exactTokens(row.total_tokens)} tokens · ${exactTokens(row.calls)} calls · ${exactTokens(row.unpriced_tokens)} unpriced tokens` : null;
    }),
  }));
  const unpricedReasons = Object.entries(cost.unpriced_reasons);
  const coverage = result.pricing_inputs.coverage;
  /*
    An estimate of $0.00 over billions of tokens reads as a broken card unless the card says why. The
    reason is upstream of this screen: a list price is per request, and a scope whose headline comes
    from bucket totals has no request to price. Name the shortfall in the reader's own numbers.
  */
  const noEvidence = (
    <EmptyState
      title="No request pricing evidence in this scope"
      description={`A list-price estimate needs per-request records carrying a model and a source price date. ${exactTokens(coverage.classified)} of ${exactTokens(coverage.headline)} headline tokens carry that detail here, so there is nothing to price. The token figures on this page are unaffected: they come from the collected totals, which do not record per-request pricing dimensions.`}
    />
  );

  return (
    <Card className="gap-0 overflow-hidden py-0" aria-label="API-equivalent cost estimate">
      {/* The tabs own the card, so the header, the figures, and the plot stay one reading rather than stacked panels. */}
      <Tabs value={view} onValueChange={next => { if (next === 'graph' || next === 'table') setView(next); }} className="gap-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">API-equivalent cost estimate</CardTitle>
          <CardDescription>Public list-price estimate for request detail in this selected scope. It is not subscription spend, credits, an invoice, or an actual bill.</CardDescription>
          <CardAction>
            <TabsList aria-label="API-equivalent cost view">
              <TabsTrigger value="graph">Graph</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
          </CardAction>
        </CardHeader>
        <StatGroup className="border-border border-y">
          <Stat label="Estimated API equivalent" value={formatUsd(cost.estimated_cost_usd)} caption="USD · observed request pricing inputs only" />
          <Stat label="Priced tokens" value={exactTokens(cost.priced_tokens)} caption={`${percent(cost.priced_token_coverage)} of tokens carrying price inputs`} />
          <Stat label="Unpriced tokens" value={exactTokens(cost.unpriced_tokens)} caption={unpricedReasons.length ? unpricedReasons.map(([reason, tokens]) => `${reason.replaceAll('_', ' ')} ${compactTokens(tokens)}`).join(' · ') : 'none in pricing inputs'} />
          <Stat label="Input evidence" value={percent(result.pricing_inputs.coverage.headline ? result.pricing_inputs.coverage.classified / result.pricing_inputs.coverage.headline : null)} caption={`${exactTokens(result.pricing_inputs.coverage.classified)} of ${exactTokens(result.pricing_inputs.coverage.headline)} headline tokens carry a model in request detail`} />
        </StatGroup>
        <div className="grid gap-4 p-4">
          <TabsContent value="graph">
            {series.length && categories.length
              ? <UsageSeriesChart categories={categories} series={series} unit="estimated USD" formatValue={formatUsd} formatAxis={formatUsd} />
              : noEvidence}
          </TabsContent>
          <TabsContent value="table" className="grid gap-4">
            <CostModelTable rows={cost.by_model} empty={noEvidence} />
            <CostPeriodTable rows={cost.series} />
            <CostDimensionTable rows={cost.by_model_effort_service_tier} />
          </TabsContent>
          <Disclosure title="Catalog, coverage, and assumptions" contentClassName="text-muted-foreground grid gap-3 text-xs leading-relaxed">
            <p>Catalog {cost.pricing_catalog.version}. Rates are per {exactTokens(cost.pricing_catalog.unit_tokens)} tokens. {result.pricing_inputs.coverage.note}</p>
            <p>{exactTokens(cost.missing_service_tier_calls_assumed_standard)} calls assumed Standard service tier · {exactTokens(cost.assumed_cache_write_ttl_calls)} calls assumed a 5-minute cache-write TTL · {exactTokens(cost.priority_at_standard_calls)} Anthropic priority calls priced at Standard and flagged.</p>
            <ul className="grid gap-1">{cost.assumptions.map(assumption => <li key={assumption}>• {assumption}</li>)}</ul>
            <div className="flex flex-wrap gap-2">{cost.pricing_catalog.sources.map(source => <Button key={`${source.label}:${source.url}`} variant="outline" size="xs" asChild><a href={source.url} target="_blank" rel="noreferrer">{source.label}</a></Button>)}</div>
          </Disclosure>
        </div>
        <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed">Cost lines use each request&apos;s source price date in America/Chicago. A missing date is a gap in request pricing evidence, not a zero-cost day. Hiding a line or switching this view does not change the selected scope or the token headline.</p>
      </Tabs>
    </Card>
  );
}

type ModelRow = UsageQueryResult['by_model'][number];

export function ModelSummaryTable({ result, colors }: { result: UsageQueryResult; colors: Map<string, string> }) {
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
        <i aria-hidden className="inline-block size-1.5 shrink-0 rounded-xs" style={{ background: colors.get(row.model) }} />
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

export function TokensByModelCard({ result, colors }: { result: UsageQueryResult; colors: Map<string, string> }) {
  const [view, setView] = useViewPreference('observatory.tokens.model-view.v1');
  const categories: ChartCategory[] = result.series.points.map(point => {
    const label = intervalLabel(point, result.scope.range.timezone, result.series.resolution);
    return { key: point.start, label, shortLabel: label.split(' · ')[0] };
  });
  const indexed = new Map(result.model_series.map(model => [model.model, new Map(model.points.map(point => [point.start, point]))]));
  const series: ChartSeries[] = result.by_model.map(model => {
    const values = indexed.get(model.model);
    return {
      key: model.model, label: modelLabel(model.model), color: colors.get(model.model) ?? 'var(--muted-foreground)',
      values: result.series.points.map(point => point.state === 'missing' || (point.sources.length > 0 && point.sources.every(source => source === 'snapshot'))
        ? null : values?.get(point.start)?.total_tokens ?? 0),
      details: result.series.points.map(point => {
        const value = values?.get(point.start);
        return value ? `${exactTokens(value.calls)} calls` : point.state === 'missing' ? 'no collector coverage' : 'no calls for this model';
      }),
    };
  });
  const attributed = result.by_model.reduce((sum, row) => sum + row.total_tokens, 0);
  const unattributed = Math.max(0, result.headline.total_tokens - attributed);

  return (
    <Card className="gap-0 overflow-hidden py-0" aria-label="Tokens by model">
      <Tabs value={view} onValueChange={next => { if (next === 'graph' || next === 'table') setView(next); }} className="gap-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Tokens by model</CardTitle>
          <CardAction>
            <TabsList aria-label="Tokens by model view">
              <TabsTrigger value="graph">Graph</TabsTrigger>
              <TabsTrigger value="table">Table</TabsTrigger>
            </TabsList>
          </CardAction>
        </CardHeader>
        {/* The plot is inset; the ledger runs to the card's own edge, the way a shadcn table sits in a card. */}
        <TabsContent value="graph" className="p-4 pt-6">
          {series.length
            ? <UsageSeriesChart categories={categories} series={series} unit="tokens" formatValue={value => `${exactTokens(value)} tokens`} formatAxis={compactTokens} />
            : <EmptyState title="No model series in this scope" description="The selected token total remains visible above, but these records do not carry a model breakdown." />}
        </TabsContent>
        <TabsContent value="table">
          <ModelSummaryTable result={result} colors={colors} />
        </TabsContent>
        <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed">
          {exactTokens(attributed)} of {exactTokens(result.headline.total_tokens)} headline tokens are attributed to a recorded model.
          {unattributed > 0 ? ` ${exactTokens(unattributed)} tokens remain outside this breakdown, including snapshots without model detail.` : ' The model rows reconcile to the headline.'}
          {' '}A missing point means model detail is unavailable for that interval; it is not drawn as zero.
        </p>
      </Tabs>
    </Card>
  );
}

export function UsageInsightCards({ result }: { result: UsageQueryResult }) {
  const colors = modelColors([...result.by_model.map(row => row.model), ...result.cost.by_model.map(row => row.model)]);
  return <><ApiCostCard result={result} colors={colors} /><TokensByModelCard result={result} colors={colors} /></>;
}
