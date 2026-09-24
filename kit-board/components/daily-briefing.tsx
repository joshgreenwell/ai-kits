'use client';
import { useMemo, useState } from 'react';
import { ArrowUpRightIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from 'cn';
import type { StoredReport } from '@/lib/contracts';
import {
  KIND_LABEL, KIND_ORDER, PRIORITY_LABEL, WORKDAY_HOURS, coverageTone, dayLoad, focusItems, hours, priorityGroups, queuePriorityRank,
  type Briefing, type BriefingDomain, type BriefingItem, type BriefingKind, type BriefingPriority, type BriefingQueue, type CalendarDay,
  type CleanupCandidate, type CoverageRow, type EntryClass, type InboxSignal, type QueueRow,
} from '@/lib/daily-briefing';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyButton, DataTable, Disclosure, EmptyState, Prose, Stat, StatGroup, StatusBadge, type Column } from '@/components/kit';
import { SectionNav } from '@/components/kit/section-nav';
import { markdownOf, reportDate, statusLabel } from '@/components/report-view';

/** How many focus items show before the rest of the day's list is asked for. */
export const FOCUS_LIMIT = 6;
// The app's unlayered `button { font: inherit }` outranks a button's own text size, so containers set it.
const LABEL = 'text-muted-foreground text-[10px] font-semibold tracking-wider uppercase';
const FOOTER = 'border-border text-muted-foreground border-t p-3 text-xs leading-relaxed';

const PRIORITY_BADGE: Record<BriefingPriority, React.ComponentProps<typeof Badge>['variant']> = {
  urgent: 'soft-destructive', today: 'soft', soon: 'outline', later: 'secondary',
};
const ENTRY_RULE: Record<EntryClass, string> = { shared: 'border-primary', own: 'border-primary/40', excluded: 'border-border' };

const KINDS = Object.keys(KIND_ORDER) as BriefingKind[];
const KIND_SHORT: Record<BriefingKind, [string, string]> = { reply: ['reply', 'replies'], deadline: ['deadline', 'deadlines'], followup: ['follow-up', 'follow-ups'], information: ['notice', 'notices'] };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Calendar dates carry no time zone, so they are formatted at UTC noon to keep their day.
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
const stale = (value: string | null) => !!value && /not refreshed|stale|historical/i.test(value);
const shownProject = (row: BriefingItem) => (row.project && row.project.toLowerCase() !== row.domain ? row.project : null);

function PriorityBadge({ priority }: { priority: BriefingPriority }) {
  return <Badge variant={PRIORITY_BADGE[priority]} className="font-mono text-[10.5px] lowercase">{PRIORITY_LABEL[priority]}</Badge>;
}

function ItemLinks({ row }: { row: BriefingItem }) {
  if (!row.links.length) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {row.links.map(link => (
        <a key={link.href} href={link.href} target="_blank" rel="noreferrer"
          className="text-primary! inline-flex items-center gap-0.5 text-xs font-medium underline-offset-4 hover:underline!">
          {link.label}<ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      ))}
    </span>
  );
}

function NextStep({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="text-[13px] leading-relaxed">
      <span className={cn(LABEL, 'text-primary mr-2')}>Next</span>{text}
    </p>
  );
}

/** An item the producer could not re-read this run; the badge says so and its title carries the producer's words. */
function StaleBadge({ row }: { row: BriefingItem }) {
  if (!stale(row.freshness) && !stale(row.when)) return null;
  return <Badge variant="soft-warning" title={row.freshness ?? undefined}>not refreshed</Badge>;
}

/** Where the reading came from and its tracked state: provenance, kept out of the row until it is asked for. */
function Provenance({ row }: { row: BriefingItem }) {
  const parts = [shownProject(row), row.status, row.freshness].filter(Boolean);
  if (!parts.length) return null;
  return <span className="text-muted-foreground font-mono text-[11px] leading-snug">{parts.join(' · ')}</span>;
}

// ---------------------------------------------------------------------------------------------------------
// Focus

/**
 * The page's first answer: what needs you today. Everything urgent or marked for today, across every
 * area, ranked urgent first and then replies, deadlines, follow-ups and notices, each with its next step.
 */
