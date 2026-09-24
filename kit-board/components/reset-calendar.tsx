'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResetMarker } from '@/components/reset-dot';
import type { ResetItem } from '@/lib/reset-feeds';
import { RESET_EVENT_LABELS, RESET_EVENT_TYPES, calendarDays, resetDay, resetEventType, resetPlanned, resetProviderLabel, resetProviderOrder, shiftMonth, type ResetEventType } from '@/lib/reset-calendar';
import { cn } from 'cn';

/** A day fits three markers; past that it shows two and a count, so the cell never widens. */
const DAY_MARKERS = 3;

type Marker = { provider: string; type: ResetEventType; planned: boolean };

const byProviderThenType = (a: Marker, b: Marker) => resetProviderOrder(a.provider) - resetProviderOrder(b.provider) || RESET_EVENT_TYPES.indexOf(a.type) - RESET_EVENT_TYPES.indexOf(b.type);

/** One marker per provider and type on a day, drawn solid when any of its entries was reported. */
function dayMarkers(entries: ResetItem[]): Marker[] {
  const byKey = new Map<string, Marker>();
  for (const item of entries) {
    const type = resetEventType(item), key = `${item.provider}|${type}`;
    const existing = byKey.get(key);
    byKey.set(key, { provider: item.provider, type, planned: (existing?.planned ?? true) && resetPlanned(item) });
  }
  return [...byKey.values()].sort(byProviderThenType);
}

/** "Claude window flush", "Codex forecast": a pair reads as one thing, the way a model's line does in a chart. */
const pairLabel = (provider: string, type: ResetEventType) => `${resetProviderLabel(provider)} ${RESET_EVENT_LABELS[type].toLowerCase()}`;

/** The pairs to name before anything has loaded: the ones a reader looks for. */
const DEFAULT_PAIRS: Marker[] = [
  { provider: 'claude', type: 'window_flush', planned: false },
  { provider: 'codex', type: 'global', planned: false },
  { provider: 'codex', type: 'banked', planned: false },
];

