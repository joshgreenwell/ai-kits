import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { countdown, when } from '@/components/telemetry-shared';
import { Stat, StatGroup } from '@/components/kit';
import { quotaOutlook } from '@/lib/telemetry-contract';
import { cn } from 'cn';

type Pace = NonNullable<ReturnType<typeof quotaOutlook>>;

const sourceLabel: Record<Pace['forecastSource'], string> = {
  historical: 'historical seed',
  blended: 'blended forecast',
  current_window: 'current pace',
  stale: 'stale reading',
  unavailable: 'learning pace',
};

/**
 * Recorded usage against the even-pace guide, with the projection continuing
 * past the last reading. Kept as a drawn chart rather than a bar strip because
 * the question is a trajectory - will this line cross 100% before the reset.
 */
function BurnChart({ pace: p }: { pace: Pace }) {
  const reset = Date.parse(p.resets_at);
  const start = reset - p.window_minutes * 60_000;
  const hoursLeft = (reset - Date.parse(p.observed_at)) / 3_600_000;
  const historicalProjection = p.historicalPointsPerHour === null ? null : p.used_percent + p.historicalPointsPerHour * hoursLeft;
  const historicalLow = p.historicalLowPointsPerHour === null ? null : p.used_percent + p.historicalLowPointsPerHour * hoursLeft;
  const historicalHigh = p.historicalHighPointsPerHour === null ? null : p.used_percent + p.historicalHighPointsPerHour * hoursLeft;
  const chartMax = Math.max(100, p.projectedUsedPercent ?? 0, historicalHigh ?? 0);
  const ceiling = Math.ceil(chartMax / 25) * 25;
  const x = (at: string) => 34 + Math.max(0, Math.min(1, (Date.parse(at) - start) / (reset - start))) * 292;
  const y = (used: number) => 154 - (used / ceiling) * 130;
  const points = p.history.map(row => `${x(row.observed_at)},${y(row.used_percent)}`).join(' ');

  return (
    <div className="grid gap-2">
      <svg
        viewBox="0 0 360 180"
        role="img"
        className="w-full"
        aria-label={`Allowance history: ${p.used_percent.toFixed(1)}% recorded${p.projectedUsedPercent === null ? ', forecast unavailable' : `, projected ${p.projectedUsedPercent.toFixed(1)}% by reset`}. Full allowance is 100%.`}
      >
        {[0, 50, 100].map(value => (
          <g key={value}>
            <line
              x1="34" x2="326" y1={y(value)} y2={y(value)}
              stroke={value === 100 ? 'var(--muted-foreground)' : 'var(--border)'}
              strokeDasharray={value === 100 ? '4 3' : undefined}
            />
            <text x="26" y={y(value) + 4} textAnchor="end" fill="var(--muted-foreground)" fontSize="10" fontFamily="var(--font-mono)">{value}%</text>
          </g>
        ))}
        {ceiling > 100 && (
          <text x="326" y="14" textAnchor="end" fill="var(--warning)" fontSize="10" fontFamily="var(--font-mono)">{ceiling}% demand</text>
        )}
        <line x1="34" y1={y(0)} x2="326" y2={y(100)} stroke="var(--border)" strokeDasharray="2 4" />
        {historicalLow !== null && historicalHigh !== null && (
          <polygon
            points={`${x(p.observed_at)},${y(p.used_percent)} 326,${y(historicalLow)} 326,${y(historicalHigh)}`}
            fill="var(--primary)"
            opacity="0.1"
          />
        )}
        {historicalProjection !== null && (
          <line
            x1={x(p.observed_at)} y1={y(p.used_percent)} x2="326" y2={y(historicalProjection)}
            stroke="var(--primary)" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.65"
          />
        )}
        <polyline points={points} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />
        {p.projectedUsedPercent !== null && (
          <line
            x1={x(p.observed_at)} y1={y(p.used_percent)} x2="326" y2={y(p.projectedUsedPercent)}
            stroke="var(--warning)" strokeWidth="2" strokeDasharray="4 3"
          />
        )}
        <circle cx={x(p.observed_at)} cy={y(p.used_percent)} r="3.5" fill="var(--primary)" />
        {p.projectedUsedPercent !== null && (
          <circle cx="326" cy={y(p.projectedUsedPercent)} r="3.5" fill="var(--warning)" />
        )}
      </svg>
      <div className="text-muted-foreground flex justify-between font-mono text-[10px]">
        <span>Cycle start</span>
        <span>Reset · {when(p.resets_at)}</span>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-4 font-mono text-[10px]">
        <span className="flex items-center gap-1.5"><i className="bg-primary block h-0.5 w-3" />Recorded</span>
        {historicalProjection !== null && <span className="flex items-center gap-1.5"><i className="border-primary block h-0 w-3 border-t border-dashed" />Recent cycles</span>}
        <span className="flex items-center gap-1.5"><i className="bg-warning block h-0.5 w-3" />Projected</span>
        <span className="flex items-center gap-1.5"><i className="bg-border block h-0.5 w-3" />Even pace</span>
      </div>
    </div>
  );
}

