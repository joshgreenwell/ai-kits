'use client';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts';
import { cn } from 'cn';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import type { QuotaCycle } from '@/lib/telemetry-contract';
import { projectedRemaining, sampleRemaining, type LiveQuota, type Outlook } from '@/lib/allowance-view';
import { whenIn } from '@/lib/usage-view';

/**
 * One window's burn history (USG-023) on the vendored shadcn/Recharts primitive. The X axis is
 * normalized cycle time, 0% at the window's start and 100% at its reset, so completed cycles sit under
 * the active one for comparison: completed cycles are faint, the active cycle is emphasized, the
 * projection continues from the last reading to the reset in a distinct stroke, and the reset is a
 * marked edge. Hover, tap, or arrow through the chart and the exact reading appears in the chart's own
 * tooltip rather than in a readout below it.
 *
 * Y is REMAINING allowance in percentage points, the same gauge as the summary bar: a window opens
 * full at 100% and every line descends toward its reset, so the even-pace guide is the descending
 * diagonal from 100% at phase 0 to 0% at phase 1 and the dashed boundary is the empty allowance at
 * y=0. Demand beyond the allowance falls BELOW that floor, which is why the axis grows downward in
 * 25-point steps where it once grew upward past 100. Nothing here is a token count, and the rates and
 * cycle totals the mirror reports stay consumption - only levels flip.
 *
 * Recharts measures its container before it draws anything, so nothing plotted is observable in the
 * markup: every figure is mirrored into the DOM below the chart for assistive tech, and every series
 * is derived by `burnSeries` so the direction the lines actually run is testable on its own.
 */
const MAX_COMPLETED = 8;

const config = {
  current: { label: 'Recorded', color: 'var(--primary)' },
  projected: { label: 'Projected', color: 'var(--warning)' },
  seed: { label: 'Recent cycles seed', color: 'var(--primary)' },
  even: { label: 'Even pace', color: 'var(--border)' },
} satisfies ChartConfig;

/**
 * One phase of the cycle. A series holds a value only at the phases it actually recorded, and every
 * line connects across the nulls, so a cycle keeps the exact shape its readings describe instead of
 * being resampled onto a shared grid.
 */