export function ResetCalendar({ items, selectedDay, onSelectDay, busy }: { items: ResetItem[]; selectedDay: string | null; onSelectDay: (day: string | null) => void; busy: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const byDay = new Map<string, ResetItem[]>();
  for (const item of items) { const day = resetDay(item); byDay.set(day, [...(byDay.get(day) ?? []), item]); }
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  // The legend names every provider and type pair the record holds, grouped by provider. A forecast is
  // never reported, so its swatch draws the way it always appears on the calendar.
  const loaded = dayMarkers(items).map(marker => ({ ...marker, planned: marker.type === 'forecast' }));
  const pairs = loaded.length ? loaded : DEFAULT_PAIRS;
  const groups = [...new Set(pairs.map(pair => pair.provider))].map(provider => ({ provider, pairs: pairs.filter(pair => pair.provider === provider) }));
  function navigate(next: string) { setMonth(next); onSelectDay(null); }

  // The aside is the query container, so the grid inside it can ask how wide the calendar is: once it
  // has room the legend moves beside the month as a list, and on a phone it wraps under it.
  return (
    <aside aria-label="Reset calendar" className="@container/calendar border-border bg-card rounded-[var(--radius-card)] border p-4 sm:p-5">
      <div className="grid gap-4 @min-[32rem]/calendar:grid-cols-[minmax(0,25rem)_minmax(12rem,1fr)] @min-[32rem]/calendar:gap-6">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 aria-live="polite" className="text-base font-semibold tracking-tight">{monthLabel}</h2>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => navigate(shiftMonth(month, -1))}><ChevronLeft size={16} /></Button>
              <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => navigate(shiftMonth(month, 1))}><ChevronRight size={16} /></Button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1 @min-[32rem]/calendar:gap-1.5" role="group" aria-label={`${monthLabel} reset history`}>
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
              <span key={index} className="text-muted-foreground pb-1 text-center font-mono text-[11px]">{day}</span>
            ))}
            {calendarDays(month).map((day, index) => {
              if (!day) return <div key={`blank-${index}`} aria-hidden="true" />;
              const entries = byDay.get(day) ?? [];
              const markers = dayMarkers(entries);
              const shown = markers.length > DAY_MARKERS ? markers.slice(0, DAY_MARKERS - 1) : markers;
              const description = `${day}${entries.length ? ': ' + entries.map(item => `${resetProviderLabel(item.provider)} · ${RESET_EVENT_LABELS[resetEventType(item)]} · ${item.status.replaceAll('_', ' ')}`).join('; ') : ', no entries'}`;
              const selected = day === selectedDay;
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  aria-current={day === today ? 'date' : undefined}
                  aria-label={description}
                  title={description}
                  onClick={() => onSelectDay(selected ? null : day)}
                  className={cn(
                    'focus-visible:ring-ring/50 grid aspect-square place-content-center gap-1.5 rounded-md border text-center outline-none transition-colors focus-visible:ring-[3px]',
                    selected
                      ? 'border-primary bg-primary/15 text-foreground'
                      : entries.length
                        ? 'border-border bg-secondary hover:bg-accent text-foreground'
                        : 'hover:bg-accent border-transparent text-muted-foreground',
                    day === today && !selected && 'border-muted-foreground/60'
                  )}
                >
                  <span className={cn('font-mono text-[13px] leading-none tabular-nums', entries.length && 'font-medium')}>{Number(day.slice(-2))}</span>
                  <span className="flex h-[11px] items-center justify-center gap-[3px]" aria-hidden="true">
                    {shown.map(marker => <ResetMarker key={`${marker.provider}|${marker.type}`} type={marker.type} provider={marker.provider} planned={marker.planned} className="@min-[32rem]/calendar:size-[11px]" />)}
                    {shown.length < markers.length ? <span className="text-muted-foreground font-mono text-[9px] leading-none">+{markers.length - shown.length}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="text-muted-foreground mt-3 flex items-center gap-1 font-mono text-[11px]">
            <span className="mr-auto">UTC</span>
            <Button variant="ghost" size="xs" onClick={() => navigate(today.slice(0, 7))}>Today</Button>
            {selectedDay && <Button variant="ghost" size="xs" onClick={() => onSelectDay(null)}>Clear day</Button>}
          </div>
        </div>

        <div className="border-border text-muted-foreground grid content-start gap-4 border-t pt-4 text-xs @min-[32rem]/calendar:border-t-0 @min-[32rem]/calendar:border-l @min-[32rem]/calendar:pt-1 @min-[32rem]/calendar:pl-6" data-testid="reset-legend">
          <dl className="grid gap-4">
            <div className="grid gap-2">
              <dt className="text-[10px] font-semibold tracking-wider uppercase">What happened</dt>
              {groups.map((group, index) => (
                <dd key={group.provider} className={cn('flex flex-wrap gap-x-4 gap-y-2 @min-[32rem]/calendar:grid @min-[32rem]/calendar:gap-2', index > 0 && 'mt-1')}>
                  {group.pairs.map(pair => (
                    <span key={pair.type} className="text-foreground flex items-center gap-2">
                      <ResetMarker type={pair.type} provider={pair.provider} planned={pair.planned} className="size-2.5" />
                      {pairLabel(pair.provider, pair.type)}
                    </span>
                  ))}
                </dd>
              ))}
            </div>
            <div className="grid gap-2">
              <dt className="text-[10px] font-semibold tracking-wider uppercase">How certain</dt>
              <dd className="flex flex-wrap gap-x-4 gap-y-2 @min-[32rem]/calendar:grid @min-[32rem]/calendar:gap-2">
                <span className="text-foreground flex items-center gap-2"><i aria-hidden="true" className="bg-muted-foreground border-muted-foreground inline-block size-2.5 shrink-0 rounded-full border-[1.5px]" />Reported</span>
                <span className="text-foreground flex items-center gap-2"><i aria-hidden="true" className="border-muted-foreground bg-muted-foreground/20 inline-block size-2.5 shrink-0 rounded-full border-[1.5px]" />Announced or forecast</span>
              </dd>
            </div>
          </dl>
          {busy && !items.length && <p>Loading reset history…</p>}
        </div>
      </div>
    </aside>
  );
}
