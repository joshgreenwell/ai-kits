'use client';
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from 'recharts';
import { cn } from 'cn';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import type { SeriesPoint } from '@/lib/usage-query';
import type { Resolution } from '@/lib/usage-periods';
import { STATE_LABELS, compactTokens, exactTokens, intervalLabel, percent } from '@/lib/usage-view';

type Row = { shortLabel: string; label: string; total_tokens: number; point: SeriesPoint };
type BarShapeProps = { x?: number; y?: number; width?: number; height?: number; payload?: Row };

const config = { total_tokens: { label: 'Tokens', color: 'var(--primary)' } } satisfies ChartConfig;

/**
 * A bar is not always a quantity here: a recorded zero, an interval with no collector coverage, and an
 * interval still being observed have to look different from each other and from a small real value, or
 * absence reads as activity. Recharts draws a rectangle per value and nothing else, so the shape is
 * drawn here: flat tick for a recorded zero, dashed tick for missing coverage, hollow bar while the
 * interval is still open, solid bar once it is closed.
 */
function IntervalBar({ x = 0, y = 0, width = 0, height = 0, payload }: BarShapeProps) {
  const state = payload?.point.state;
  const w = Math.max(1, width);
  if (state === 'missing') return <line x1={x} x2={x + w} y1={y} y2={y} stroke="var(--muted-foreground)" strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="3 2" />;
  if (height < 1) return <rect x={x} y={y - 2} width={w} height={2} fill="var(--muted-foreground)" fillOpacity={0.5} />;
  const drawn = Math.max(2, height);
  return state === 'partial'
    ? <Rectangle x={x} y={y + height - drawn} width={w} height={drawn} radius={[2, 2, 0, 0]} fill="var(--primary)" fillOpacity={0.25} stroke="var(--primary)" strokeWidth={1} />
    : <Rectangle x={x} y={y + height - drawn} width={w} height={drawn} radius={[2, 2, 0, 0]} fill="var(--primary)" fillOpacity={0.7} />;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Tokens over time (USG-017) on the vendored shadcn/Recharts primitive: hovering, tapping, or arrowing
 * through the bars reveals the same exact interval in the chart's own tooltip. The exact values are
 * mirrored into the DOM as well, because Recharts draws nothing until it has measured the container.
 */
export function IntervalBars({ points, timezone, resolution, className }: { points: SeriesPoint[]; timezone: string; resolution: Resolution; className?: string }) {
  const data: Row[] = points.map(point => {
    const label = intervalLabel(point, timezone, resolution);
    return { shortLabel: label.split(' · ')[0], label, total_tokens: point.total_tokens, point };
  });

  return (
    <div data-slot="interval-bars" className={cn('grid gap-2', className)}>
      <ChartContainer config={config} className="aspect-auto h-[220px] w-full" aria-label={`${points.length} intervals of tokens over time`}>
        <BarChart accessibilityLayer data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }} barCategoryGap={1}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="shortLabel" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
          <YAxis tickLine={false} axisLine={false} width={48} tickMargin={4} tickFormatter={value => compactTokens(Number(value))} />
          <ChartTooltip
            cursor={{ fill: 'var(--muted)', fillOpacity: 0.6 }}
            content={
              <ChartTooltipContent
                hideIndicator
                className="min-w-[15rem]"
                labelFormatter={(_, payload) => String((payload?.[0]?.payload as Row | undefined)?.label ?? '')}
                formatter={(_value, _name, item) => {
                  const point = (item.payload as Row | undefined)?.point;
                  if (!point) return null;
                  const c = point.composition;
                  return (
                    <div className="grid flex-1 gap-1">
                      <div className="flex items-baseline justify-between gap-4">
                        <span className="text-muted-foreground">Tokens</span>
                        <span className="text-foreground font-mono font-medium tabular-nums">{exactTokens(point.total_tokens)}</span>
                      </div>
                      <Line label="Calls" value={exactTokens(point.calls)} />
                      <div className="border-border/50 grid gap-0.5 border-t pt-1">
                        <Line label="Fresh input" value={compactTokens(c.input_fresh)} />
                        <Line label="Cached input" value={compactTokens(c.input_cached)} />
                        <Line label="Cache-write" value={compactTokens(c.input_cache_write)} />
                        <Line label="Output" value={c.reasoning !== null && c.output > 0 ? `${compactTokens(c.output)} · reasoning ${percent(c.reasoning / c.output)}` : compactTokens(c.output)} />
                        {c.unclassified > 0 ? <Line label="Unclassified" value={compactTokens(c.unclassified)} /> : null}
                      </div>
                      <p className="text-muted-foreground border-border/50 border-t pt-1">
                        {STATE_LABELS[point.state]}{point.sources.length ? ` · from ${point.sources.join(' + ')}` : ''}
                      </p>
                    </div>
                  );
                }}
              />
            }
          />
          <Bar dataKey="total_tokens" shape={IntervalBar} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>

      {/* The same reading the tooltip gives, available to assistive tech before the chart is measured. */}
      <div className="sr-only">
        {data.map(row => (
          <span key={row.point.start} role="img" aria-label={`${row.label}: ${exactTokens(row.point.total_tokens)} tokens, ${exactTokens(row.point.calls)} calls, ${STATE_LABELS[row.point.state]}`} />
        ))}
      </div>
    </div>
  );
}
