'use client';
import { useId, useRef, useState } from 'react';
import { cn } from 'cn';
import type { SeriesPoint } from '@/lib/usage-query';
import type { Resolution } from '@/lib/usage-periods';
import { STATE_LABELS, chartScale, compactTokens, exactTokens, intervalLabel, percent } from '@/lib/usage-view';

/**
 * Tokens over time (USG-017). One focusable bar per interval, so hover, keyboard focus, and a tap all
 * reveal the same exact detail beneath the chart; the Y axis carries three abbreviated labels and its
 * unit. A still-observed interval is outlined, a recorded zero is a flat tick, and an interval with no
 * collector coverage is a dashed tick, so absence never reads as activity. Dependency-free by design;
 * USG-016 may swap the drawing for a shared charting primitive without changing what a point means.
 */
export function IntervalBars({ points, timezone, resolution, className }: { points: SeriesPoint[]; timezone: string; resolution: Resolution; className?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const bars = useRef<(HTMLButtonElement | null)[]>([]);
  const detailId = useId();
  // One tab stop for the whole chart; arrow keys, Home, and End move between bars.
  const tabStop = active ?? 0;
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : null;
    if (target === null || target < 0 || target >= points.length) return;
    event.preventDefault(); setActive(target); bars.current[target]?.focus();
  };
  const scale = chartScale(points);
  const selected = active !== null ? points[active] : null;
  const first = points[0], last = points.at(-1), middle = points[Math.floor(points.length / 2)];
  const xLabel = (p: SeriesPoint | undefined) => (p ? intervalLabel(p, timezone, resolution).split(' · ')[0] : '');
  return (
    <div data-slot="interval-bars" className={cn('grid gap-2', className)}>
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <div className="text-muted-foreground relative w-12 font-mono text-[10px]" aria-hidden="true">
          {scale.ticks.map(tick => (
            <span key={tick.value} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ bottom: `${(tick.value / scale.max) * 100}%` }}>{tick.label}</span>
          ))}
          <span className="absolute right-0 top-0 -translate-y-full pb-0.5">tokens</span>
        </div>
        <div role="group" aria-label={`${points.length} intervals, peak ${compactTokens(scale.max)} tokens`} aria-describedby={detailId}
          className="border-border relative flex h-32 items-end gap-[2px] border-b border-l" onMouseLeave={() => setActive(null)}>
          {points.map((point, index) => {
            const height = point.state === 'observed' || point.state === 'partial' ? Math.max(point.total_tokens > 0 ? 2 : 0, (point.total_tokens / scale.max) * 100) : 0;
            const label = `${intervalLabel(point, timezone, resolution)}: ${exactTokens(point.total_tokens)} tokens, ${exactTokens(point.calls)} calls, ${STATE_LABELS[point.state]}`;
            return (
              <button key={point.start} type="button" aria-label={label} aria-pressed={active === index} tabIndex={index === tabStop ? 0 : -1}
                ref={element => { bars.current[index] = element; }} onKeyDown={event => move(event, index)}
                onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(current => (current === index ? null : index))}
                className="group focus-visible:ring-ring/50 relative flex h-full min-w-[3px] flex-1 items-end rounded-t-xs outline-none focus-visible:ring-[3px]">
                {point.state === 'missing' ? (
                  <span aria-hidden="true" className="border-muted-foreground/60 absolute inset-x-0 bottom-0 border-t border-dashed" />
                ) : point.state === 'zero' || point.total_tokens === 0 ? (
                  <span aria-hidden="true" className={cn('absolute inset-x-0 bottom-0 h-[2px]', point.state === 'partial' ? 'bg-primary/40' : 'bg-muted-foreground/50')} />
                ) : (
                  <span aria-hidden="true" style={{ height: `${height}%` }}
                    className={cn('w-full rounded-t-xs transition-colors', point.state === 'partial' ? 'bg-primary/25 ring-primary ring-1 ring-inset' : 'bg-primary/55 group-hover:bg-primary group-aria-pressed:bg-primary')} />
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className="text-muted-foreground ml-14 flex justify-between font-mono text-[10px]" aria-hidden="true">
        <span>{xLabel(first)}</span><span>{points.length > 2 ? xLabel(middle) : ''}</span><span>{xLabel(last)}</span>
      </div>
      <div id={detailId} role="status" aria-live="polite" className="border-border bg-muted/40 min-h-[3.25rem] rounded-md border px-3 py-2 font-mono text-[11px] leading-relaxed">
        {selected ? (
          <>
            <span className="text-foreground font-semibold">{intervalLabel(selected, timezone, resolution)}</span>
            <span className="text-muted-foreground"> · {STATE_LABELS[selected.state]}{selected.sources.length ? ` · from ${selected.sources.join(' + ')}` : ''}</span>
            <br />
            <span className="text-foreground">{exactTokens(selected.total_tokens)} tokens</span>
            <span className="text-muted-foreground"> · {exactTokens(selected.calls)} calls · fresh {compactTokens(selected.composition.input_fresh)} · cached {compactTokens(selected.composition.input_cached)} · cache-write {compactTokens(selected.composition.input_cache_write)} · output {compactTokens(selected.composition.output)}</span>
            {selected.composition.reasoning !== null && selected.composition.output > 0 ? <span className="text-muted-foreground"> (reasoning {percent(selected.composition.reasoning / selected.composition.output)} of output)</span> : null}
            {selected.composition.unclassified > 0 ? <span className="text-muted-foreground"> · unclassified {compactTokens(selected.composition.unclassified)}</span> : null}
          </>
        ) : (
          <span className="text-muted-foreground">Hover, tap, or arrow through the bars for each interval&rsquo;s exact tokens, calls, and composition.</span>
        )}
      </div>
    </div>
  );
}
