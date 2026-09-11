import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { countdown, when } from '@/components/telemetry-shared';
import { quotaPace } from '@/lib/telemetry-contract';

type Pace = NonNullable<ReturnType<typeof quotaPace>>;

function BurnChart({ pace: p }: { pace: Pace }) {
  const reset = Date.parse(p.resets_at);
  const start = reset - p.window_minutes * 60_000;
  const ceiling = Math.max(100, Math.ceil((p.projectedUsedPercent ?? 100) / 25) * 25);
  const x = (at: string) => 34 + Math.max(0, Math.min(1, (Date.parse(at) - start) / (reset - start))) * 292;
  const y = (used: number) => 154 - used / ceiling * 130;
  const points = p.history.map(row => `${x(row.observed_at)},${y(row.used_percent)}`).join(' ');
  return <div className="allowance-chart">
    <svg viewBox="0 0 360 180" role="img" aria-label={`Allowance history: ${p.used_percent.toFixed(1)}% recorded${p.projectedUsedPercent === null ? ', forecast unavailable' : `, projected ${p.projectedUsedPercent.toFixed(1)}% by reset`}. Full allowance is 100%.`}>
      {[0, 50, 100].map(value => <g key={value}><line x1="34" x2="326" y1={y(value)} y2={y(value)} className={value === 100 ? 'allowance-limit' : 'allowance-grid'} /><text x="26" y={y(value) + 4} textAnchor="end">{value}%</text></g>)}
      {ceiling > 100 && <text x="326" y="14" textAnchor="end">{ceiling}% demand</text>}
      <line x1="34" y1={y(0)} x2="326" y2={y(100)} className="allowance-even-pace" />
      <polyline points={points} className="allowance-observed" />
      {p.projectedUsedPercent !== null && <line x1={x(p.observed_at)} y1={y(p.used_percent)} x2="326" y2={y(p.projectedUsedPercent)} className="allowance-projected" />}
      <circle cx={x(p.observed_at)} cy={y(p.used_percent)} r="4" className="allowance-dot" />
      {p.projectedUsedPercent !== null && <circle cx="326" cy={y(p.projectedUsedPercent)} r="4" className="allowance-endpoint" />}
    </svg>
    <div className="allowance-axis"><span>Cycle start</span><span>Reset · {when(p.resets_at)}</span></div>
    <div className="allowance-legend"><span><i className="legend-observed" />Recorded</span><span><i className="legend-projected" />Projected</span><span><i className="legend-even" />Even pace</span></div>
  </div>;
}

export function AllowanceCard({ account, pace: p, now }: { account: { label: string; provider: string }; pace: Pace; now: number }) {
  const projected = p.projectedUsedPercent;
  const over = projected !== null && projected > 100;
  const hourly = p.window_minutes < 1440;
  const rateUnit = hourly ? 'hour' : 'day';
  return <Card className={`allowance-card${over ? ' allowance-over' : ''}`}>
    <CardHeader><div className="telemetry-card-heading"><CardDescription>{account.label}</CardDescription><Badge variant="outline">{p.stale ? 'Stale reading' : 'Observed'}</Badge></div><CardTitle>{p.label}</CardTitle></CardHeader>
    <CardContent>
      <div className="telemetry-quota-number">{p.remaining.toFixed(1)}<small>% remaining</small></div>
      <div className="telemetry-progress" role="meter" aria-label={`${account.label} ${p.label} usage`} aria-valuenow={p.used_percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${p.used_percent}%` }} /></div>
      <div className="allowance-reading"><span>{p.used_percent.toFixed(1)}% used</span><span>{Date.parse(p.resets_at) <= now ? 'Awaiting new window' : `Resets in ${countdown(p.resets_at, now)}`}</span></div>
      <div className="allowance-outlook">
        <div><span className="allowance-eyebrow">Projected by reset</span><strong>{projected === null ? '—' : `${projected.toFixed(1)}%`}</strong></div>
        <span className={`allowance-status${over ? ' is-over' : ''}`}>{projected === null ? p.stale ? 'Refresh needed' : 'Learning your pace' : p.remaining === 0 ? 'Allowance fully used' : over ? `${(projected - 100).toFixed(1)} pts over allowance` : `${(100 - projected).toFixed(1)}% left at reset`}</span>
      </div>
      <BurnChart pace={p} />
      <div className="allowance-rates"><div><span>Your burn / {rateUnit}</span><strong>{p.pointsPerHour === null ? '—' : `${(p.pointsPerHour * (hourly ? 1 : 24)).toFixed(1)} pts`}</strong></div><div><span>Available pace / {rateUnit}</span><strong>{p.sustainablePointsPerDay === null ? '—' : `${(p.sustainablePointsPerDay / (hourly ? 24 : 1)).toFixed(1)} pts`}</strong></div></div>
      <p className="allowance-verdict">{projected === null ? p.stale ? 'A fresh allowance reading is needed to resume the forecast.' : 'At least 30 minutes of readings in this reset window are needed.' : p.remaining === 0 ? 'This allowance is fully used. Waiting for the next reset.' : over ? `Allowance runs out ${when(p.exhaustionAt)} at this pace.` : 'Your allowance lasts through this reset at the measured pace.'}</p>
      <details className="telemetry-details"><summary>How this projection works</summary><p className="telemetry-footnote">{p.samples} readings over {p.measuredHours.toFixed(1)}h, ending {when(p.observed_at)}. Recorded usage + measured hourly burn × hours from that reading to reset. Up to 24h of continuous history in this window; resets, decreases and gaps over 3h restart the history. Above 100% shows demand beyond the allowance. The dotted guide spreads 100% evenly across the cycle.</p></details>
    </CardContent>
  </Card>;
}
