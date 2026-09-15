'use client';
import { Accordion as AccordionPrimitive } from 'radix-ui';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { Stat, StatGroup } from '@/components/kit';
import { AllowanceBurnChart } from '@/components/allowance-burn-chart';
import { OUTLOOK_LABELS, countdownLabel, remainingLabel, type AccountView, type WindowView } from '@/lib/allowance-view';
import { whenIn } from '@/lib/usage-view';

const tone: Record<WindowView['state'], 'soft' | 'soft-info' | 'soft-warning' | 'outline'> = {
  measured: 'soft', blended: 'soft', historical: 'soft-info', learning: 'outline', stale: 'soft-warning', expired: 'soft-warning', history_only: 'outline',
};

/**
 * One full-width expandable card per account (USG-023). The header shows the account, its latest
 * observation, and every visible window side by side (remaining, reset countdown, compact outlook);
 * expanding reveals each window's burn history with the forecast explanation. Several accounts may be
 * open; the owner remembers which. Every figure is the newest live reading of its own window, so a
 * Tokens filter or a history range never changes what a header says about current capacity.
 */
export function AllowanceAccordion({ views, expanded, onExpandedChange, now, timezone }: {
  views: AccountView[]; expanded: string[]; onExpandedChange: (ids: string[]) => void; now: number; timezone: string;
}) {
  return (
    <AccordionPrimitive.Root type="multiple" value={expanded} onValueChange={onExpandedChange} className="grid gap-4">
      {views.map(view => (
        <AccordionPrimitive.Item key={view.account.id} value={view.account.id} className="bg-card text-card-foreground border-border overflow-hidden rounded-xl border shadow-sm" data-testid={`account-${view.account.id}`}>
          <AccordionPrimitive.Header asChild>
            <div className="grid gap-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <AccordionPrimitive.Trigger className="group focus-visible:ring-ring/50 flex min-w-0 flex-1 items-start gap-3 rounded-md text-left outline-none focus-visible:ring-[3px]">
                  <span aria-hidden="true" className="text-muted-foreground mt-1 inline-block transition-transform group-data-[state=open]:rotate-90">▶</span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-base font-semibold">{view.account.label}</span>
                      <Badge variant="outline">{view.account.provider}</Badge>
                      {view.alerts.map(alert => <Badge key={alert} variant="soft-warning" title={alert}>identity</Badge>)}
                    </span>
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {view.latestObservation ? `last observation ${whenIn(view.latestObservation, timezone)}` : 'no readings yet'}{view.hiddenSpark ? ` · ${view.hiddenSpark} Spark ${view.hiddenSpark === 1 ? 'window' : 'windows'} hidden` : ''}
                    </span>
                  </span>
                </AccordionPrimitive.Trigger>
              </div>
              {view.alerts.length ? <ul className="text-warning grid gap-1 text-xs">{view.alerts.map(alert => <li key={alert}>{alert}</li>)}</ul> : null}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(200px,1fr))]" data-testid="window-summaries">
                {view.visible.length ? view.visible.map(window => <WindowSummary key={window.key} window={window} now={now} timezone={timezone} />) : (
                  <p className="text-muted-foreground text-sm">{view.windows.length ? 'Only Spark windows exist for this account; use the toggle above to show them.' : 'No allowance readings collected yet.'}</p>
                )}
              </div>
            </div>
          </AccordionPrimitive.Header>
          <AccordionPrimitive.Content className="border-border data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 border-t">
            <div className="grid gap-6 p-4 xl:grid-cols-2">
              {view.visible.map(window => <WindowDetail key={window.key} account={view.account} window={window} now={now} timezone={timezone} />)}
            </div>
          </AccordionPrimitive.Content>
        </AccordionPrimitive.Item>
      ))}
    </AccordionPrimitive.Root>
  );
}

