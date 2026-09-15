'use client';
import { useId, useState } from 'react';
import { cn } from 'cn';
import type { QuotaCycle } from '@/lib/telemetry-contract';
import type { LiveQuota, Outlook } from '@/lib/allowance-view';
import { whenIn } from '@/lib/usage-view';

/**
 * One window's burn history (USG-023). The X axis is normalized cycle time, 0% at the window's start
 * and 100% at its reset, so completed cycles sit under the active one for comparison: completed cycles
 * are faint, the active cycle is emphasized, the projection continues from the last reading to the
 * reset in a distinct stroke, the even-pace guide is the dotted diagonal, and the reset is a marked
 * edge. Each recorded reading of the active cycle is focusable, so hover, keyboard, and touch reveal
 * the exact reading beneath the chart. Y stays in percentage points of the allowance; nothing here is
 * a token count.
 */
const W = 360, H = 190, LEFT = 34, RIGHT = 34, TOP = 18, BOTTOM = 34;
const MAX_COMPLETED = 8;

export function AllowanceBurnChart({ pace, cycles, history, timezone, className }: { pace: Outlook | null; cycles: QuotaCycle<LiveQuota>[]; history: LiveQuota[]; timezone: string; className?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const detailId = useId();
  // The emphasized cycle holds the current reading; every other cycle in range, completed or newer history-only, is faint.
  const current = (pace ? cycles.find(c => c.samples.some(s => !s.history_only && s.observed_at === pace.observed_at)) : null) ?? cycles.at(-1) ?? null;
  const others = cycles.filter(c => c !== current).slice(-MAX_COMPLETED);
  const forecasting = !!pace && !pace.stale;
  const hoursLeft = pace ? (Date.parse(pace.resets_at) - Date.parse(pace.observed_at)) / 3_600_000 : 0;
  const historicalHigh = !forecasting || pace.historicalHighPointsPerHour === null ? null : pace.used_percent + pace.historicalHighPointsPerHour * hoursLeft;
  const historicalLow = !forecasting || pace.historicalLowPointsPerHour === null ? null : pace.used_percent + pace.historicalLowPointsPerHour * hoursLeft;
  const ceiling = Math.ceil(Math.max(100, pace?.projectedUsedPercent ?? 0, historicalHigh ?? 0) / 25) * 25;
  const x = (fraction: number) => LEFT + Math.max(0, Math.min(1, fraction)) * (W - LEFT - RIGHT);
  const y = (used: number) => TOP + (1 - Math.max(0, Math.min(ceiling, used)) / ceiling) * (H - TOP - BOTTOM);
  const phase = (cycle: QuotaCycle<LiveQuota>, at: string) => (Date.parse(at) - Date.parse(cycle.windowStartedAt)) / (cycle.windowMinutes * 60_000);
  const line = (cycle: QuotaCycle<LiveQuota>) => cycle.samples.map(s => `${x(phase(cycle, s.observed_at)).toFixed(1)},${y(s.used_percent).toFixed(1)}`).join(' ');
  const readings = current?.samples ?? [];
  const selected = active !== null ? readings[active] : null;
  const observedX = pace && current ? x(phase(current, pace.observed_at)) : null;
  const label = pace
    ? `${pace.used_percent.toFixed(1)}% used at the last reading${pace.projectedUsedPercent === null ? ', forecast unavailable' : `, projected ${pace.projectedUsedPercent.toFixed(1)}% by reset`}; ${others.length} other ${others.length === 1 ? 'cycle' : 'cycles'} shown faint`
    : `${readings.length} readings in the last cycle; no current reading`;

  return (
    <div data-slot="allowance-burn-chart" className={cn('grid gap-2', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="group" className="w-full" aria-label={label} aria-describedby={detailId}>
        {[0, 50, 100].map(value => (
          <g key={value}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(value)} y2={y(value)} stroke={value === 100 ? 'var(--muted-foreground)' : 'var(--border)'} strokeDasharray={value === 100 ? '4 3' : undefined} />
            <text x={LEFT - 6} y={y(value) + 4} textAnchor="end" fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{value}%</text>
          </g>
        ))}
        {ceiling > 100 ? <text x={W - RIGHT} y={TOP - 6} textAnchor="end" fill="var(--warning)" fontSize="10" fontFamily="var(--font-mono)">{ceiling}% demand</text> : null}
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(100)} stroke="var(--border)" strokeDasharray="2 4" />
        <line x1={x(1)} x2={x(1)} y1={TOP} y2={H - BOTTOM} stroke="var(--muted-foreground)" strokeWidth="1" />
        <text x={x(1) + 4} y={H - BOTTOM - 4} fill="var(--muted-foreground)" fontSize="9" fontFamily="var(--font-mono)">reset</text>
        {others.map(cycle => <polyline key={cycle.key} points={line(cycle)} fill="none" stroke="var(--primary)" strokeWidth="1" opacity="0.28" strokeLinejoin="round"><title>{`${cycle.completed ? 'Completed' : 'Open'} cycle, reset ${whenIn(cycle.resetAt, timezone)}: ${cycle.usedPoints.toFixed(1)} points over ${cycle.measuredHours.toFixed(1)}h`}</title></polyline>)}
        {pace && observedX !== null && historicalLow !== null && historicalHigh !== null ? (
          <polygon points={`${observedX},${y(pace.used_percent)} ${x(1)},${y(historicalLow)} ${x(1)},${y(historicalHigh)}`} fill="var(--primary)" opacity="0.1" />
        ) : null}
        {forecasting && observedX !== null && pace.historicalPointsPerHour !== null ? (
          <line x1={observedX} y1={y(pace.used_percent)} x2={x(1)} y2={y(pace.used_percent + pace.historicalPointsPerHour * hoursLeft)} stroke="var(--primary)" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.65" />
        ) : null}
        {current ? <polyline points={line(current)} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" /> : null}
        {pace && observedX !== null && pace.projectedUsedPercent !== null ? (
          <>
            <line x1={observedX} y1={y(pace.used_percent)} x2={x(1)} y2={y(pace.projectedUsedPercent)} stroke="var(--warning)" strokeWidth="2" strokeDasharray="4 3" />
            <circle cx={x(1)} cy={y(pace.projectedUsedPercent)} r="3.5" fill="var(--warning)" />
          </>
        ) : null}
        {pace && observedX !== null ? <line x1={observedX} x2={observedX} y1={TOP} y2={H - BOTTOM} stroke="var(--warning)" strokeDasharray="1 3" opacity="0.7" /> : null}
        {current ? readings.map((reading, index) => (
          <circle key={reading.id} cx={x(phase(current, reading.observed_at))} cy={y(reading.used_percent)} r={active === index ? 5 : 3.5} tabIndex={0} role="button"
            aria-label={`${whenIn(reading.observed_at, timezone)}: ${reading.used_percent.toFixed(1)}% used${reading.reader ? ` via ${reading.reader}` : ''}${reading.history_only ? ', history only' : ''}`}
            fill={reading.history_only ? 'var(--muted-foreground)' : 'var(--primary)'} stroke="var(--card)" strokeWidth="1"
            className="cursor-pointer outline-none focus-visible:stroke-[var(--ring)] focus-visible:stroke-2"
            onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(v => (v === index ? null : v))} onClick={() => setActive(v => (v === index ? null : index))} onMouseLeave={() => setActive(v => (v === index ? null : v))} />
        )) : null}
      </svg>
      <div className="text-muted-foreground flex justify-between font-mono text-[10px]">
        <span>{current ? `Cycle start · ${whenIn(current.windowStartedAt, timezone)}` : 'Cycle start'}</span>
        <span>{current ? `Reset · ${whenIn(current.resetAt, timezone)}` : 'Reset'}</span>
      </div>
      <div id={detailId} role="status" aria-live="polite" className="text-muted-foreground min-h-[1.25rem] font-mono text-[11px]">
        {selected ? (
          <><span className="text-foreground">{whenIn(selected.observed_at, timezone)}</span> · {selected.used_percent.toFixed(1)}% used{selected.reader ? ` · via ${selected.reader}` : ''}{selected.basis && selected.basis !== 'reported' ? ` · ${selected.basis}` : ''}{selected.history_only ? ' · history only (source disabled)' : ''}</>
        ) : (
          <>{readings.length} readings in this cycle · {others.length} other {others.length === 1 ? 'cycle' : 'cycles'} shown faint · hover or tab through the readings for exact values</>
        )}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-4 font-mono text-[10px]">
        <span className="flex items-center gap-1.5"><i className="bg-primary block h-0.5 w-3" />Recorded</span>
        <span className="flex items-center gap-1.5"><i className="bg-primary/30 block h-0.5 w-3" />Other cycles</span>
        {forecasting && pace.historicalPointsPerHour !== null ? <span className="flex items-center gap-1.5"><i className="border-primary block h-0 w-3 border-t border-dashed" />Recent cycles seed</span> : null}
        <span className="flex items-center gap-1.5"><i className="bg-warning block h-0.5 w-3" />Projected</span>
        <span className="flex items-center gap-1.5"><i className="bg-border block h-0.5 w-3" />Even pace</span>
      </div>
    </div>
  );
}
