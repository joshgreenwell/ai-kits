'use client';
import { cn } from 'cn';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Stat, StatGroup } from '@/components/kit';
import { AllowanceBurnChart } from '@/components/allowance-burn-chart';
import { OUTLOOK_LABELS, countdownLabel, meterRemaining, projectedRemaining, remainingLabel, type AccountView, type WindowView } from '@/lib/allowance-view';
import { whenIn } from '@/lib/usage-view';

const tone: Record<WindowView['state'], 'soft' | 'soft-info' | 'soft-warning' | 'outline'> = {
  measured: 'soft', blended: 'soft', historical: 'soft-info', learning: 'outline', stale: 'soft-warning', expired: 'soft-warning', history_only: 'outline',
};

function AlertBadges({ alerts }: { alerts: string[] }) {
  const oauth = alerts.filter(alert => alert.startsWith('Claude OAuth'));
  const identity = alerts.filter(alert => !alert.startsWith('Claude OAuth'));
  return (
    <>
      {oauth.length ? <Badge variant="soft-warning" title={oauth.join(' ')}>OAuth failed</Badge> : null}
      {identity.length ? <Badge variant="soft-warning" title={identity.join(' ')}>identity{identity.length > 1 ? ` · ${identity.length}` : ''}</Badge> : null}
    </>
  );
}

/**
 * One full-width expandable card per account (USG-023). The header shows the account, its latest
 * observation, and every visible window side by side (remaining, reset countdown, compact outlook);
 * expanding reveals each window's burn history and its forecast stats. Several accounts may be
 * open; the owner remembers which. Every figure is the newest live reading of its own window, so a
 * Tokens filter or a history range never changes what a header says about current capacity.
 *
 * Every level on this card is what is LEFT, so the meter agrees with the headline above it: the bar
 * starts full and empties toward the reset. The one consumed figure kept is the "% used" caption,
 * which says so in words and is the only place the provider's own number is legible.
 */
