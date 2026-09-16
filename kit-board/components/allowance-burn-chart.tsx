'use client';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts';
import { cn } from 'cn';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import type { QuotaCycle } from '@/lib/telemetry-contract';
import type { LiveQuota, Outlook } from '@/lib/allowance-view';
import { whenIn } from '@/lib/usage-view';

/**
 * One window's burn history (USG-023) on the vendored shadcn/Recharts primitive. The X axis is
 * normalized cycle time, 0% at the window's start and 100% at its reset, so completed cycles sit under
 * the active one for comparison: completed cycles are faint, the active cycle is emphasized, the
 * projection continues from the last reading to the reset in a distinct stroke, the even-pace guide is
 * the dotted diagonal, and the reset is a marked edge. Hover, tap, or arrow through the chart and the
 * exact reading appears in the chart's own tooltip rather than in a readout below it. Y stays in
 * percentage points of the allowance; nothing here is a token count.
 *
 * Recharts measures its container before it draws anything, so every figure is mirrored into the DOM
 * as well - that mirror is what assistive tech and the tests read.
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
type Row = {
  phase: number;
  at: string | null;
  reading: LiveQuota | null;
  current: number | null;
  past: (number | null)[];
  even: number | null;
  seed: number | null;
  projected: number | null;
  band: [number, number] | null;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const dayOf = (value: string, timezone: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(Date.parse(value));

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
  // The emphasized cycle holds the current reading; every other cycle in range, completed or newer history-only, is faint.
  const current = (pace ? cycles.find(c => c.samples.some(s => !s.history_only && s.observed_at === pace.observed_at)) : null) ?? cycles.at(-1) ?? null;
  const others = cycles.filter(c => c !== current).slice(-MAX_COMPLETED);
  const forecasting = !!pace && !pace.stale;
  const hoursLeft = pace ? (Date.parse(pace.resets_at) - Date.parse(pace.observed_at)) / 3_600_000 : 0;
  const historicalHigh = !forecasting || pace.historicalHighPointsPerHour === null ? null : pace.used_percent + pace.historicalHighPointsPerHour * hoursLeft;
  const historicalLow = !forecasting || pace.historicalLowPointsPerHour === null ? null : pace.used_percent + pace.historicalLowPointsPerHour * hoursLeft;
  const seedEnd = forecasting && pace.historicalPointsPerHour !== null ? pace.used_percent + pace.historicalPointsPerHour * hoursLeft : null;
  const ceiling = Math.ceil(Math.max(100, pace?.projectedUsedPercent ?? 0, historicalHigh ?? 0) / 25) * 25;
  const yTicks = [...new Set([0, 50, 100, ceiling])].sort((a, b) => a - b);

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
  at(0).even = 0;
  at(1).even = 100;
  others.forEach((cycle, index) => { for (const sample of cycle.samples) at(phase(cycle, sample.observed_at)).past[index] = sample.used_percent; });
  if (current) for (const sample of current.samples) { const row = at(phase(current, sample.observed_at)); row.current = sample.used_percent; row.reading = sample; row.at = sample.observed_at; }
  const observedPhase = pace && current ? phase(current, pace.observed_at) : null;
  if (pace && observedPhase !== null) {
    const start = at(observedPhase), end = at(1);
    if (pace.projectedUsedPercent !== null) { start.projected = pace.used_percent; end.projected = pace.projectedUsedPercent; }
    if (seedEnd !== null) { start.seed = pace.used_percent; end.seed = seedEnd; }
    if (historicalLow !== null && historicalHigh !== null) { start.band = [pace.used_percent, pace.used_percent]; end.band = [historicalLow, historicalHigh]; }
  }
  const data = [...rows.values()].sort((a, b) => a.phase - b.phase);

  const readings = current?.samples ?? [];
  const longWindow = (current?.windowMinutes ?? 0) >= 1440;
  const axisTime = (fraction: number) => {
    const instant = instantAt(fraction);
    if (!instant) return '';
    return new Intl.DateTimeFormat('en-US', longWindow ? { timeZone: timezone, month: 'short', day: 'numeric' } : { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(Date.parse(instant));
  };
  const label = pace
    ? `${pace.used_percent.toFixed(1)}% used at the last reading${pace.projectedUsedPercent === null ? ', forecast unavailable' : `, projected ${pace.projectedUsedPercent.toFixed(1)}% by reset`}; ${others.length} other ${others.length === 1 ? 'cycle' : 'cycles'} shown faint`
    : `${readings.length} readings in the last cycle; no current reading`;

  return (
    <div data-slot="allowance-burn-chart" role="group" aria-label={label} className={cn('grid gap-1', className)}>
      <ChartContainer config={config} className="aspect-auto h-[200px] w-full">
        <ComposedChart data={data} margin={{ left: 4, right: 14, top: 12, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis type="number" dataKey="phase" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={axisTime} tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
          <YAxis type="number" domain={[0, ceiling]} ticks={yTicks} tickFormatter={value => `${value}%`} tickLine={false} axisLine={false} width={40} tickMargin={4} />
          {/* The allowance itself, and the reset it is spent against: both are boundaries, not series. */}
          <ReferenceLine y={100} stroke="var(--muted-foreground)" strokeDasharray="4 3" />
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
          {pace && pace.projectedUsedPercent !== null && observedPhase !== null ? <ReferenceDot x={1} y={pace.projectedUsedPercent} r={3.5} fill="var(--warning)" stroke="none" /> : null}
        </ComposedChart>
      </ChartContainer>

      <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 pt-1 text-xs">
        <Key label="Recorded" color="var(--primary)" style="solid" />
        {others.length ? <Key label={`Other cycles (${others.length})`} color="var(--primary)" style="faint" /> : null}
        {seedEnd !== null ? <Key label="Recent cycles seed" color="var(--primary)" style="dashed" /> : null}
        {pace?.projectedUsedPercent !== null && pace !== null ? <Key label="Projected" color="var(--warning)" style="dashed" /> : null}
        <Key label="Even pace" color="var(--border)" style="dotted" />
      </div>

      {/* The same readings the tooltip gives, available before the chart has been measured. */}
      <div className="sr-only">
        <span>{current ? `Cycle start ${whenIn(current.windowStartedAt, timezone)}, reset ${whenIn(current.resetAt, timezone)}.` : 'No cycle recorded.'}</span>
        {readings.map(reading => (
          <span key={reading.id} role="img" aria-label={`${whenIn(reading.observed_at, timezone)}: ${reading.used_percent.toFixed(1)}% used${reading.reader ? ` via ${reading.reader}` : ''}${reading.history_only ? ', history only' : ''}`} />
        ))}
        {others.map(cycle => (
          <span key={cycle.key}>{`${cycle.completed ? 'Completed' : 'Open'} cycle, reset ${whenIn(cycle.resetAt, timezone)}: ${cycle.usedPoints.toFixed(1)} points over ${cycle.measuredHours.toFixed(1)}h`}</span>
        ))}
        {historicalLow !== null && historicalHigh !== null ? <span>{`Recent cycles spread ${historicalLow.toFixed(1)}% to ${historicalHigh.toFixed(1)}% by reset.`}</span> : null}
        <span>{`${history.length} readings in range. Above 100% is demand beyond the allowance.`}</span>
      </div>
    </div>
  );
}