export function FocusCard({ briefing }: { briefing: Briefing }) {
  const [all, setAll] = useState(false);
  const items = useMemo(() => focusItems(briefing), [briefing]);
  const everything = briefing.domains.flatMap(domain => domain.items);
  const urgent = items.filter(row => row.priority === 'urgent').length;
  const replies = everything.filter(row => row.kind === 'reply');
  const deadlines = everything.filter(row => row.kind === 'deadline');
  const dueNow = (rows: BriefingItem[]) => rows.filter(row => row.priority === 'urgent' || row.priority === 'today').length;
  const areas = briefing.domains.filter(domain => items.some(row => row.domain === domain.key));
  const byKind = (rows: BriefingItem[]) => KINDS.map(kind => [kind, rows.filter(row => row.kind === kind).length] as const).filter(([, n]) => n)
    .map(([kind, n]) => plural(n, ...KIND_SHORT[kind])).join(' · ');
  const today = items.filter(row => row.priority === 'today');
  const shown = all ? items : items.slice(0, FOCUS_LIMIT);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Focus today</CardTitle>
        <CardDescription>
          {items.length
            ? `${plural(items.length, 'item')} need you today${areas.length ? ` across ${areas.map(domain => domain.label).join(', ')}` : ''}: urgent first, then replies, deadlines and follow-ups.`
            : 'Nothing in this briefing is marked urgent or for today.'}
        </CardDescription>
      </CardHeader>
      <StatGroup className="border-border grid-cols-2 border-y md:grid-cols-4">
        <Stat label="Urgent" value={urgent} tone={urgent ? 'destructive' : 'default'} caption={urgent ? byKind(items.filter(row => row.priority === 'urgent')) : 'nothing marked urgent'} />
        <Stat label="For today" value={today.length} caption={today.length ? byKind(today) : 'nothing else today'} />
        <Stat label="Replies owed" value={replies.length} tone={dueNow(replies) ? 'warning' : 'default'} caption={`${dueNow(replies)} due today · ${replies.length - dueNow(replies)} later`} />
        <Stat label="Deadlines" value={deadlines.length} tone={dueNow(deadlines) ? 'warning' : 'default'} caption={`${dueNow(deadlines)} due today · ${deadlines.length - dueNow(deadlines)} later`} />
      </StatGroup>
      {items.length ? (
        <ol className="divide-border divide-y" aria-label="Focus items, most urgent first">
          {shown.map(row => <FocusRow key={row.key} row={row} />)}
        </ol>
      ) : (
        <div className="p-4">
          <EmptyState title="A clear day" description="Soon and later items are under Everything in the briefing." />
        </div>
      )}
      {items.length > FOCUS_LIMIT ? (
        <div className="border-border border-t p-2 text-sm">
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground w-full" aria-expanded={all} onClick={() => setAll(value => !value)}>
            {all ? `Show the top ${FOCUS_LIMIT}` : `Show all ${items.length} for today`}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function FocusRow({ row }: { row: BriefingItem }) {
  const project = shownProject(row);
  return (
    <li className="grid gap-1.5 px-4 py-3" data-testid={`focus-${row.key}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <PriorityBadge priority={row.priority} />
        <span className="text-muted-foreground text-xs font-medium">{KIND_LABEL[row.kind]}</span>
        <StaleBadge row={row} />
        <span className="text-muted-foreground ml-auto font-mono text-[11px]">{row.domainLabel}{project ? ` · ${project}` : ''}</span>
      </div>
      <h3 className="text-sm leading-snug font-semibold">{row.title}</h3>
      <NextStep text={row.nextStep} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {row.when ? <span className="text-muted-foreground min-w-0 font-mono text-[11px] leading-snug">{row.when}</span> : <span />}
        <ItemLinks row={row} />
      </div>
      {row.context || row.status || row.freshness ? (
        <Disclosure title="Why it is here" className="text-xs" contentClassName="grid gap-1.5">
          {row.context ? <p className="text-muted-foreground max-w-[75ch] text-[13px] leading-relaxed">{row.context}</p> : null}
          <Provenance row={{ ...row, project: null }} />
        </Disclosure>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Day and week

function LoadBar({ day, className }: { day: CalendarDay; className?: string }) {
  const { scale } = dayLoad(day);
  return (
    <span className={cn('bg-muted border-border flex overflow-hidden rounded-sm border', className)} aria-hidden>
      <span className="bg-primary" style={{ width: `${(day.shared / scale) * 100}%` }} />
      <span className="bg-primary/40" style={{ width: `${(day.solo / scale) * 100}%` }} />
    </span>
  );
}

/**
 * The breakdown of a day: time with others, your own blocks, and what an eight-hour day leaves open,
 * with the day's calendar under it. The week above it switches the day; today is selected first.
 */
export function DayCard({ week }: { week: NonNullable<Briefing['week']> }) {
  const todayIndex = Math.max(0, week.days.findIndex(day => day.today));
  const [selected, setSelected] = useState(todayIndex);
  const day = week.days[Math.min(selected, week.days.length - 1)];
  const load = dayLoad(day);
  const shared = day.entries.filter(entry => entry.kind === 'shared').length;
  const own = day.entries.filter(entry => entry.kind === 'own').length;
  const excluded = day.entries.length - shared - own;
  const name = day.today ? `Today, ${longDay(day.date)}` : longDay(day.date);

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Your day</CardTitle>
        <CardDescription>
          {name}: {hours(day.shared)} with others and {hours(day.solo)} in your own blocks{load.open !== null ? `, about ${hours(load.open)} open` : ''}.
        </CardDescription>
      </CardHeader>
      <div className="grid grid-cols-7 gap-1 px-3 pb-3" role="group" aria-label="Choose a day this week">
        {week.days.map((item, index) => {
          const itemLoad = dayLoad(item);
          return (
            <button key={item.date} type="button" onClick={() => setSelected(index)} aria-pressed={index === selected} aria-current={item.today ? 'date' : undefined}
              aria-label={`${longDay(item.date)}: ${hours(item.shared)} with others, ${hours(item.solo)} own blocks`}
              className={cn(
                'focus-visible:ring-ring/50 grid min-w-0 justify-items-center gap-1 rounded-md border px-1 py-1.5 outline-none transition-colors focus-visible:ring-[3px]',
                index === selected ? 'bg-secondary border-border' : 'hover:bg-accent/60 border-transparent',
              )}>
              <span className={cn('text-[10px] font-semibold tracking-wider uppercase', item.today ? 'text-primary' : 'text-muted-foreground', item.weekend && !item.today && 'opacity-60')}>
                {weekday(item.date)}
              </span>
              <span className="font-mono text-sm leading-none tabular-nums">{Number(item.day) || item.day}</span>
              <LoadBar day={item} className="h-1 w-full rounded-full border-0" />
              <span className="text-muted-foreground font-mono text-[10px] tabular-nums">{hours(itemLoad.booked)}</span>
            </button>
          );
        })}
      </div>
      <StatGroup className="border-border grid-cols-3 border-y">
        <Stat label="With others" value={hours(day.shared)} caption={plural(shared, 'meeting')} />
        <Stat label="Own blocks" value={hours(day.solo)} caption={plural(own, 'hold')} />
        <Stat label="Open" value={load.open === null ? '—' : `~${hours(load.open)}`} tone={load.open !== null && load.open < 2 ? 'warning' : 'default'}
          caption={load.open === null ? 'weekend' : `of a ${WORKDAY_HOURS}h day`} />
      </StatGroup>
      <div className="grid gap-2 px-4 pt-4" role="img"
        aria-label={`${hours(day.shared)} with others and ${hours(day.solo)} own blocks${load.open !== null ? ` of an ${WORKDAY_HOURS}-hour day` : ''}`}>
        <LoadBar day={day} className="h-2.5" />
        <span className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
          <span className="inline-flex items-center gap-1.5"><i className="bg-primary size-2 rounded-[2px]" />With others</span>
          <span className="inline-flex items-center gap-1.5"><i className="bg-primary/40 size-2 rounded-[2px]" />Your own blocks</span>
          {load.open !== null ? <span className="inline-flex items-center gap-1.5"><i className="bg-muted border-border size-2 rounded-[2px] border" />Open</span> : null}
        </span>
      </div>
      {day.entries.length ? (
        // A list's own padding is reset by the app's unlayered rule, so the inset sits on a wrapper.
        <div className="p-4"><ol className="grid gap-1" aria-label={`${name} calendar`}>
          {day.entries.map(entry => (
            <li key={entry.key} className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 border-l-2 py-1 pl-3', ENTRY_RULE[entry.kind])}>
              <time className="text-muted-foreground font-mono text-[11px] tabular-nums">{entry.time}</time>
              <span className={cn('min-w-0 text-[13px] leading-snug break-words', entry.kind === 'excluded' && 'text-muted-foreground')}>{entry.title}</span>
              <span className={cn('font-mono text-[10.5px] whitespace-nowrap', entry.kind === 'excluded' ? 'text-muted-foreground/70' : 'text-muted-foreground')}>{entry.tagLabel}</span>
            </li>
          ))}
        </ol></div>
      ) : (
        <p className="text-muted-foreground px-4 py-4 text-sm">Nothing on the calendar.</p>
      )}
      <p className={FOOTER}>
        {week.note ? `${week.note} ` : ''}Open time is what an {WORKDAY_HOURS}-hour day leaves after both{excluded ? `; the ${plural(excluded, 'dimmed entry', 'dimmed entries')} ${excluded === 1 ? 'is' : 'are'} not counted` : ''}.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Standup

export function StandupCard({ standup }: { standup?: StoredReport }) {
  const markdown = standup ? markdownOf(standup) : '';
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Standup</CardTitle>
        <CardDescription>
          {standup ? `Observed ${reportDate(standup.produced_at)}${standup.status !== 'complete' ? ` · ${statusLabel(standup.status).toLowerCase()}` : ''}` : 'The standup publishes on weekdays.'}
        </CardDescription>
        {markdown ? <CardAction><CopyButton value={markdown} label="Copy update" variant="outline" /></CardAction> : null}
      </CardHeader>
      {markdown ? (
        <div className="border-border border-t p-4"><Prose markdown={markdown} className="[&_h2]:text-sm [&_h3]:text-sm" /></div>
      ) : (
        <p className="border-border text-muted-foreground border-t p-4 text-sm">{standup ? 'This standup has no text to paste.' : 'No standup for this day.'}</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Everything else

const KIND_FILTER: Record<BriefingKind, string> = { reply: 'Replies', deadline: 'Deadlines', followup: 'Follow-ups', information: 'For awareness' };

/**
 * Every item in the briefing, one area at a time, under the priority it carries. A row is one line - its
 * kind, title and date - and opens to the context, next step and sources, so a long list stays scannable.
 */
export function ItemsCard({ domains }: { domains: BriefingDomain[] }) {
  const [area, setArea] = useState(domains.find(domain => domain.items.length)?.key ?? domains[0]?.key ?? '');
  const [kind, setKind] = useState<BriefingKind | null>(null);
  const current = domains.find(domain => domain.key === area) ?? domains[0];
  const total = domains.reduce((n, domain) => n + domain.items.length, 0);
  if (!current) return null;
  const counts = Object.fromEntries(KINDS.map(key => [key, current.items.filter(row => row.kind === key).length])) as Record<BriefingKind, number>;

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <Tabs value={current.key} onValueChange={setArea} className="gap-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Everything in the briefing</CardTitle>
          <CardDescription>{plural(total, 'item')} by area, under when each needs you. Open a row for its context and sources.</CardDescription>
          <CardAction className="col-start-1 row-start-3 mt-2 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0">
            <TabsList aria-label="Briefing area" className="text-sm">
              {domains.map(domain => (
                <TabsTrigger key={domain.key} value={domain.key} className="gap-1.5 px-3">
                  {domain.label}<span className="text-muted-foreground font-mono text-[11px] tabular-nums">{domain.items.length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </CardAction>
        </CardHeader>
        <div className="border-border flex flex-wrap gap-1 border-t px-3 py-2 text-xs" role="group" aria-label="Filter by kind">
          <Button type="button" size="xs" variant={kind === null ? 'secondary' : 'ghost'} aria-pressed={kind === null} onClick={() => setKind(null)}>
            All <span className="text-muted-foreground font-mono tabular-nums">{current.items.length}</span>
          </Button>
          {KINDS.map(key => (
            <Button key={key} type="button" size="xs" variant={kind === key ? 'secondary' : 'ghost'} aria-pressed={kind === key} disabled={!counts[key] && kind !== key}
              onClick={() => setKind(value => (value === key ? null : key))}>
              {KIND_FILTER[key]} <span className="text-muted-foreground font-mono tabular-nums">{counts[key]}</span>
            </Button>
          ))}
        </div>
        {domains.map(domain => (
          <TabsContent key={domain.key} value={domain.key}>
            <DomainItems domain={domain} kind={kind} />
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  );
}

function DomainItems({ domain, kind }: { domain: BriefingDomain; kind: BriefingKind | null }) {
  const groups = priorityGroups(kind ? domain.items.filter(row => row.kind === kind) : domain.items);
  if (!groups.length) {
    return (
      <p className="border-border text-muted-foreground border-t p-4 text-sm">
        {domain.items.length ? `No ${KIND_FILTER[kind!].toLowerCase()} in ${domain.label}.` : domain.emptyNote || `Nothing in ${domain.label} today.`}
      </p>
    );
  }
  return (
    <div className="border-border border-t">
      {groups.map(group => (
        <section key={group.priority} aria-label={`${domain.label}, ${PRIORITY_LABEL[group.priority]}`}>
          <h3 className={cn(LABEL, 'flex items-center gap-2 px-4 pt-4 pb-2')}>
            {PRIORITY_LABEL[group.priority]}<span className="font-mono tabular-nums">{group.items.length}</span>
          </h3>
          <ul className="divide-border border-border divide-y border-y">
            {group.items.map(row => <ItemRow key={row.key} row={row} />)}
          </ul>
        </section>
      ))}
      <div className="h-4" />
    </div>
  );
}

function ItemRow({ row }: { row: BriefingItem }) {
  const project = shownProject(row);
  return (
    <Collapsible asChild>
      <li className="group/item" data-testid={`item-${row.key}`}>
        <CollapsibleTrigger className="hover:bg-accent/40 focus-visible:ring-ring/50 grid w-full grid-cols-[minmax(0,1fr)_1rem] items-baseline gap-x-4 gap-y-0.5 px-4 py-2.5 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-inset md:grid-cols-[7rem_minmax(0,1fr)_minmax(0,15rem)_1rem]">
          <span className="text-muted-foreground hidden text-xs font-medium md:block">{KIND_LABEL[row.kind]}</span>
          <span className="min-w-0 text-sm font-medium">{row.title}</span>
          <span className="text-muted-foreground hidden min-w-0 truncate font-mono text-[11px] md:block" title={row.when}>{row.when}</span>
          <ChevronRightIcon aria-hidden className="text-muted-foreground size-3.5 self-center transition-transform group-data-[state=open]/item:rotate-90" />
          <span className="text-muted-foreground col-span-2 min-w-0 truncate font-mono text-[11px] md:hidden">{KIND_LABEL[row.kind]}{row.when ? ` · ${row.when}` : ''}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-2 px-4 pb-4 md:pl-[calc(7rem+2rem)]">
          {row.context ? <p className="text-muted-foreground max-w-[75ch] text-[13px] leading-relaxed">{row.context}</p> : null}
          <NextStep text={row.nextStep} />
          {row.when ? <span className="text-muted-foreground font-mono text-[11px]">{row.when}</span> : null}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span className="flex flex-wrap items-center gap-2"><StaleBadge row={row} /><Provenance row={row} /></span>
            <ItemLinks row={row} />
          </div>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Queue, inbox, sources

// Producer labels arrive lower case ("to do", "qa"); a short one is an initialism.
const shareLabel = (label: string) => (/^[a-z]{1,3}$/.test(label) ? label.toUpperCase() : label.charAt(0).toUpperCase() + label.slice(1));

/** A share of a whole, one row per part: the label, its count, and a bar of its share. */
function ShareRows({ rows, total, label }: { rows: { label: string; count: number }[]; total: number; label: string }) {
  const whole = total || rows.reduce((n, row) => n + row.count, 0) || 1;
  return (
    <ul className="grid gap-2.5" aria-label={label}>
      {rows.map(row => (
        <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-1">
          <span className="min-w-0 truncate text-[13px]">{shareLabel(row.label)}</span>
          <span className="text-right font-mono text-[13px] tabular-nums">{row.count}</span>
          <span className="bg-muted border-border col-span-2 h-1.5 overflow-hidden rounded-sm border" aria-hidden>
            <span className="bg-primary block h-full" style={{ width: `${Math.min(100, (row.count / whole) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

const QUEUE_COLUMNS: Column<QueueRow>[] = [
  { id: 'id', header: 'Issue', width: '8rem', sortValue: row => row.id,
    cell: row => (row.href ? <a href={row.href} target="_blank" rel="noreferrer" className="text-primary! font-mono text-xs underline-offset-4 hover:underline!">{row.id}</a> : <span className="font-mono text-xs">{row.id}</span>) },
  { id: 'title', header: 'Title', cell: row => <span className="block min-w-[14rem] text-[13px] whitespace-normal">{row.title}</span> },
  { id: 'priority', header: 'Priority', width: '6.5rem', sortValue: row => queuePriorityRank(row.priority),
    cell: row => <span className={cn('text-xs', queuePriorityRank(row.priority) <= 1 && 'text-warning')}>{row.priority}</span> },
  { id: 'status', header: 'Status', width: '7.5rem', sortValue: row => row.status, cell: row => <span className="text-muted-foreground text-xs">{row.status}</span> },
  { id: 'idle', header: 'Idle', numeric: true, width: '4.5rem', sortValue: row => row.idleDays ?? -1, cell: row => row.idle || '—' },
];

export function QueueCard({ queue }: { queue: BriefingQueue }) {
  const snapshot = /^stale\b/i.test(queue.note);
  const longest = queue.rows.reduce((n, row) => Math.max(n, row.idleDays ?? 0), 0);
  // Highest first, then longest idle, which is the producer's own order; the table keeps it until re-sorted.
  const rows = useMemo(() => [...queue.rows].sort((a, b) => queuePriorityRank(a.priority) - queuePriorityRank(b.priority) || (b.idleDays ?? -1) - (a.idleDays ?? -1)), [queue.rows]);
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Jira queue</CardTitle>
        <CardDescription>Open Work issues, highest priority first and then longest idle.</CardDescription>
        {snapshot ? <CardAction><Badge variant="soft-warning">stale snapshot</Badge></CardAction> : null}
      </CardHeader>
      <StatGroup className="border-border border-y">
        <Stat label="Open" value={queue.open} caption={queue.stages.length ? queue.stages.map(stage => `${stage.count} ${stage.label}`).join(' · ') : 'issues in the queue'} />
        <Stat label="High & highest" value={queue.high} tone={queue.high ? 'warning' : 'default'} caption={queue.open ? `${Math.round((queue.high / queue.open) * 100)}% of the queue` : 'nothing open'} />
        <Stat label="Idle 14 days+" value={queue.stale} tone={queue.stale ? 'warning' : 'default'} caption={longest ? `longest idle ${longest}d` : 'nothing idle'} />
      </StatGroup>
      {queue.stages.length || queue.note ? (
        <div className="grid gap-6 p-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          {queue.stages.length ? (
            <div className="grid content-start gap-3">
              <h3 className={LABEL}>By stage</h3>
              <ShareRows rows={queue.stages} total={queue.open} label="Open issues by stage" />
            </div>
          ) : null}
          {queue.note ? (
            <div className="grid content-start gap-3">
              <h3 className={LABEL}>About this snapshot</h3>
              <p className={cn('max-w-[75ch] text-[13px] leading-relaxed', snapshot ? 'text-warning' : 'text-muted-foreground')}>{queue.note}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {rows.length ? (
        <div className="border-border border-t">
          <DataTable columns={QUEUE_COLUMNS} rows={rows} getRowId={row => row.id} limit={8} caption={`Jira queue, ${plural(rows.length, 'issue')}`} />
        </div>
      ) : null}
    </Card>
  );
}

const CANDIDATE_COLUMNS: Column<CleanupCandidate>[] = [
  { id: 'sender', header: 'Sender', sortValue: row => row.sender, cell: row => <span className="block min-w-[10rem] font-mono text-xs break-all whitespace-normal">{row.sender}</span> },
  { id: 'domain', header: 'Area', width: '6rem', sortValue: row => row.domain, cell: row => <span className="text-muted-foreground text-xs">{row.domain}</span> },
  { id: 'reason', header: 'Why it is a candidate', cell: row => <span className="block min-w-[14rem] text-[13px] whitespace-normal">{row.reason}</span> },
];

export function InboxCard({ inbox, candidates }: { inbox: InboxSignal; candidates: CleanupCandidate[] }) {
  const historical = stale(inbox.windowLabel);
  const actions = [...new Set(candidates.map(row => row.action).filter(Boolean))];
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Inbox signal</CardTitle>
        <CardDescription>{inbox.windowLabel || 'The Work inbox over the briefing window.'}</CardDescription>
        {historical ? <CardAction><Badge variant="soft-warning">not refreshed</Badge></CardAction> : null}
      </CardHeader>
      {inbox.figures.length ? (
        <StatGroup className="border-border border-y">
          {inbox.figures.map(figure => <Stat key={figure.label} label={figure.label} value={figure.n} tone={figure.hot ? 'warning' : 'default'} caption={figure.hint || undefined} />)}
        </StatGroup>
      ) : null}
      <div className="grid gap-6 p-4 md:grid-cols-2">
        {inbox.classes.length ? (
          <div className="grid content-start gap-3">
            <h3 className={LABEL}>How {inbox.total || 'the'} messages sort</h3>
            <ShareRows rows={inbox.classes} total={inbox.total} label="Messages by class" />
          </div>
        ) : null}
        {inbox.senders.length ? (
          <div className="grid content-start gap-3">
            <h3 className={LABEL}>Highest-volume senders</h3>
            <ol className="grid gap-1.5">
              {inbox.senders.slice(0, 8).map(sender => (
                <li key={sender.address} className="grid grid-cols-[minmax(0,1fr)_3rem] gap-3">
                  <span className="min-w-0 truncate font-mono text-xs" title={sender.address}>{sender.address}</span>
                  <span className="text-right font-mono text-xs tabular-nums">{sender.count}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
      {inbox.note || candidates.length ? (
        <div className="border-border grid gap-2 border-t px-4 py-3">
          {inbox.note ? (
            <Disclosure title="Triage notes" className="text-xs">
              <p className="text-muted-foreground max-w-[80ch] text-[13px] leading-relaxed">{inbox.note}</p>
            </Disclosure>
          ) : null}
          {candidates.length ? (
            <Disclosure title={`${plural(candidates.length, 'cleanup candidate')} to decide on`} className="text-xs" contentClassName="grid gap-3">
              <p className="text-muted-foreground text-xs leading-relaxed">
                Suggestions only{actions.length === 1 ? `: ${actions[0].charAt(0).toLowerCase()}${actions[0].slice(1)}` : '; nothing has been unsubscribed, moved or deleted.'}
              </p>
              <div className="border-border overflow-hidden rounded-[var(--radius-card)] border">
                <DataTable columns={CANDIDATE_COLUMNS} rows={candidates} getRowId={row => row.key} limit={10} caption="Cleanup and unsubscribe candidates" />
              </div>
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

const COVERAGE_TONE = {
  complete: { dot: 'bg-primary', text: 'text-foreground' },
  partial: { dot: 'bg-warning', text: 'text-warning' },
  missing: { dot: 'bg-destructive', text: 'text-destructive' },
} as const;
const at = (value: string) => (Number.isFinite(Date.parse(value)) ? reportDate(value) : value);

export function SourcesCard({ coverage }: { coverage: CoverageRow[] }) {
  const tones = coverage.map(row => coverageTone(row.status));
  const complete = tones.filter(tone => tone === 'complete').length;
  const missing = tones.filter(tone => tone === 'missing').length;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Sources and coverage</CardTitle>
        <CardDescription>
          {complete} of {plural(coverage.length, 'source')} read in full for this briefing{coverage.length - complete - missing ? `, ${coverage.length - complete - missing} partial or stale` : ''}{missing ? `, ${missing} unavailable` : ''}.
        </CardDescription>
      </CardHeader>
      <ul className="divide-border border-border divide-y border-t">
        {coverage.map((row, index) => (
          <li key={row.key} className="grid gap-x-6 gap-y-1.5 px-4 py-3 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            <div className="grid content-start justify-items-start gap-1.5">
              <span className="text-sm font-semibold">{row.source}</span>
              <span className={cn('flex items-baseline gap-2 text-xs leading-snug', COVERAGE_TONE[tones[index]].text)}>
                <i aria-hidden className={cn('size-1.5 shrink-0 translate-y-[-1px] rounded-full', COVERAGE_TONE[tones[index]].dot)} />{row.status}
              </span>
            </div>
            <div className="grid content-start gap-1">
              {row.detail ? <p className="text-muted-foreground max-w-[80ch] text-[13px] leading-relaxed">{row.detail}</p> : null}
              {row.agent || row.at ? <span className="text-muted-foreground/80 font-mono text-[10.5px]">{[row.agent, row.at && at(row.at)].filter(Boolean).join(' · ')}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The page

function BriefingStatus({ report, briefing }: { report: StoredReport; briefing: Briefing }) {
  const gaps = briefing.coverage.filter(row => coverageTone(row.status) !== 'complete').length;
  return (
    <div className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-card)] border px-4 py-3">
      <StatusBadge status={report.status === 'failed' ? 'failed' : report.status === 'partial' ? 'incomplete' : 'validated'}>{statusLabel(report.status)}</StatusBadge>
      <strong className="text-sm font-semibold">{briefing.dateLabel || report.title}</strong>
      <span className="text-muted-foreground font-mono text-[11px]">Published {briefing.timeLabel || reportDate(report.produced_at)}</span>
      {gaps ? <a href="#briefing-sources" className="text-warning! text-xs font-medium underline! decoration-current/40! underline-offset-4">{plural(gaps, 'source')} partial or unavailable</a> : null}
      {report.html ? (
        <Button variant="ghost" size="sm" className="text-muted-foreground ml-auto" asChild>
          <a href={`/api/artifacts/${report.id}`} target="_blank" rel="noreferrer">Published report<ArrowUpRightIcon aria-hidden /></a>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The daily briefing drawn from its structured payload: what needs you today beside the shape of your
 * day, the standup ready to paste, then everything else by area, the Jira queue, the inbox and the
 * sources behind it. The authored HTML is never inserted here; it stays on the sandboxed artifact route.
 */
export function DailyBriefing({ report, briefing, standup }: { report: StoredReport; briefing: Briefing; standup?: StoredReport }) {
  const jumps = [
    { anchor: 'briefing-today', label: 'Today' },
    { anchor: 'briefing-standup', label: 'Standup' },
    { anchor: 'briefing-items', label: 'All items' },
    ...(briefing.queue ? [{ anchor: 'briefing-queue', label: 'Jira queue' }] : []),
    ...(briefing.inbox ? [{ anchor: 'briefing-inbox', label: 'Inbox' }] : []),
    ...(briefing.coverage.length ? [{ anchor: 'briefing-sources', label: 'Sources' }] : []),
  ];
  return (
    <>
      <BriefingStatus report={report} briefing={briefing} />
      {briefing.notice ? (
        <Alert variant="warning">
          <AlertTitle>From the producer</AlertTitle>
          <AlertDescription><p>{briefing.notice}</p></AlertDescription>
        </Alert>
      ) : null}
      <SectionNav label="Briefing sections" jumps={jumps} />
      <div id="briefing-today" className="grid min-w-0 scroll-mt-28 items-start gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section aria-label="Focus today" className="grid min-w-0"><FocusCard briefing={briefing} /></section>
        <div className="grid min-w-0 gap-6">
          {briefing.week ? <section aria-label="Your day" className="grid min-w-0"><DayCard week={briefing.week} /></section> : null}
          <section id="briefing-standup" aria-label="Standup" className="grid min-w-0 scroll-mt-28"><StandupCard standup={standup} /></section>
        </div>
      </div>
      <section id="briefing-items" aria-label="Everything in the briefing" className="grid min-w-0 scroll-mt-28"><ItemsCard domains={briefing.domains} /></section>
      {briefing.queue ? <section id="briefing-queue" aria-label="Jira queue" className="grid min-w-0 scroll-mt-28"><QueueCard queue={briefing.queue} /></section> : null}
      {briefing.inbox ? <section id="briefing-inbox" aria-label="Inbox signal" className="grid min-w-0 scroll-mt-28"><InboxCard inbox={briefing.inbox} candidates={briefing.candidates} /></section> : null}
      {briefing.coverage.length ? <section id="briefing-sources" aria-label="Sources and coverage" className="grid min-w-0 scroll-mt-28"><SourcesCard coverage={briefing.coverage} /></section> : null}
    </>
  );
}
