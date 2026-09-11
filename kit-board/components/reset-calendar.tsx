'use client';
import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ResetItem } from '@/lib/reset-feeds';
import { calendarDays, resetDay, resetMarker, resetTypes, shiftMonth } from '@/lib/reset-calendar';

export function ResetCalendar({ items, selectedDay, onSelectDay, busy }: { items: ResetItem[]; selectedDay: string | null; onSelectDay: (day: string | null) => void; busy: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(today.slice(0, 7));
  const byDay = new Map<string, ResetItem[]>();
  for (const item of items) { const day = resetDay(item); byDay.set(day, [...(byDay.get(day) ?? []), item]); }
  const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const legend = resetTypes.filter(type => !['reset', 'credits'].includes(type.value) || items.some(item => resetMarker(item) === type.value));
  function navigate(next: string) { setMonth(next); onSelectDay(null); }
  return <aside className="reset-calendar" aria-label="Reset calendar">
    <div className="reset-calendar-heading"><h2 aria-live="polite">{monthLabel}</h2><div className="reset-calendar-controls">
      <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => navigate(shiftMonth(month, -1))}><ChevronLeft size={15} /></Button>
      <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => navigate(shiftMonth(month, 1))}><ChevronRight size={15} /></Button>
    </div></div>
    <div className="reset-calendar-grid" role="group" aria-label={`${monthLabel} reset history`}>
      {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span className="reset-weekday" key={index}>{day}</span>)}
      {calendarDays(month).map((day, index) => {
        if (!day) return <div key={`blank-${index}`} aria-hidden="true" />;
        const entries = byDay.get(day) ?? [];
        const markers = resetTypes.filter(type => entries.some(item => resetMarker(item) === type.value));
        const description = `${day}${entries.length ? ': ' + entries.map(item => `${item.provider === 'codex' ? 'Codex' : 'Claude'} · ${resetTypes.find(type => type.value === resetMarker(item))?.label} · ${item.status.replaceAll('_', ' ')}`).join('; ') : ', no entries'}`;
        return <button key={day} type="button" className={`reset-day${entries.length ? ' has-events' : ''}${day === today ? ' is-today' : ''}${day === selectedDay ? ' is-selected' : ''}`} aria-pressed={day === selectedDay} aria-current={day === today ? 'date' : undefined} aria-label={description} title={description} onClick={() => onSelectDay(day === selectedDay ? null : day)}>
          <span className="reset-day-number">{Number(day.slice(-2))}</span>
          <span className="reset-day-events" aria-hidden="true">{markers.map(type => <i key={type.value} className={`reset-dot ${type.value}`} />)}</span>
        </button>;
      })}
    </div>
    <div className="reset-calendar-footer"><span>UTC</span><Button variant="ghost" size="sm" onClick={() => navigate(today.slice(0, 7))}>Today</Button>{selectedDay && <Button variant="ghost" size="sm" onClick={() => onSelectDay(null)}>Clear day</Button>}</div>
    <div className="reset-calendar-legend">{legend.map(type => <span key={type.value}><i className={`reset-dot ${type.value}`} />{type.label}</span>)}</div>
    {busy && !items.length && <p className="telemetry-muted">Loading reset history…</p>}
  </aside>;
}