function BurnTooltip({ active, payload, timezone, others }: { active?: boolean; payload?: { payload: Row }[]; timezone: string; others: QuotaCycle<LiveQuota>[] }) {
  const row = active ? payload?.[0]?.payload : null;
  if (!row) return null;
  const reading = row.reading;
  return (
    <div className="border-border/50 bg-background grid min-w-[10rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{whenIn(reading?.observed_at ?? row.at, timezone)}</div>
      <div className="grid gap-1">
        {reading ? <TipLine label="Used" value={`${reading.used_percent.toFixed(1)}%`} accent /> : null}
        {reading?.reader ? <TipLine label="Reader" value={reading.reader} /> : null}
        {reading?.basis && reading.basis !== 'reported' ? <TipLine label="Basis" value={reading.basis} /> : null}
        {row.projected !== null && !reading ? <TipLine label="Projected" value={`${row.projected.toFixed(1)}%`} accent /> : null}
        {row.seed !== null && !reading ? <TipLine label="Recent cycles" value={`${row.seed.toFixed(1)}%`} /> : null}
        {row.band && !reading && row.band[0] !== row.band[1] ? <TipLine label="Spread" value={`${row.band[0].toFixed(1)}–${row.band[1].toFixed(1)}%`} /> : null}
        {row.even !== null && !reading ? <TipLine label="Even pace" value={`${row.even.toFixed(0)}%`} /> : null}
        {row.past.map((value, index) => (value === null ? null : <TipLine key={others[index].key} label={`Cycle to ${dayOf(others[index].resetAt, timezone)}`} value={`${value.toFixed(1)}%`} />))}
      </div>
      {reading?.history_only ? <p className="text-muted-foreground border-border/50 border-t pt-1">History only: the source is disabled, so this reading is never current.</p> : null}
    </div>
  );
}