export function AllowanceAccordion({ views, expanded, onExpandedChange, now, timezone }: {
  views: AccountView[]; expanded: string[]; onExpandedChange: (ids: string[]) => void; now: number; timezone: string;
}) {
  return (
    <Accordion type="multiple" value={expanded} onValueChange={onExpandedChange} className="grid gap-4">
      {views.map(view => (
        <AccordionItem key={view.account.id} value={view.account.id} data-testid={`account-${view.account.id}`}
          className="bg-card text-card-foreground border-border overflow-hidden rounded-xl border shadow-sm last:border-b">
          <AccordionTrigger className="items-center gap-3 p-4 hover:no-underline">
            <span className="grid min-w-0 gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">{view.account.label}</span>
                <Badge variant="outline">{view.account.provider}</Badge>
                <AlertBadges alerts={view.alerts} />
              </span>
              <span className="text-muted-foreground font-mono text-xs font-normal">
                {view.latestObservation ? `last observation ${whenIn(view.latestObservation, timezone)}` : 'no readings yet'}{view.hiddenSpark ? ` · ${view.hiddenSpark} Spark ${view.hiddenSpark === 1 ? 'window' : 'windows'} hidden` : ''}
              </span>
            </span>
          </AccordionTrigger>
          {view.alerts.length ? (
            <ul className="text-warning border-border grid gap-1 border-t px-4 py-3 text-xs">{view.alerts.map(alert => <li key={alert}>{alert}</li>)}</ul>
          ) : null}
          {/*
            A 1px gap over the border colour divides the windows in every wrap, without ringing each one.
            auto-fit, not a fixed column count: a fixed one leaves empty tracks for an account with fewer
            windows than columns, and the parent's border colour shows through them as a grey slab.
          */}
          <div className="bg-border border-border grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-px border-t" data-testid="window-summaries">
            {view.visible.length ? view.visible.map(window => <WindowSummary key={window.key} window={window} now={now} timezone={timezone} />) : (
              <p className="bg-card text-muted-foreground p-4 text-sm">{view.windows.length ? 'Only Spark windows exist for this account; use the toggle above to show them.' : 'No allowance readings collected yet.'}</p>
            )}
          </div>
          <AccordionContent className="border-border grid gap-6 border-t p-4 xl:grid-cols-2">
            {view.visible.map(window => <WindowDetail key={window.key} account={view.account} window={window} now={now} timezone={timezone} />)}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function WindowSummary({ window, now, timezone }: { window: WindowView; now: number; timezone: string }) {
  const p = window.pace;
  // The drawn level is clamped; `left` stays real so a forecast that runs past the allowance keeps its warning.
  const left = projectedRemaining(p);
  const over = left !== null && left < 0;
  const remaining = meterRemaining(p);
  // An alarm the fill cannot carry: at the worst forecasts the fill is a sliver, and an exhausted
  // allowance has no fill at all, so the track takes the tone and the shrinking region keeps it.
  const alarm = over || remaining === 0;
  // A shortfall under a point is still a shortfall. Rounding it across the sign boundary would print
  // "0% short by reset" under a destructive headline, a caption denying the warning it sits beneath.
  const byReset = (value: number) => (Math.abs(value) < 1 && value !== 0 ? Math.abs(value).toFixed(1) : Math.abs(value).toFixed(0));
  const forecast = left === null ? null : left >= 0 ? `${byReset(left)}% left by reset` : `${byReset(left)}% short by reset`;
  return (
    <div className="bg-card grid content-start gap-1.5 p-4" data-testid={`window-${window.key}`}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-sm font-semibold">{window.title}</span>
        <Badge variant={tone[window.state]}>{OUTLOOK_LABELS[window.state]}</Badge>
      </div>
      {/* The anchor figure names its own unit: without it, the "% used" line directly below makes the
          big number read as consumption, which is the ambiguity this gauge exists to remove. */}
      <span className={cn('font-mono text-2xl leading-none font-medium tabular-nums', over && 'text-destructive')}>
        {p ? <>{`${p.remaining.toFixed(1)}%`}<span className="text-muted-foreground ml-1 text-xs font-normal">left</span></> : '—'}
      </span>
      <span className="text-muted-foreground font-mono text-[10.5px] leading-snug">{p ? `${p.used_percent.toFixed(1)}% used · ${Date.parse(p.resets_at) <= now ? 'window has reset' : `resets in ${countdownLabel(p.resets_at, now)}`}` : remainingLabel(p)}</span>
      {/* A history-only window has no current capacity to report, so it draws no meter at all rather than
          a full one. The widget carries the forecast itself: the caption below it is an unassociated
          node, so anyone querying the meter alone would otherwise hear the same text whatever the
          forecast says. */}
      {p ? (
        <div role="meter" aria-label={`${window.title} allowance remaining`} aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={100}
          aria-valuetext={`${p.remaining.toFixed(1)}% left, ${p.used_percent.toFixed(1)}% used${forecast === null ? '' : `, projected ${forecast}`}`}
          className={cn('bg-muted border-border relative mt-0.5 h-2 overflow-hidden rounded-sm border', alarm && 'bg-destructive/20')}>
          {/* Left-anchored and shrinking: the fill is what is left, so it retreats to the right as the
              allowance is spent. An overrun hatches it destructive, the same language the kit Meter
              uses for "the forecast eats all of this", rather than painting the reserve itself as bad. */}
          <span className={cn('absolute inset-y-0 left-0', over ? 'bg-[repeating-linear-gradient(135deg,var(--destructive)_0_3px,transparent_3px_6px)]' : 'bg-primary')} style={{ width: `${remaining}%` }} />
        </div>
      ) : null}
      <span className="text-muted-foreground font-mono text-[10.5px] leading-snug">
        {p ? (forecast === null ? (p.stale ? 'projection paused' : 'no projection yet') : forecast) : 'no live source'}
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
  const left = projectedRemaining(p);
  const over = left !== null && left < 0;
  const staleText = p?.staleReason === 'expired'
    ? 'This window has reset; a reading from the new window is needed to resume the forecast.'
    : p ? `The last reading is ${Math.round(p.ageMinutes)} minutes old (stale after ${p.staleAfterMinutes}); a fresh reading is needed to resume the forecast.` : '';
  const verdict = !p
    ? `Every reading of this window comes from a disabled source, so it is history only; the newest is from ${whenIn(window.latestObservation, timezone)}.`
    : p.projectedUsedPercent === null
      ? (p.stale ? staleText : 'At least 30 minutes of readings in this reset window are needed.')
      : p.remaining === 0 ? 'This allowance is fully used. Waiting for the next reset.'
        : over ? `Allowance runs out ${whenIn(p.exhaustionAt, timezone)} at this forecast pace.` : 'Your allowance lasts through this reset at the forecast pace.';
  return (
    <section className="grid content-start gap-3" aria-label={`${account.label} ${window.title}`} data-testid={`detail-${window.key}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{window.title}</h3>
        <span className="text-muted-foreground font-mono text-[10.5px]">{window.label}{window.latestReader && window.latestReader !== 'v1' ? ` · via ${window.latestReader}` : ''} · {window.windowMinutes >= 1440 ? `${Math.round(window.windowMinutes / 1440)}-day` : `${Math.round(window.windowMinutes / 60)}-hour`} window{window.historyOnlyRows ? ` · ${window.historyOnlyRows} history-only readings` : ''}</span>
      </div>
      <AllowanceBurnChart pace={p} cycles={window.cycles} history={window.history} timezone={timezone} />
      <StatGroup className="border-border border-y">
        {/* Names the same end point the chart's projection line now draws, so both read as what is left. The
            caption keeps the consumed side of the fact: how much of the allowance the forecast spends.
            A shortfall is spelled the way the summary card spells it - "145.0% short", never a negative
            quantity of "left" - so one overrun is not told two ways inside one card. */}
        <Stat label="Projected left at reset" value={left === null ? '—' : left >= 0 ? `${left.toFixed(1)}%` : `${Math.abs(left).toFixed(1)}% short`} tone={over ? 'destructive' : 'default'}
          caption={!p ? 'history only' : p.projectedUsedPercent === null ? (p.stale ? 'refresh needed' : 'learning your pace') : p.remaining === 0 ? 'allowance fully used' : over ? `${(p.projectedUsedPercent - 100).toFixed(1)} pts over` : `${p.projectedUsedPercent.toFixed(1)}% of the allowance used`} />
        <Stat label={`Forecast burn / ${rateUnit}`} value={p?.pointsPerHour === null || p?.pointsPerHour === undefined ? '—' : (p.pointsPerHour * (hourly ? 1 : 24)).toFixed(1)}
          caption={!p ? 'history only' : p.forecastSource === 'historical' ? `${p.comparableCycles} prior ${p.comparableCycles === 1 ? 'cycle' : 'cycles'} · pts` : p.forecastSource === 'blended' ? `${Math.round(p.liveWeight * 100)}% current evidence · pts` : p.forecastSource === 'current_window' ? 'measured this window · pts' : 'waiting for usable evidence'} />
        <Stat label={`Available pace / ${rateUnit}`} value={p?.sustainablePointsPerDay === null || p?.sustainablePointsPerDay === undefined ? '—' : (p.sustainablePointsPerDay / (hourly ? 24 : 1)).toFixed(1)} caption="pts" />
      </StatGroup>
      <p className={cn('text-sm', over ? 'text-destructive' : 'text-muted-foreground')}>{verdict}</p>
    </section>
  );
}