export function AllowanceCard({ account, pace: p, now }: { account: { label: string; provider: string }; pace: Pace; now: number }) {
  const projected = p.projectedUsedPercent;
  const over = projected !== null && projected > 100;
  const hourly = p.window_minutes < 1440;
  const rateUnit = hourly ? 'hour' : 'day';

  const verdict =
    projected === null
      ? p.stale
        ? 'A fresh allowance reading is needed to resume the forecast.'
        : 'At least 30 minutes of readings in this reset window are needed.'
      : p.remaining === 0
        ? 'This allowance is fully used. Waiting for the next reset.'
        : over
          ? `Allowance runs out ${when(p.exhaustionAt)} at this forecast pace.`
          : 'Your allowance lasts through this reset at the forecast pace.';

  return (
    <Card className={cn('gap-4 overflow-hidden py-0', over && 'border-destructive/45')}>
      <CardHeader className="p-4">
        <CardDescription>{account.label} · {p.completedCycles} completed {p.completedCycles === 1 ? 'cycle' : 'cycles'} in view</CardDescription>
        <CardTitle className="text-base">{p.label}</CardTitle>
        <CardAction>
          <Badge variant={p.stale ? 'soft-warning' : p.forecastSource === 'historical' ? 'soft-info' : 'soft'}>
            {sourceLabel[p.forecastSource]}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-4 px-4">
        <div>
          <p className="font-mono text-3xl leading-none font-medium tracking-tight tabular-nums">
            {p.remaining.toFixed(1)}
            <span className="text-muted-foreground text-sm font-normal">% remaining</span>
          </p>
          <div
            role="meter"
            aria-label={`${account.label} ${p.label} usage`}
            aria-valuenow={p.used_percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="bg-muted border-border relative mt-3 h-2 overflow-hidden rounded-sm border"
          >
            <span
              className={cn('absolute inset-y-0 left-0', over ? 'bg-destructive' : 'bg-primary')}
              style={{ width: `${Math.min(100, p.used_percent)}%` }}
            />
          </div>
          <div className="text-muted-foreground mt-2 flex justify-between font-mono text-[11px]">
            <span>{p.used_percent.toFixed(1)}% used</span>
            <span>{Date.parse(p.resets_at) <= now ? 'Awaiting new window' : `Resets in ${countdown(p.resets_at, now)}`}</span>
          </div>
        </div>

        <BurnChart pace={p} />
      </CardContent>

      <StatGroup className="border-border border-t">
        <Stat
          label="Projected by reset"
          value={projected === null ? '—' : `${projected.toFixed(1)}%`}
          tone={over ? 'destructive' : 'default'}
          caption={
            projected === null
              ? p.stale ? 'Refresh needed' : 'Learning your pace'
              : p.remaining === 0
                ? 'Allowance fully used'
                : over
                  ? `${(projected - 100).toFixed(1)} pts over`
                  : `${(100 - projected).toFixed(1)}% left at reset`
          }
        />
        <Stat
          label={`Forecast burn / ${rateUnit}`}
          value={p.pointsPerHour === null ? '—' : `${(p.pointsPerHour * (hourly ? 1 : 24)).toFixed(1)}`}
          caption={
            p.forecastSource === 'historical'
              ? `${p.comparableCycles} prior ${p.comparableCycles === 1 ? 'cycle' : 'cycles'} · pts`
              : p.forecastSource === 'blended'
                ? `${Math.round(p.liveWeight * 100)}% current evidence · pts`
                : p.forecastSource === 'current_window'
                  ? 'measured this window · pts'
                  : 'waiting for usable evidence'
          }
        />
        <Stat
          label={`Available pace / ${rateUnit}`}
          value={p.sustainablePointsPerDay === null ? '—' : `${(p.sustainablePointsPerDay / (hourly ? 24 : 1)).toFixed(1)}`}
          caption="pts"
        />
      </StatGroup>

      <div className="border-border border-t px-4 py-3">
        <p className={cn('text-sm', over ? 'text-destructive' : 'text-muted-foreground')}>{verdict}</p>
        <details className="mt-2">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[11px]">
            How this projection works
          </summary>
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
            {p.samples} readings over {p.measuredHours.toFixed(1)}h, ending {when(p.observed_at)}.
            {' '}{p.forecastSource === 'historical'
              ? `The forecast is seeded by the recent median from ${p.comparableCycles} completed ${p.comparableCycles === 1 ? 'cycle' : 'cycles'} until this window has enough evidence.`
              : p.forecastSource === 'blended'
                ? `Current-window pace is blended with ${p.comparableCycles} completed ${p.comparableCycles === 1 ? 'cycle' : 'cycles'}; current evidence now has ${Math.round(p.liveWeight * 100)}% weight.`
                : p.forecastSource === 'current_window'
                  ? 'The forecast uses continuous history from this window.'
                  : p.forecastSource === 'stale'
                    ? 'The latest reading is stale, so the active projection is paused.'
                    : 'No comparable completed cycle or usable live segment is available yet.'}
            {' '}Resets, decreases and gaps over 3h restart live history. Above 100% shows demand
            beyond the allowance. The dotted diagonal guide spreads 100% evenly across the cycle.
          </p>
        </details>
      </div>
    </Card>
  );
}
