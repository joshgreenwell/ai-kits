'use client';
import { cn } from 'cn';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Stat, StatGroup } from '@/components/kit';
import { countdownLabel, meterRemaining, urgencyRows, type AccountView, type UrgencyRow, type UrgencyTier } from '@/lib/allowance-view';
import { whenIn } from '@/lib/usage-view';

// The same rule the account cards use: a shortfall under a point is still a shortfall, never "0% short".
const points = (value: number) => (Math.abs(value) < 1 && value !== 0 ? Math.abs(value).toFixed(1) : Math.abs(value).toFixed(0));

const TIER_TONE: Record<UrgencyTier, string> = {
  short: 'text-destructive', exhausted: 'text-destructive', tight: 'text-warning', steady: 'text-foreground', history: 'text-muted-foreground',
};

/** What the forecast says about one window, in the words the account cards use for the same fact. */
function verdict(row: UrgencyRow, timezone: string): { text: string; tone: string } {
  const p = row.window.pace;
  if (!p) return { text: 'history only', tone: 'text-muted-foreground' };
  if (row.tier === 'short') return { text: `runs out ${whenIn(p.exhaustionAt, timezone)} · ${points(row.left!)}% short`, tone: 'text-destructive' };
  if (row.tier === 'exhausted') return { text: 'fully used · waiting on the reset', tone: 'text-destructive' };
  if (row.left !== null) return { text: `~${points(row.left)}% left by reset`, tone: row.tier === 'tight' ? 'text-warning' : 'text-muted-foreground' };
  if (p.staleReason === 'expired') return { text: 'new window · no reading yet', tone: 'text-warning' };
  if (p.stale) return { text: `paused · reading ${ageLabel(p.ageMinutes)} old`, tone: 'text-warning' };
  return { text: 'learning pace · no projection yet', tone: 'text-muted-foreground' };
}

/**
 * A window's title without the provider its account already names: under "Claude · personal", the
 * window "Claude · weekly · Fable" reads "Weekly · Fable".
 */
