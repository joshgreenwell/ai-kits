'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

const MODEL_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--muted-foreground)'];

export type ChartCategory = { key: string; label: string; shortLabel: string };
export type ChartSeries = { key: string; label: string; color: string; values: (number | null)[]; details?: (string | null)[] };

/** Stable within one result and shared by the cost and token cards. */
export function modelColors(models: string[]) {
  return new Map([...new Set(models)].sort().map((model, index) => [model, MODEL_COLORS[index % MODEL_COLORS.length]]));
}

function chunks(values: (number | null)[]) {
  const result: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) result.push(current);
      current = [];
    } else current.push(index);
  });
  if (current.length) result.push(current);
  return result;
}

/**
 * A dependency-free multi-series line chart. Legend buttons change presentation only; each point is
 * reachable with one tab stop per visible line and arrow keys, and hover, focus, or tap reveals the
 * same exact value below the plot.
 */
export function UsageSeriesChart({ categories, series, unit, formatValue, formatAxis }: {
  categories: ChartCategory[]; series: ChartSeries[]; unit: string;
  formatValue: (value: number) => string; formatAxis: (value: number) => string;
}) {
  const defaults = useMemo(() => series.slice(0, 5).map(item => item.key), [series]);
  const signature = series.map(item => item.key).join('\0');
  const [visible, setVisible] = useState<Set<string>>(() => new Set(defaults));
  const [active, setActive] = useState<{ series: string; index: number } | null>(null);
  const points = useRef(new Map<string, SVGGElement>());
  const detailId = useId();
  useEffect(() => { setVisible(new Set(defaults)); setActive(null); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = series.filter(item => visible.has(item.key));
  const maximum = Math.max(1, ...shown.flatMap(item => item.values.map(value => value ?? 0)));
  const width = 640, height = 220, left = 54, right = 12, top = 12, bottom = 24;
  const x = (index: number) => left + (categories.length > 1 ? index / (categories.length - 1) : 0.5) * (width - left - right);
  const y = (value: number) => top + (1 - value / maximum) * (height - top - bottom);
  const activeSeries = active ? series.find(item => item.key === active.series) : null;
  const activeValue = activeSeries && active ? activeSeries.values[active.index] : null;
  const firstPoint = (item: ChartSeries) => item.values.findIndex(value => value !== null);
  const pointKey = (seriesKey: string, index: number) => `${seriesKey}\0${index}`;
  const move = (event: React.KeyboardEvent<SVGGElement>, item: ChartSeries, index: number) => {
    const candidates = item.values.map((value, at) => value === null ? -1 : at).filter(at => at >= 0);
    const here = candidates.indexOf(index);
    const next = event.key === 'ArrowRight' ? candidates[here + 1] : event.key === 'ArrowLeft' ? candidates[here - 1]
      : event.key === 'Home' ? candidates[0] : event.key === 'End' ? candidates.at(-1) : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive({ series: item.key, index: next });
    points.current.get(pointKey(item.key, next))?.focus();
  };
  const ticks = [maximum, maximum / 2, 0];
  const middle = Math.floor(categories.length / 2);

  return (
    <div className="grid gap-3" data-slot="usage-series-chart">
      <div className="flex flex-wrap items-center gap-2" aria-label="Chart series">
        {series.map(item => (
          <button key={item.key} type="button" aria-pressed={visible.has(item.key)}
            onClick={() => {
              setActive(null);
              setVisible(current => {
                const next = new Set(current);
                if (next.has(item.key)) next.delete(item.key); else next.add(item.key);
                return next;
              });
            }}
            className="border-border focus-visible:ring-ring/50 inline-flex min-h-8 items-center gap-2 rounded-md border px-2.5 py-1 text-xs outline-none focus-visible:ring-[3px]">
            <i aria-hidden className="block h-0.5 w-4 rounded" style={{ background: visible.has(item.key) ? item.color : 'var(--border)' }} />
            <span className={visible.has(item.key) ? '' : 'text-muted-foreground line-through'}>{item.label}</span>
          </button>
        ))}
        {series.length > 5 ? <span className="text-muted-foreground text-[11px]">Top 5 shown initially.</span> : null}
        {visible.size < series.length ? <Button type="button" variant="ghost" size="xs" onClick={() => setVisible(new Set(series.map(item => item.key)))}>Show all</Button> : null}
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${unit} over time by model`} aria-describedby={detailId} className="w-full min-w-0">
        {ticks.map((tick, index) => (
          <g key={index}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeDasharray={index === 2 ? undefined : '4 4'} />
            <text x={left - 6} y={y(tick) + 4} textAnchor="end" fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{formatAxis(tick)}</text>
          </g>
        ))}
        {shown.map(item => (
          <g key={item.key}>
            {chunks(item.values).map((indexes, chunk) => (
              indexes.length > 1 ? <polyline key={chunk} points={indexes.map(index => `${x(index)},${y(item.values[index]!)}`).join(' ')}
                fill="none" stroke={item.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /> : null
            ))}
            {item.values.map((value, index) => value === null ? null : (
              <g key={index} ref={node => { if (node) points.current.set(pointKey(item.key, index), node); }}
                role="button"
                tabIndex={index === (active?.series === item.key ? active.index : firstPoint(item)) ? 0 : -1}
                aria-label={`${item.label}, ${categories[index]?.label}: ${formatValue(value)}${item.details?.[index] ? `, ${item.details[index]}` : ''}`}
                onKeyDown={event => move(event, item, index)} onMouseEnter={() => setActive({ series: item.key, index })}
                onFocus={() => setActive({ series: item.key, index })} onClick={() => setActive({ series: item.key, index })}
                className="group cursor-pointer outline-none">
                <circle cx={x(index)} cy={y(value)} r="12" fill="transparent" />
                <circle cx={x(index)} cy={y(value)} r={active?.series === item.key && active.index === index ? 5 : 3.5}
                  fill={item.color} stroke="var(--card)" strokeWidth="2" className="group-focus-visible:stroke-[var(--ring)] group-focus-visible:stroke-[4px]" />
              </g>
            ))}
          </g>
        ))}
        {categories.length ? (
          <>
            <text x={left} y={height - 4} fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{categories[0].shortLabel}</text>
            {categories.length > 2 ? <text x={x(middle)} y={height - 4} textAnchor="middle" fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{categories[middle].shortLabel}</text> : null}
            <text x={width - right} y={height - 4} textAnchor="end" fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{categories.at(-1)!.shortLabel}</text>
          </>
        ) : null}
      </svg>

      <div id={detailId} role="status" aria-live="polite" className="border-border bg-muted/40 min-h-[3.25rem] rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed">
        {activeSeries && active && activeValue !== null && activeValue !== undefined ? (
          <><span className="text-foreground font-semibold">{activeSeries.label} · {categories[active.index].label}</span><br />
            <span className="text-foreground">{formatValue(activeValue)}</span>{activeSeries.details?.[active.index] ? <span className="text-muted-foreground"> · {activeSeries.details[active.index]}</span> : null}</>
        ) : <span className="text-muted-foreground">Hover, tap, or arrow through a line for the exact value. Legend buttons only change the chart; totals and filters do not change.</span>}
      </div>
    </div>
  );
}
