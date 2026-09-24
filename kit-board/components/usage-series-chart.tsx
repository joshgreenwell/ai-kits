'use client';

import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { modelLineStyles } from '@/lib/model-colors';

export type ChartCategory = { key: string; label: string; shortLabel: string };
/** `dash` is an SVG dash array: a model served through Cursor is drawn in its lab's color, dashed. */
export type ChartSeries = { key: string; label: string; color: string; dash?: string; values: (number | null)[]; details?: (string | null)[] };

/** Each model's line style (lib/model-colors.ts), shared by the cost and token cards. */
export const modelColors = modelLineStyles;

/** One point as a sentence: which series, which category, the exact value, and the evidence behind it. */
function pointLabel(item: ChartSeries, category: ChartCategory, index: number, formatValue: (value: number) => string) {
  const detail = item.details?.[index];
  return `${item.label}, ${category.label}: ${formatValue(item.values[index] as number)}${detail ? `, ${detail}` : ''}`;
}

function chartKey(key: string) {
  return `s_${key.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

/**
 * Multi-series line chart on the vendored shadcn/Recharts primitive. Legend buttons change
 * presentation only; hover, keyboard (accessibilityLayer), and tap reveal the same exact value.
 */
export function UsageSeriesChart({ categories, series, unit, formatValue, formatAxis }: {
  categories: ChartCategory[]; series: ChartSeries[]; unit: string;
  formatValue: (value: number) => string; formatAxis: (value: number) => string;
}) {
  const defaults = useMemo(() => series.slice(0, 5).map(item => item.key), [series]);
  const signature = series.map(item => item.key).join('\0');
  const [visible, setVisible] = useState<Set<string>>(() => new Set(defaults));
  useEffect(() => { setVisible(new Set(defaults)); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = series.filter(item => visible.has(item.key));
  const config = Object.fromEntries(series.map(item => [chartKey(item.key), { label: item.label, color: item.color }])) satisfies ChartConfig;
  const data = categories.map((category, index) => {
    const row: Record<string, string | number | null> = { label: category.label, shortLabel: category.shortLabel };
    for (const item of series) {
      const key = chartKey(item.key);
      row[key] = item.values[index];
      if (item.details?.[index]) row[`${key}_detail`] = item.details[index];
    }
    return row;
  });

  return (
    <div className="grid gap-1" data-slot="usage-series-chart">
      <ChartContainer config={config} className="aspect-auto h-[220px] w-full" aria-label={`${unit} over time by model`}>
        <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          {/* A uniform gap keeps the cadence even; without it a short label (Sep 1) buys a tick a long one (Aug 18) cannot. */}
          <XAxis dataKey="shortLabel" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
          <YAxis tickLine={false} axisLine={false} width={48} tickMargin={4} tickFormatter={formatAxis} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => String(payload?.[0]?.payload?.label ?? '')}
                formatter={(value, _name, item) => {
                  const key = String(item.dataKey ?? '');
                  const detail = item.payload?.[`${key}_detail`];
                  const numeric = typeof value === 'number' ? value : Number(value);
                  return (
                    <div className="flex flex-1 items-center justify-between gap-4">
                      <span className="text-muted-foreground">{config[key]?.label ?? key}</span>
                      <span className="text-foreground font-mono font-medium tabular-nums">
                        {Number.isFinite(numeric) ? formatValue(numeric) : String(value)}
                        {typeof detail === 'string' ? ` · ${detail}` : ''}
                      </span>
                    </div>
                  );
                }}
              />
            }
          />
          {shown.map(item => {
            const key = chartKey(item.key);
            return (
              // `natural` and no resting dot is the shadcn line chart: the reading is the tooltip's job,
              // so the plot stays a smooth line and only the hovered point is marked.
              <Line key={item.key} dataKey={key} type="natural" stroke={`var(--color-${key})`} strokeWidth={2} strokeDasharray={item.dash}
                connectNulls={false} isAnimationActive={false} dot={false}
                activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }} />
            );
          })}
        </LineChart>
      </ChartContainer>

      {/*
        shadcn draws its legend as swatch and label beneath the plot; these are the same rows, made
        pressable so a reader can take a series out of the picture without leaving the card. A hidden
        series is dimmed rather than struck through: the label stays legible while the swatch carries
        the state.
      */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 pt-3 text-xs" aria-label="Chart series">
        {series.map(item => {
          const on = visible.has(item.key);
          return (
            <button key={item.key} type="button" aria-pressed={on} title={item.label}
              className="focus-visible:ring-ring/50 flex max-w-[16rem] min-w-0 cursor-pointer items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px]"
              onClick={() => {
                setVisible(current => {
                  const next = new Set(current);
                  if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
                  return next;
                });
              }}>
              {item.dash
                ? <i aria-hidden className="block h-0 w-3 shrink-0 border-t-2 border-dashed" style={{ borderColor: on ? item.color : 'var(--border)' }} />
                : <i aria-hidden className="block size-2 shrink-0 rounded-[2px]" style={{ background: on ? item.color : 'var(--border)' }} />}
              <span className={cn('truncate', on ? 'text-foreground' : 'text-muted-foreground')}>{item.label}</span>
            </button>
          );
        })}
        {visible.size < series.length ? (
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground -my-1" onClick={() => setVisible(new Set(series.map(item => item.key)))}>Show all</Button>
        ) : null}
      </div>

      {/*
        Recharts draws nothing until it has measured the container, so the exact values live in the DOM
        as well: the same reading a sighted reader gets from the tooltip, available to assistive tech
        immediately and independent of layout.
      */}
      <div className="sr-only">
        {shown.map(item => categories.map((category, index) => {
          const value = item.values[index];
          return typeof value === 'number' && Number.isFinite(value)
            ? <span key={`${item.key}:${category.key}`} role="img" aria-label={pointLabel(item, category, index, formatValue)} />
            : null;
        }))}
      </div>
    </div>
  );
}
