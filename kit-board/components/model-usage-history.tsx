'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { EmptyState, Stat, StatGroup } from '@/components/kit';
import { UsageSeriesChart, modelColors, type ChartCategory, type ChartSeries } from '@/components/usage-series-chart';
import { Choice, type LiveData, when } from '@/components/telemetry-shared';
import { fetchPrivateJson, USAGE_QUERY_TIMEOUT_MS } from '@/lib/fetch-private-json';
import { quotaCycles, quotaOutlook } from '@/lib/telemetry-contract';
import { meterLabel } from '@/lib/allowance-meters';
import type { UsageQueryResult } from '@/lib/usage-query';

type Outlook = NonNullable<ReturnType<typeof quotaOutlook>>;
type WindowView = { account: LiveData['accounts'][number]; pace: Outlook };
type ModelSeries = { model: string; calls: number; activeHours: number; share: number; dailyShare: number[]; dailyCalls: number[] };

const DAY = 86_400_000;
const HISTORY_DAYS = 30;
/** Highest effort keeps the model's own colour; each step down the ladder is mixed toward the card. */
const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'max'];
const effortRank = (effort: string) => {
  const index = EFFORT_LADDER.indexOf(effort);
  return index < 0 ? EFFORT_LADDER.length : index;
};

function dayKey(at: string | number) {
  const timestamp = typeof at === 'number' ? at : Date.parse(at);
  return new Date(Math.floor(timestamp / DAY) * DAY).toISOString();
}

const shortDay = (at: string) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDay = (at: string) => `${new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} UTC`;

const burnConfig = { points: { label: 'Allowance burn', color: 'var(--primary)' } } satisfies ChartConfig;

/**
 * Allowance points burned on each day, on the vendored shadcn/Recharts primitive: hovering, tapping, or
 * arrowing through the bars gives the exact day and its points. Recharts draws nothing until it has
 * measured its container, so the same readings are mirrored into the DOM for assistive tech.
 */
function BurnBars({ days, values }: { days: string[]; values: number[] }) {
  const data = days.map((day, index) => ({ day, shortLabel: shortDay(day), label: longDay(day), points: values[index] ?? 0 }));
  return (
    <div className="grid gap-1" data-slot="allowance-burn-bars">
      <ChartContainer config={burnConfig} className="aspect-auto h-[180px] w-full" aria-label={`Allowance points burned on each of ${days.length} days`}>
        <BarChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }} barCategoryGap={1}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="shortLabel" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
          <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} tickFormatter={value => `${Number(value).toFixed(0)} pts`} />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)', fillOpacity: 0.6 }}
            content={
              <ChartTooltipContent
                hideIndicator
                labelFormatter={(_, payload) => String((payload?.[0]?.payload as { label?: string } | undefined)?.label ?? '')}
                formatter={value => (
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">Allowance burn</span>
                    <span className="text-foreground font-mono font-medium tabular-nums">{Number(value).toFixed(1)} pts</span>
                  </div>
                )}
              />
            }
          />
          <Bar dataKey="points" fill="var(--color-points)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      <div className="sr-only">
        {data.map(row => <span key={row.day} role="img" aria-label={`${row.label}: ${row.points.toFixed(1)} allowance points`} />)}
      </div>
    </div>
  );
}

/**
 * Effort lives on request detail only: the hourly ledger records which model answered, never how hard it
 * was asked to think. The split therefore reads a different population from the rest of this card, and is
 * fetched only while it is being shown.
 */
