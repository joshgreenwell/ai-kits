'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, SparkBars, Stat, StatGroup } from '@/components/kit';
import { Choice, type LiveData, when } from '@/components/telemetry-shared';
import { quotaCycles, quotaOutlook } from '@/lib/telemetry-contract';

type Outlook = NonNullable<ReturnType<typeof quotaOutlook>>;
type WindowView = { account: LiveData['accounts'][number]; pace: Outlook };

const DAY = 86_400_000;
const HISTORY_DAYS = 30;

function dayKey(at: string | number) {
  const timestamp = typeof at === 'number' ? at : Date.parse(at);
  return new Date(Math.floor(timestamp / DAY) * DAY).toISOString();
}

function shortDay(at: string) {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function ModelUsageHistory({ data, windows, now }: { data: LiveData; windows: WindowView[]; now: number }) {
  const [selectedWindowId, setSelectedWindowId] = useState('');
  const options = windows.map(window => ({
    id: `${window.account.id}:${window.pace.window_key}`,
    label: `${window.account.label} · ${window.pace.label}`,
    window,
  }));
  const selected = options.find(option => option.id === selectedWindowId) ?? options[0];
  const selectedAccountId = selected?.window.account.id;
  const selectedWindowKey = selected?.window.pace.window_key;

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
    const models = [...byModel].map(([model, values]) => ({
      model,
      calls: values.calls,
      activeHours: values.activeHours.size,
      share: totalCalls ? values.calls / totalCalls * 100 : 0,
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

  if (!selected || !history) {
    return (
      <EmptyState
        title="No allowance history to compare"
        description="Model activity history appears after an account has both allowance readings and local call records."
      />
    );
  }

  const axis = [shortDay(history.days[0]), 'Daily share', 'Today'];
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Model activity during allowance burn</CardTitle>
        <CardDescription>
          Thirty UTC days · allowance points and model call share, without token-based quota attribution
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

      <StatGroup className="border-border border-y">
        <Stat label="Observed burn" value={`${history.allowancePoints.toFixed(1)} pts`} caption="positive allowance changes in view" />
        <Stat label="Reset cycles" value={history.cycles.length.toLocaleString()} caption="current and completed cycles represented" />
        <Stat label="Models active" value={history.models.length.toLocaleString()} caption={`${history.totalCalls.toLocaleString()} collected calls`} />
      </StatGroup>

      <CardContent className="grid gap-5 p-4">
        <div className="grid gap-2 rounded-lg border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Allowance burn by day</h3>
              <p className="text-muted-foreground text-xs">Positive provider-observed changes; reset drops are cycle boundaries, not negative burn.</p>
            </div>
            <span className="text-muted-foreground font-mono text-[10px]">Last reading {when(history.latestQuotaAt)}</span>
          </div>
          <SparkBars
            values={history.allowance}
            markIndex={history.allowance.length - 1}
            axis={[shortDay(history.days[0]), `${Math.max(...history.allowance).toFixed(1)} pts peak`, 'Today']}
            formatValue={value => `${value.toFixed(1)} pts`}
          />
        </div>

        {history.models.length ? (
          <div className="divide-border grid divide-y rounded-lg border">
            {history.models.map(model => (
              <div key={model.model} className="grid gap-3 p-4 [content-visibility:auto] lg:grid-cols-[minmax(180px,0.42fr)_minmax(300px,1fr)] lg:items-center">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm font-medium" title={model.model}>{model.model}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge variant="soft">{model.share.toFixed(1)}% of calls</Badge>
                    <Badge variant="outline">{model.activeHours} active {model.activeHours === 1 ? 'hour' : 'hours'}</Badge>
                  </div>
                </div>
                <SparkBars
                  values={model.dailyShare}
                  markIndex={model.dailyShare.length - 1}
                  axis={axis}
                  formatValue={value => `${value.toFixed(1)}% of calls`}
                />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No local model calls in this range"
            description="Allowance history is available, but this account has no model-attributed local calls in the same 30-day view."
          />
        )}

        <p className="text-muted-foreground text-xs leading-relaxed">
          Model rows describe activity observed alongside this account&apos;s allowance window. They do not claim that a model consumed the same share of allowance; pooled provider limits cannot be divided reliably with the data collected today.
        </p>
      </CardContent>
    </Card>
  );
}
