'use client';

import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

const MODEL_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--muted-foreground)'];

export type ChartCategory = { key: string; label: string; shortLabel: string };
export type ChartSeries = { key: string; label: string; color: string; values: (number | null)[]; details?: (string | null)[] };

/** Stable within one result and shared by the cost and token cards. */
export function modelColors(models: string[]) {
  return new Map([...new Set(models)].sort().map((model, index) => [model, MODEL_COLORS[index % MODEL_COLORS.length]]));
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
    <div className="grid gap-3" data-slot="usage-series-chart">
      <div className="flex flex-wrap items-center gap-2" aria-label="Chart series">
        {series.map(item => (
          <Button key={item.key} type="button" size="xs" variant={visible.has(item.key) ? 'outline' : 'ghost'}
            aria-pressed={visible.has(item.key)}
            onClick={() => {
              setVisible(current => {
                const next = new Set(current);
                if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
                return next;
              });
            }}>
            <i aria-hidden className="block h-0.5 w-4 rounded" style={{ background: visible.has(item.key) ? item.color : 'var(--border)' }} />
            <span className={visible.has(item.key) ? '' : 'text-muted-foreground line-through'}>{item.label}</span>
          </Button>
        ))}
        {series.length > 5 ? <span className="text-muted-foreground text-[11px]">Top 5 shown initially.</span> : null}
        {visible.size < series.length ? <Button type="button" variant="ghost" size="xs" onClick={() => setVisible(new Set(series.map(item => item.key)))}>Show all</Button> : null}
      </div>

      <ChartContainer config={config} className="aspect-auto h-[220px] w-full" aria-label={`${unit} over time by model`}>
        <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="shortLabel" tickLine={false} axisLine={false} tickMargin={8} />
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
              <Line key={item.key} dataKey={key} type="linear" stroke={`var(--color-${key})`} strokeWidth={2}
                connectNulls={false} isAnimationActive={false}
                dot={props => {
                  const value = typeof props.value === 'number' ? props.value : Number(props.value);
                  if (props.cx == null || props.cy == null || !Number.isFinite(value)) return null;
                  const payload = props.payload as Record<string, unknown> | undefined;
                  const detail = payload?.[`${key}_detail`];
                  const label = `${item.label}, ${String(payload?.label ?? '')}: ${formatValue(value)}${typeof detail === 'string' ? `, ${detail}` : ''}`;
                  return (
                    <circle cx={props.cx} cy={props.cy} r={3.5} fill={item.color} stroke="var(--card)" strokeWidth={2}
                      role="img" aria-label={label} />
                  );
                }}
                activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }} />
            );
          })}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