function useEffortSeries(accountId: string | undefined, enabled: boolean) {
  const [effort, setEffort] = useState<UsageQueryResult['effort_series'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !accountId) { setEffort(null); setError(null); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(null);
    fetchPrivateJson<UsageQueryResult>(`/api/usage-query?preset=last_30_days&timezone=UTC&resolution=day&accounts=${encodeURIComponent(accountId)}`, controller.signal, USAGE_QUERY_TIMEOUT_MS, false)
      .then(result => { if (!controller.signal.aborted) setEffort(result.effort_series); })
      .catch(() => { if (!controller.signal.aborted) setError('Effort detail is temporarily unavailable. Hide and show the split to retry.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountId, enabled]);
  return { effort, error, loading };
}

/** One line per model and effort, each day's value being that pair's share of the day's request-detail calls. */
function effortChartSeries(rows: UsageQueryResult['effort_series']['rows'], days: string[]): ChartSeries[] {
  const index = new Map(days.map((day, position) => [day, position]));
  const callsByDay = days.map(() => 0);
  const counted = rows.map(row => {
    const calls = days.map(() => 0);
    for (const point of row.points) {
      const position = index.get(dayKey(point.start));
      if (position === undefined) continue;
      calls[position] += point.calls;
      callsByDay[position] += point.calls;
    }
    return { ...row, calls, total: calls.reduce((sum, value) => sum + value, 0) };
  }).filter(row => row.total > 0);

  const colors = modelColors(counted.map(row => row.model));
  const ladder = new Map<string, string[]>();
  for (const row of counted) {
    const efforts = ladder.get(row.model) ?? [];
    if (!efforts.includes(row.effort)) efforts.push(row.effort);
    ladder.set(row.model, efforts);
  }
  for (const efforts of ladder.values()) efforts.sort((a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b));

  return counted.map(row => {
    const efforts = ladder.get(row.model)!;
    const step = efforts.length - 1 - efforts.indexOf(row.effort);
    const base = colors.get(row.model) ?? 'var(--muted-foreground)';
    return {
      key: `${row.model} ${row.effort}`,
      label: `${row.model} · ${row.effort}`,
      color: step === 0 ? base : `color-mix(in oklab, ${base} ${Math.max(40, 100 - step * 22)}%, var(--card))`,
      values: row.calls.map((calls, position) => (callsByDay[position] ? (calls / callsByDay[position]) * 100 : 0)),
      details: row.calls.map(calls => `${calls.toLocaleString()} ${calls === 1 ? 'call' : 'calls'}`),
    };
  }).sort((a, b) => b.values.reduce((sum, value) => sum + value, 0) - a.values.reduce((sum, value) => sum + value, 0));
}

export function ModelUsageHistory({ data, windows, now }: { data: LiveData; windows: WindowView[]; now: number }) {
  const [selectedWindowId, setSelectedWindowId] = useState('');
  const [splitByEffort, setSplitByEffort] = useState(false);
  const options = windows.map(window => ({
    id: `${window.account.id}:${window.pace.window_key}`,
    // The same canonical meter title the cards use, so a reader switch never renames a choice.
    label: `${window.account.label} · ${meterLabel(window.pace.window_key, window.pace.label)}`,
    window,
  }));
  const selected = options.find(option => option.id === selectedWindowId) ?? options[0];
  const selectedAccountId = selected?.window.account.id;
  const selectedWindowKey = selected?.window.pace.window_key;
  const { effort, error: effortError, loading: effortLoading } = useEffortSeries(selectedAccountId, splitByEffort);

  const history = useMemo(() => {
    if (!selectedAccountId || !selectedWindowKey) return null;
    const end = Math.floor(now / DAY) * DAY;
    const start = end - (HISTORY_DAYS - 1) * DAY;
    const days = Array.from({ length: HISTORY_DAYS }, (_, index) => new Date(start + index * DAY).toISOString());
    const selectedQuotas = data.quotas.filter(row =>
      row.account_id === selectedAccountId
      && row.window_key === selectedWindowKey
      && Date.parse(row.observed_at) >= start
      && Date.parse(row.observed_at) < end + DAY);
    const cycles = quotaCycles(selectedQuotas, now);
    const allowanceByDay = new Map(days.map(day => [day, 0]));
    for (const cycle of cycles) {
      for (let index = 1; index < cycle.samples.length; index++) {
        const previous = cycle.samples[index - 1], current = cycle.samples[index];
        const key = dayKey(current.observed_at);
        if (allowanceByDay.has(key)) allowanceByDay.set(key, allowanceByDay.get(key)! + Math.max(0, current.used_percent - previous.used_percent));
      }
    }

    const rows = data.hourly.filter(row => row.account_id === selectedAccountId && Date.parse(row.hour) >= start && Date.parse(row.hour) < end + DAY);
    const callsByDay = new Map(days.map(day => [day, 0]));
    const byModel = new Map<string, { calls: number; activeHours: Set<string>; daily: Map<string, number> }>();
    for (const row of rows) {
      const key = dayKey(row.hour);
      callsByDay.set(key, (callsByDay.get(key) ?? 0) + row.calls);
      const model = byModel.get(row.model) ?? { calls: 0, activeHours: new Set<string>(), daily: new Map<string, number>() };
      model.calls += row.calls;
      model.daily.set(key, (model.daily.get(key) ?? 0) + row.calls);
      if (row.calls > 0) model.activeHours.add(row.hour);
      byModel.set(row.model, model);
    }
    const totalCalls = [...callsByDay.values()].reduce((sum, calls) => sum + calls, 0);
    const models: ModelSeries[] = [...byModel].map(([model, values]) => ({
      model,
      calls: values.calls,
      activeHours: values.activeHours.size,
      share: totalCalls ? values.calls / totalCalls * 100 : 0,
      dailyCalls: days.map(day => values.daily.get(day) ?? 0),
      dailyShare: days.map(day => {
        const dailyTotal = callsByDay.get(day) ?? 0;
        return dailyTotal ? (values.daily.get(day) ?? 0) / dailyTotal * 100 : 0;
      }),
    })).sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));
    return {
      days,
      cycles,
      models,
      totalCalls,
      allowance: days.map(day => allowanceByDay.get(day) ?? 0),
      allowancePoints: [...allowanceByDay.values()].reduce((sum, points) => sum + points, 0),
      latestQuotaAt: selectedQuotas.at(-1)?.observed_at ?? null,
    };
  }, [data, now, selectedAccountId, selectedWindowKey]);

  const categories: ChartCategory[] = useMemo(() => (history ?? { days: [] }).days.map(day => ({ key: day, label: longDay(day), shortLabel: shortDay(day) })), [history]);
  const modelSeries: ChartSeries[] = useMemo(() => {
    if (!history) return [];
    const colors = modelColors(history.models.map(model => model.model));
    return history.models.map(model => ({
      key: model.model,
      label: model.model,
      color: colors.get(model.model) ?? 'var(--muted-foreground)',
      values: model.dailyShare,
      details: model.dailyCalls.map(calls => `${calls.toLocaleString()} ${calls === 1 ? 'call' : 'calls'}`),
    }));
  }, [history]);
  const splitSeries = useMemo(() => (effort && history ? effortChartSeries(effort.rows, history.days) : []), [effort, history]);

  if (!selected || !history) {
    return (
      <EmptyState
        title="No allowance history to compare"
        description="Model activity history appears after an account has both allowance readings and local call records."
      />
    );
  }

  const showingSplit = splitByEffort && splitSeries.length > 0;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Model activity during allowance burn</CardTitle>
        <CardDescription>
          Thirty UTC days · allowance points and each model’s share of the day’s calls, without token-based quota attribution
        </CardDescription>
        <CardAction>
          <Choice
            label="Allowance"
            value={selected.id}
            onChange={setSelectedWindowId}
            options={options.map(option => ({ value: option.id, label: option.label }))}
          />
        </CardAction>
      </CardHeader>

      <StatGroup className="border-border border-t">
        <Stat label="Observed burn" value={`${history.allowancePoints.toFixed(1)} pts`} caption="positive allowance changes in view" />
        <Stat label="Reset cycles" value={history.cycles.length.toLocaleString()} caption="current and completed cycles represented" />
        <Stat label="Models active" value={history.models.length.toLocaleString()} caption={`${history.totalCalls.toLocaleString()} collected calls`} />
      </StatGroup>

      {/* Full-bleed sections divided by a single rule, the way every other data card here is built: a
          rounded ring inside a rounded card reads as a second, nested container. */}
      <div className="border-border grid gap-3 border-t p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Allowance burn by day</h3>
            <p className="text-muted-foreground text-xs">Positive provider-observed changes; reset drops are cycle boundaries, not negative burn.</p>
          </div>
          <span className="text-muted-foreground font-mono text-[10px]">Last reading {when(history.latestQuotaAt)}</span>
        </div>
        <BurnBars days={history.days} values={history.allowance} />
      </div>

      <div className="border-border grid gap-3 border-t p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Model share by day</h3>
            <p className="text-muted-foreground text-xs">
              {!splitByEffort
                ? 'One line per model. Use the keys below the chart to take a model out of the picture or bring it back.'
                : showingSplit
                  ? 'One line per model and reasoning effort, as a share of the day’s request-detail calls — a smaller population than the collected calls above.'
                  : 'Splitting by reasoning effort needs request detail, which this account has not collected yet.'}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" aria-pressed={splitByEffort} onClick={() => setSplitByEffort(value => !value)}>
            {effortLoading ? 'Loading effort…' : splitByEffort ? 'Hide effort' : 'Show effort'}
          </Button>
        </div>

        {effortError && splitByEffort ? <p className="text-warning text-xs">{effortError}</p> : null}

        {!history.models.length ? (
          <EmptyState
            title="No local model calls in this range"
            description="Allowance history is available, but this account has no model-attributed local calls in the same 30-day view."
          />
        ) : splitByEffort && !showingSplit && !effortLoading && !effortError ? (
          <EmptyState
            title="No effort detail for this account"
            description={`Reasoning effort is recorded on request detail, which the hourly ledger behind the lines above does not carry. ${effort ? `Request detail covers ${(effort.coverage.applicable * 100).toFixed(0)}% of the tokens in this range, and none of it reports an effort yet.` : ''} The split appears once a collector posts request records for this account.`}
          />
        ) : (
          <UsageSeriesChart
            key={showingSplit ? 'effort' : 'model'}
            categories={categories}
            series={showingSplit ? splitSeries : modelSeries}
            unit="Share of the day’s calls"
            formatValue={value => `${value.toFixed(1)}%`}
            formatAxis={value => `${Math.round(value)}%`}
          />
        )}
      </div>

      <p className="text-muted-foreground border-border border-t p-3 text-xs leading-relaxed">
        Model lines describe activity observed alongside this account&apos;s allowance window. They do not claim that a model consumed the same share of allowance; pooled provider limits cannot be divided reliably with the data collected today.
      </p>
    </Card>
  );
}