export type Row = {
  phase: number;
  at: string | null;
  reading: LiveQuota | null;
  current: number | null;
  past: (number | null)[];
  even: number | null;
  seed: number | null;
  projected: number | null;
  /** Recharts reads a range Area as [lower, upper], so index 0 is the least remaining: the fastest burn. */
  band: [number, number] | null;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const dayOf = (value: string, timezone: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(Date.parse(value));

/**
 * Every plotted value, and the axis it is plotted against, derived without a DOM. Recharts draws
 * nothing until it has measured a container, so this is the only place the direction of the lines can
 * be read back - by the chart, and by a test. Nothing here depends on the display zone.
 */
export function burnSeries({ pace, cycles }: { pace: Outlook | null; cycles: QuotaCycle<LiveQuota>[] }) {
  // The emphasized cycle holds the current reading; every other cycle in range, completed or newer history-only, is faint.
  const current = (pace ? cycles.find(c => c.samples.some(s => !s.history_only && s.observed_at === pace.observed_at)) : null) ?? cycles.at(-1) ?? null;
  const others = cycles.filter(c => c !== current).slice(-MAX_COMPLETED);
  const forecasting = !!pace && !pace.stale;
  const hoursLeft = pace ? (Date.parse(pace.resets_at) - Date.parse(pace.observed_at)) / 3_600_000 : 0;
  // What is left at the reset if a given burn rate holds. The endpoints swap when the chart reads
  // remaining: the HIGHEST burn rate is the LOWEST remaining, so it is the band's floor, not its ceiling.
  const remainingAt = (pointsPerHour: number) => (pace ? pace.remaining - pointsPerHour * hoursLeft : 0);
  const remainingFloor = !forecasting || pace.historicalHighPointsPerHour === null ? null : remainingAt(pace.historicalHighPointsPerHour);
  const remainingCeil = !forecasting || pace.historicalLowPointsPerHour === null ? null : remainingAt(pace.historicalLowPointsPerHour);
  const seedEndRemaining = forecasting && pace.historicalPointsPerHour !== null ? remainingAt(pace.historicalPointsPerHour) : null;
  const projectedLeft = projectedRemaining(pace);
  // The old ceiling measured how far demand rose above the allowance; the same overrun now sinks below
  // the empty floor, in the same 25-point steps. Nulls are filtered rather than defaulted to 0: in a
  // Math.min, 0 is no longer the neutral element and would pin the floor there, clipping the overrun.
  const lows = [0, ...(projectedLeft === null ? [] : [projectedLeft]), ...(remainingFloor === null ? [] : [remainingFloor])];
  const axisFloor = Math.floor(Math.min(...lows) / 25) * 25;
  const yTicks = [...new Set([axisFloor, 0, 50, 100])].sort((a, b) => a - b);

  const phase = (cycle: QuotaCycle<LiveQuota>, at: string) => clamp01((Date.parse(at) - Date.parse(cycle.windowStartedAt)) / (cycle.windowMinutes * 60_000));
  const instantAt = (fraction: number) => (current ? new Date(Date.parse(current.windowStartedAt) + fraction * current.windowMinutes * 60_000).toISOString() : null);

  const rows = new Map<number, Row>();
  const at = (fraction: number) => {
    let row = rows.get(fraction);
    if (!row) {
      row = { phase: fraction, at: instantAt(fraction), reading: null, current: null, past: others.map(() => null), even: null, seed: null, projected: null, band: null };
      rows.set(fraction, row);
    }
    return row;
  };
  // Every Y value is remaining: a full window at phase 0 descending to its reset. `row.reading` keeps
  // the raw sample, so the tooltip and the mirror convert where they display rather than storing a copy.
  at(0).even = 100;
  at(1).even = 0;
  others.forEach((cycle, index) => { for (const sample of cycle.samples) at(phase(cycle, sample.observed_at)).past[index] = sampleRemaining(sample.used_percent); });
  if (current) for (const sample of current.samples) { const row = at(phase(current, sample.observed_at)); row.current = sampleRemaining(sample.used_percent); row.reading = sample; row.at = sample.observed_at; }
  const observedPhase = pace && current ? phase(current, pace.observed_at) : null;
  if (pace && observedPhase !== null) {
    // `pace.remaining` is the recorded line's own last point, so the continuations leave it without a step.
    const start = at(observedPhase), end = at(1);
    if (projectedLeft !== null) { start.projected = pace.remaining; end.projected = projectedLeft; }
    if (seedEndRemaining !== null) { start.seed = pace.remaining; end.seed = seedEndRemaining; }
    if (remainingFloor !== null && remainingCeil !== null) { start.band = [pace.remaining, pace.remaining]; end.band = [remainingFloor, remainingCeil]; }
  }
  const rowsByPhase = [...rows.values()].sort((a, b) => a.phase - b.phase);

  const projectedLabel = projectedLeft === null ? ', forecast unavailable'
    : projectedLeft >= 0 ? `, projected ${projectedLeft.toFixed(1)}% left by reset`
      : `, projected ${Math.abs(projectedLeft).toFixed(1)}% beyond the allowance by reset`;
  const label = pace
    ? `${pace.remaining.toFixed(1)}% left at the last reading${projectedLabel}; ${others.length} other ${others.length === 1 ? 'cycle' : 'cycles'} shown faint`
    : `${current?.samples.length ?? 0} readings in the last cycle; no current reading`;

  return { rows: rowsByPhase, current, others, axisFloor, yTicks, projectedLeft, observedPhase, seedEndRemaining, remainingFloor, remainingCeil, label };
}

function TipLine({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-mono tabular-nums', accent && 'text-foreground font-medium')}>{value}</span>
    </div>
  );
}

function Key({ label, color, style }: { label: string; color: string; style: 'solid' | 'faint' | 'dashed' | 'dotted' }) {
  return (
    <span className="flex items-center gap-1.5">
      <i aria-hidden className={cn('block h-0 w-3 shrink-0 border-t-2', style === 'faint' && 'opacity-30', style === 'dashed' && 'border-dashed', style === 'dotted' && 'border-dotted')} style={{ borderColor: color }} />
      {label}
    </span>
  );
}

export function AllowanceBurnChart({ pace, cycles, history, timezone, className }: { pace: Outlook | null; cycles: QuotaCycle<LiveQuota>[]; history: LiveQuota[]; timezone: string; className?: string }) {
  const { rows: data, current, others, axisFloor, yTicks, projectedLeft, observedPhase, seedEndRemaining, remainingFloor, remainingCeil, label } = burnSeries({ pace, cycles });

  const readings = current?.samples ?? [];
  const longWindow = (current?.windowMinutes ?? 0) >= 1440;
  const instantAt = (fraction: number) => (current ? new Date(Date.parse(current.windowStartedAt) + fraction * current.windowMinutes * 60_000).toISOString() : null);
  const axisTime = (fraction: number) => {
    const instant = instantAt(fraction);
    if (!instant) return '';
    return new Intl.DateTimeFormat('en-US', longWindow ? { timeZone: timezone, month: 'short', day: 'numeric' } : { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(Date.parse(instant));
  };

  return (
    <div data-slot="allowance-burn-chart" role="group" aria-label={label} className={cn('grid gap-1', className)}>
      {/* Hidden from assistive tech on purpose: the SVG's tick and label text would otherwise be read
          inside this group, between its summary and the mirror below, as dozens of loose percentages
          with no referent. Nothing in it is focusable - the chart is drawn without accessibilityLayer -
          and the mirror carries every figure, so hiding it costs nothing and removes the duplicate. */}
      <ChartContainer config={config} aria-hidden className="aspect-auto h-[200px] w-full">
        <ComposedChart data={data} margin={{ left: 4, right: 14, top: 12, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis type="number" dataKey="phase" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={axisTime} tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
          {/* A bare "-150%" would be a new and unexplained reading, so the negative side names itself;
              the axis widens only when there is an overrun to name, and keeps its old width otherwise. */}
          <YAxis type="number" domain={[axisFloor, 100]} ticks={yTicks} tickFormatter={value => (value < 0 ? `${Math.abs(value)}% over` : `${value}%`)} tickLine={false} axisLine={false} width={axisFloor < 0 ? 62 : 40} tickMargin={4} />
          {/* The allowance itself, and the reset it is spent against: both are boundaries, not series. On a
              remaining scale the allowance boundary is the empty floor; anything below it is demand past it. */}
          <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="4 3" />
          <ReferenceLine x={1} stroke="var(--muted-foreground)" label={{ value: 'reset', position: 'insideTopRight', fill: 'var(--muted-foreground)', fontSize: 10 }} />
          {observedPhase !== null ? <ReferenceLine x={observedPhase} stroke="var(--warning)" strokeDasharray="1 3" strokeOpacity={0.7} /> : null}
          <ChartTooltip cursor={{ stroke: 'var(--border)' }} content={<BurnTooltip timezone={timezone} others={others} />} />
          <Area dataKey="band" type="natural" connectNulls isAnimationActive={false} stroke="none" fill="var(--primary)" fillOpacity={0.1} activeDot={false} />
          <Line dataKey="even" type="natural" connectNulls isAnimationActive={false} stroke="var(--border)" strokeWidth={1} strokeDasharray="2 4" dot={false} activeDot={false} />
          {others.map((cycle, index) => (
            <Line key={cycle.key} name={`Cycle to ${dayOf(cycle.resetAt, timezone)}`} dataKey={(row: Row) => row.past[index]} type="natural" connectNulls isAnimationActive={false}
              stroke="var(--primary)" strokeWidth={1} strokeOpacity={0.28} dot={false} activeDot={false} />
          ))}
          <Line dataKey="seed" type="natural" connectNulls isAnimationActive={false} stroke="var(--primary)" strokeWidth={1.5} strokeDasharray="2 3" strokeOpacity={0.65} dot={false} activeDot={false} />
          <Line dataKey="current" type="natural" connectNulls isAnimationActive={false} stroke="var(--primary)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }} />
          <Line dataKey="projected" type="natural" connectNulls isAnimationActive={false} stroke="var(--warning)" strokeWidth={2} strokeDasharray="4 3" dot={false} activeDot={false} />
          {projectedLeft !== null && observedPhase !== null ? <ReferenceDot x={1} y={projectedLeft} r={3.5} fill="var(--warning)" stroke="none" /> : null}
        </ComposedChart>
      </ChartContainer>

      <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 pt-1 text-xs">
        <Key label="Recorded" color="var(--primary)" style="solid" />
        {others.length ? <Key label={`Other cycles (${others.length})`} color="var(--primary)" style="faint" /> : null}
        {seedEndRemaining !== null ? <Key label="Recent cycles seed" color="var(--primary)" style="dashed" /> : null}
        {projectedLeft !== null ? <Key label="Projected" color="var(--warning)" style="dashed" /> : null}
        <Key label="Even pace" color="var(--border)" style="dotted" />
      </div>

      {/* The same readings the tooltip gives, available before the chart has been measured. The scale's
          direction comes first: a reading below zero has to be decodable when it is heard, not after. */}
      <div className="sr-only">
        <span>{`Every level is allowance left, from 100% at the cycle start down to its reset. Below 0% is demand beyond the allowance.`}</span>
        <span>{current ? `Cycle start ${whenIn(current.windowStartedAt, timezone)}, reset ${whenIn(current.resetAt, timezone)}.` : 'No cycle recorded.'}</span>
        {readings.map(reading => (
          <span key={reading.id} role="img" aria-label={`${whenIn(reading.observed_at, timezone)}: ${sampleRemaining(reading.used_percent).toFixed(1)}% left${reading.reader ? ` via ${reading.reader}` : ''}${reading.history_only ? ', history only' : ''}`} />
        ))}
        {/* Points consumed over an elapsed span is a total, not a level on the gauge, so it stays consumption. */}
        {others.map(cycle => (
          <span key={cycle.key}>{`${cycle.completed ? 'Completed' : 'Open'} cycle, reset ${whenIn(cycle.resetAt, timezone)}: ${cycle.usedPoints.toFixed(1)} points over ${cycle.measuredHours.toFixed(1)}h`}</span>
        ))}
        {/* Floor first: after the inversion the fastest burn is the least left, so this range reads ascending. */}
        {remainingFloor !== null && remainingCeil !== null ? <span>{`Recent cycles spread ${remainingFloor.toFixed(1)}% to ${remainingCeil.toFixed(1)}% left by reset.`}</span> : null}
        <span>{`${history.length} readings in range.`}</span>
      </div>
    </div>
  );
}

export function BurnTooltip({ active, payload, timezone, others }: { active?: boolean; payload?: { payload: Row }[]; timezone: string; others: QuotaCycle<LiveQuota>[] }) {
  const row = active ? payload?.[0]?.payload : null;
  if (!row) return null;
  const reading = row.reading;
  return (
    <div className="border-border/50 bg-background grid min-w-[10rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{whenIn(reading?.observed_at ?? row.at, timezone)}</div>
      {/* Every percentage here is remaining allowance and every row says so, because the rows a phase
          shows vary: a phase with only completed cycles on it has no "Left" row to be anchored by, and
          a bare "40.0%" there is exactly what the same row meant in the other direction yesterday. */}
      <div className="grid gap-1">
        {reading ? <TipLine label="Left" value={`${sampleRemaining(reading.used_percent).toFixed(1)}%`} accent /> : null}
        {reading?.reader ? <TipLine label="Reader" value={reading.reader} /> : null}
        {reading?.basis && reading.basis !== 'reported' ? <TipLine label="Basis" value={reading.basis} /> : null}
        {row.projected !== null && !reading ? <TipLine label="Projected left" value={`${row.projected.toFixed(1)}%`} accent /> : null}
        {row.seed !== null && !reading ? <TipLine label="Recent cycles" value={`${row.seed.toFixed(1)}% left`} /> : null}
        {row.band && !reading && row.band[0] !== row.band[1] ? <TipLine label="Spread left" value={`${row.band[0].toFixed(1)}–${row.band[1].toFixed(1)}%`} /> : null}
        {row.even !== null && !reading ? <TipLine label="Even pace left" value={`${row.even.toFixed(0)}%`} /> : null}
        {row.past.map((value, index) => (value === null ? null : <TipLine key={others[index].key} label={`Cycle to ${dayOf(others[index].resetAt, timezone)}`} value={`${value.toFixed(1)}% left`} />))}
      </div>
      {reading?.history_only ? <p className="text-muted-foreground border-border/50 border-t pt-1">History only: the source is disabled, so this reading is never current.</p> : null}
    </div>
  );
}