export function windowName(row: Pick<UrgencyRow, 'account' | 'window'>) {
  const provider = row.account.label.split(' · ')[0];
  const title = row.window.title.toLowerCase().startsWith(`${provider.toLowerCase()} · `) ? row.window.title.slice(provider.length + 3) : row.window.title;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function ageLabel(minutes: number) {
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * Every visible window across the accounts in one list, most urgent first, so the question the page
 * exists to answer - will anything run out before it resets, and when - is the first thing on it. The
 * levels are what is LEFT, drawn the way the account cards draw them. Selecting a row opens that
 * account below at the window's burn history.
 */
export function AllowanceOutlook({ views, now, timezone, onSelect }: {
  views: AccountView[]; now: number; timezone: string; onSelect: (accountId: string, windowKey: string) => void;
}) {
  const rows = urgencyRows(views);
  if (!rows.length) return null;
  const short = rows.filter(row => row.tier === 'short');
  const exhausted = rows.filter(row => row.tier === 'exhausted');
  const current = rows.filter(row => row.window.pace);
  const lowest = current.reduce<UrgencyRow | null>((low, row) => (!low || row.window.pace!.remaining < low.window.pace!.remaining ? row : low), null);
  const upcoming = current.filter(row => Date.parse(row.window.pace!.resets_at) > now)
    .sort((a, b) => Date.parse(a.window.pace!.resets_at) - Date.parse(b.window.pace!.resets_at))[0] ?? null;
  const paused = current.filter(row => row.window.pace!.stale);
  const name = (row: UrgencyRow) => `${row.account.label} · ${windowName(row)}`;
  const accounts = new Set(rows.map(row => row.account.id)).size;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Allowance outlook</CardTitle>
        <CardDescription>
          {rows.length} {rows.length === 1 ? 'window' : 'windows'} across {accounts} {accounts === 1 ? 'account' : 'accounts'}, most urgent first. Each bar is what is left until its reset.
        </CardDescription>
      </CardHeader>
      <StatGroup className="border-border border-y">
        <Stat label="Runs out before reset" value={short.length} tone={short.length ? 'destructive' : 'default'}
          caption={short.length ? `${name(short[0])} · ${whenIn(short[0].window.pace!.exhaustionAt, timezone)}` : 'every forecast lasts to its reset'} />
        <Stat label="Lowest left" value={lowest ? `${lowest.window.pace!.remaining.toFixed(1)}%` : '—'}
          tone={exhausted.length ? 'destructive' : lowest && lowest.window.pace!.remaining < 20 ? 'warning' : 'default'}
          caption={lowest ? (exhausted.length > 1 ? `${exhausted.length} windows fully used` : name(lowest)) : 'no current reading'} />
        <Stat label="Next reset" value={upcoming ? countdownLabel(upcoming.window.pace!.resets_at, now) : '—'}
          caption={upcoming ? name(upcoming) : 'no reset ahead in the readings'} />
        <Stat label="Paused forecasts" value={paused.length} tone={paused.length ? 'warning' : 'default'}
          caption={paused.length ? 'a fresh reading resumes each one' : 'every reading is current'} />
      </StatGroup>
      <div className="text-muted-foreground hidden grid-cols-[minmax(0,15rem)_minmax(0,1fr)_4.5rem_minmax(0,15rem)_6rem] gap-x-4 px-4 pt-3 pb-1 text-[10px] font-semibold tracking-wider uppercase md:grid">
        <span>Window</span><span>Left until reset</span><span className="text-right">Left</span><span>Outlook</span><span className="text-right">Resets</span>
      </div>
      <ul className="divide-border divide-y" aria-label="Allowance windows by urgency">
        {rows.map(row => <OutlookRow key={`${row.account.id}:${row.window.key}`} row={row} now={now} timezone={timezone} onSelect={onSelect} />)}
      </ul>
      <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed">
        Levels come from each window&apos;s newest live reading, so the history range never changes them. A paused forecast keeps its last level; select a row to see its burn history.
      </p>
    </Card>
  );
}

function OutlookRow({ row, now, timezone, onSelect }: { row: UrgencyRow; now: number; timezone: string; onSelect: (accountId: string, windowKey: string) => void }) {
  const p = row.window.pace;
  const remaining = meterRemaining(p);
  const over = row.tier === 'short';
  const alarm = over || row.tier === 'exhausted';
  const said = verdict(row, timezone);
  const reset = !p ? '—' : Date.parse(p.resets_at) <= now ? 'has reset' : `in ${countdownLabel(p.resets_at, now)}`;
  return (
    <li>
      <button type="button" onClick={() => onSelect(row.account.id, row.window.key)} data-testid={`outlook-${row.account.id}-${row.window.key}`}
        className="hover:bg-accent/40 focus-visible:ring-ring/50 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_4.5rem_minmax(0,15rem)_6rem]">
        <span className="grid min-w-0 md:col-start-1 md:row-start-1">
          <span className="truncate text-sm font-semibold">{windowName(row)}</span>
          <span className="text-muted-foreground truncate text-xs">{row.account.label}{row.window.scoped ? ' · model-scoped' : ''}{row.window.spark ? ' · Spark' : ''}</span>
        </span>
        <span className={cn('text-right font-mono text-sm font-medium tabular-nums md:col-start-3 md:row-start-1', TIER_TONE[row.tier])}>
          {p ? `${p.remaining.toFixed(1)}%` : '—'}
        </span>
        {p ? (
          <span role="meter" aria-label={`${row.account.label} ${row.window.title} allowance remaining`} aria-valuenow={remaining} aria-valuemin={0} aria-valuemax={100}
            aria-valuetext={`${p.remaining.toFixed(1)}% left, ${said.text}`}
            className={cn('bg-muted border-border relative col-span-2 h-2 overflow-hidden rounded-sm border md:col-span-1 md:col-start-2 md:row-start-1', alarm && 'bg-destructive/20')}>
            <span className={cn('absolute inset-y-0 left-0', over ? 'bg-[repeating-linear-gradient(135deg,var(--destructive)_0_3px,transparent_3px_6px)]' : 'bg-primary')} style={{ width: `${remaining}%` }} />
          </span>
        ) : (
          <span className="text-muted-foreground col-span-2 text-xs md:col-span-1 md:col-start-2 md:row-start-1">no current reading</span>
        )}
        <span className={cn('min-w-0 font-mono text-[11px] leading-snug md:col-start-4 md:row-start-1', said.tone)}>{said.text}</span>
        <span className="text-muted-foreground text-right font-mono text-[11px] whitespace-nowrap md:col-start-5 md:row-start-1">{reset}</span>
      </button>
    </li>
  );
}
