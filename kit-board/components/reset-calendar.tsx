'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResetDot } from '@/components/reset-dot';
import type { ResetItem } from '@/lib/reset-feeds';
import { calendarDays, resetDay, resetMarker, resetTypes, shiftMonth } from '@/lib/reset-calendar';
import { cn } from 'cn';

export function ResetCalendar({ items, selectedDay, onSelectDay, busy }: { items: ResetItem[]; selectedDay: string | null; onSelectDay: (day: string | null) => void; busy: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const byDay = new Map<string, ResetItem[]>();
  for (const item of items) { const day = resetDay(item); byDay.set(day, [...(byDay.get(day) ?? []), item]); }
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const legend = resetTypes.filter(type => !['reset', 'credits'].includes(type.value) || items.some(item => resetMarker(item) === type.value));
  function navigate(next: string) { setMonth(next); onSelectDay(null); }

  return (
    <aside aria-label="Reset calendar" className="border-border bg-card rounded-[var(--radius-card)] border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 aria-live="polite" className="text-sm font-semibold tracking-tight">{monthLabel}</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => navigate(shiftMonth(month, -1))}><ChevronLeft size={15} /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => navigate(shiftMonth(month, 1))}><ChevronRight size={15} /></Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1" role="group" aria-label={`${monthLabel} reset history`}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
          <span key={index} className="text-muted-foreground pb-1 text-center font-mono text-[10px]">{day}</span>
        ))}
        {calendarDays(month).map((day, index) => {
          if (!day) return <div key={`blank-${index}`} aria-hidden="true" />;
          const entries = byDay.get(day) ?? [];
          const markers = resetTypes.filter(type => entries.some(item => resetMarker(item) === type.value));
          const description = `${day}${entries.length ? ': ' + entries.map(item => `${item.provider === 'codex' ? 'Codex' : 'Claude'} · ${resetTypes.find(type => type.value === resetMarker(item))?.label} · ${item.status.replaceAll('_', ' ')}`).join('; ') : ', no entries'}`;
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
                'focus-visible:ring-ring/50 grid aspect-square place-content-center gap-1 rounded-md border text-center outline-none transition-colors focus-visible:ring-[3px]',
                selected
                  ? 'border-primary bg-primary/15 text-foreground'
                  : entries.length
                    ? 'border-border bg-secondary hover:bg-accent text-foreground'
                    : 'hover:bg-accent border-transparent text-muted-foreground',
                day === today && !selected && 'border-muted-foreground/60'
              )}
            >
              <span className="font-mono text-[11px] tabular-nums">{Number(day.slice(-2))}</span>
              <span className="flex h-[6px] items-center justify-center gap-[3px]" aria-hidden="true">
                {markers.map(type => <ResetDot key={type.value} marker={type.value} />)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="text-muted-foreground mt-3 flex items-center gap-1 font-mono text-[10px]">
        <span className="mr-auto">UTC</span>
        <Button variant="ghost" size="xs" onClick={() => navigate(today.slice(0, 7))}>Today</Button>
        {selectedDay && <Button variant="ghost" size="xs" onClick={() => onSelectDay(null)}>Clear day</Button>}
      </div>

      <div className="border-border text-muted-foreground mt-3 flex flex-wrap gap-x-3 gap-y-1.5 border-t pt-3 text-[10px]">
        {legend.map(type => (
          <span key={type.value} className="flex items-center gap-1.5"><ResetDot marker={type.value} />{type.label}</span>
        ))}
      </div>

      {busy && !items.length && <p className="text-muted-foreground mt-3 text-xs">Loading reset history…</p>}
    </aside>
  );
}