function WindowSummary({ window, now, timezone }: { window: WindowView; now: number; timezone: string }) {
  const p = window.pace;
  const over = p?.projectedUsedPercent !== null && p?.projectedUsedPercent !== undefined && p.projectedUsedPercent > 100;
  return (
    <div className={cn('border-border grid gap-1.5 rounded-lg border p-3', over && 'border-destructive/45')} data-testid={`window-${window.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-sm font-semibold">{window.title}</span>
        <Badge variant={tone[window.state]} className="text-[10px]">{OUTLOOK_LABELS[window.state]}</Badge>
      </div>
      <span className={cn('font-mono text-2xl leading-none font-medium tabular-nums', over && 'text-destructive')}>{p ? `${p.remaining.toFixed(1)}%` : '—'}</span>
      <span className="text-muted-foreground font-mono text-[11px]">{p ? `${p.used_percent.toFixed(1)}% used · ${Date.parse(p.resets_at) <= now ? 'window has reset' : `resets in ${countdownLabel(p.resets_at, now)}`}` : remainingLabel(p)}</span>
      {p ? (
        <div role="meter" aria-label={`${window.title} usage`} aria-valuenow={p.used_percent} aria-valuemin={0} aria-valuemax={100} className="bg-muted border-border relative h-1.5 overflow-hidden rounded-sm border">
          <span className={cn('absolute inset-y-0 left-0', over ? 'bg-destructive' : 'bg-primary')} style={{ width: `${Math.min(100, p.used_percent)}%` }} />
        </div>
      ) : null}
      <span className="text-muted-foreground font-mono text-[10px]">
        {p ? (p.projectedUsedPercent === null ? (p.stale ? 'projection paused' : 'no projection yet') : `${p.projectedUsedPercent.toFixed(0)}% by reset`) : 'no live source'}
        {` · observed ${whenIn(p ? p.observed_at : window.latestObservation, timezone)}`}
        {window.scoped ? ' · model-scoped' : ''}{window.spark ? ' · Spark' : ''}
      </span>
    </div>
  );
}

function WindowDetail({ account, window, now, timezone }: { account: AccountView['account']; window: WindowView; now: number; timezone: string }) {
  const p = window.pace;
  const hourly = window.windowMinutes < 1440;
  const rateUnit = hourly ? 'hour' : 'day';
  const over = p?.projectedUsedPercent !== null && p?.projectedUsedPercent !== undefined && p.projectedUsedPercent > 100;
  const staleText = p?.staleReason === 'expired'
    ? 'This window has reset; a reading from the new window is needed to resume the forecast.'
    : p ? `The last reading is ${Math.round(p.ageMinutes)} minutes old (stale after ${p.staleAfterMinutes}); a fresh reading is needed to resume the forecast.` : '';
  const verdict = !p
    ? `Every reading of this window comes from a disabled source, so it is history only; the newest is from ${whenIn(window.latestObservation, timezone)}.`
    : p.projectedUsedPercent === null
      ? (p.stale ? staleText : 'At least 30 minutes of readings in this reset window are needed.')
      : p.remaining === 0 ? 'This allowance is fully used. Waiting for the next reset.'
        : over ? `Allowance runs out ${whenIn(p.exhaustionAt, timezone)} at this forecast pace.` : 'Your allowance lasts through this reset at the forecast pace.';
  const explanation = !p ? ''
    : p.forecastSource === 'historical' ? `The forecast is seeded by the recent median from ${p.comparableCycles} completed ${p.comparableCycles === 1 ? 'cycle' : 'cycles'} until this window has enough evidence.`
    : p.forecastSource === 'blended' ? `Current-window pace is blended with ${p.comparableCycles} completed ${p.comparableCycles === 1 ? 'cycle' : 'cycles'}; current evidence now has ${Math.round(p.liveWeight * 100)}% weight.`
    : p.forecastSource === 'current_window' ? 'The forecast uses continuous history from this window.'
    : p.forecastSource === 'stale' ? `The latest reading is stale (${p.staleReason === 'expired' ? 'its window has reset' : 'older than the collection cadence allows'}), so the active projection is paused.`
    : 'No comparable completed cycle or usable live segment is available yet.';
  return (
    <section className="grid gap-3" aria-label={`${account.label} ${window.title}`} data-testid={`detail-${window.key}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{window.title}</h3>
        <span className="text-muted-foreground font-mono text-[10px]">{window.label}{window.latestReader && window.latestReader !== 'v1' ? ` · via ${window.latestReader}` : ''} · {window.windowMinutes >= 1440 ? `${Math.round(window.windowMinutes / 1440)}-day` : `${Math.round(window.windowMinutes / 60)}-hour`} window{window.historyOnlyRows ? ` · ${window.historyOnlyRows} history-only readings` : ''}</span>
      </div>
      <AllowanceBurnChart pace={p} cycles={window.cycles} history={window.history} timezone={timezone} />
      <StatGroup className="border-border rounded-md border">
        <Stat label="Projected by reset" value={p?.projectedUsedPercent === null || p?.projectedUsedPercent === undefined ? '—' : `${p.projectedUsedPercent.toFixed(1)}%`} tone={over ? 'destructive' : 'default'}
          caption={!p ? 'history only' : p.projectedUsedPercent === null ? (p.stale ? 'refresh needed' : 'learning your pace') : p.remaining === 0 ? 'allowance fully used' : over ? `${(p.projectedUsedPercent - 100).toFixed(1)} pts over` : `${(100 - p.projectedUsedPercent).toFixed(1)}% left at reset`} />
        <Stat label={`Forecast burn / ${rateUnit}`} value={p?.pointsPerHour === null || p?.pointsPerHour === undefined ? '—' : (p.pointsPerHour * (hourly ? 1 : 24)).toFixed(1)}
          caption={!p ? 'history only' : p.forecastSource === 'historical' ? `${p.comparableCycles} prior ${p.comparableCycles === 1 ? 'cycle' : 'cycles'} · pts` : p.forecastSource === 'blended' ? `${Math.round(p.liveWeight * 100)}% current evidence · pts` : p.forecastSource === 'current_window' ? 'measured this window · pts' : 'waiting for usable evidence'} />
        <Stat label={`Available pace / ${rateUnit}`} value={p?.sustainablePointsPerDay === null || p?.sustainablePointsPerDay === undefined ? '—' : (p.sustainablePointsPerDay / (hourly ? 24 : 1)).toFixed(1)} caption="pts" />
      </StatGroup>
      <p className={cn('text-sm', over ? 'text-destructive' : 'text-muted-foreground')}>{verdict}</p>
      {p ? (
        <details>
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[11px]">How this projection works</summary>
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
            {p.samples} readings over {p.measuredHours.toFixed(1)}h, ending {whenIn(p.observed_at, timezone)}. {explanation}
            {window.scoped ? ' This window is capped for one model; that model’s use also counts toward the shared weekly window.' : ''}
            {' '}Resets, decreases, and gaps over 3h restart live history. Above 100% shows demand beyond the allowance. The dotted diagonal spreads 100% evenly across the cycle. Readings from a disabled source stay on the chart as history and never become the current reading.
          </p>
        </details>
      ) : null}
    </section>
  );
}
