'use client';
import { useRouter } from 'next/navigation';
import type { StoredReport } from '@/lib/contracts';
import type { DailyDay } from '@/lib/daily-tasks';
import { ReportBody, ReportStatus } from './report-view';
import { PageHeader } from './page-header';
import { Workspace } from './workspace';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { EmptyState } from './kit';

// Period keys are calendar days, so they are formatted without a time-zone shift.
const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

const holds = ({ briefing, standup }: DailyDay) =>
  briefing && standup ? 'Briefing · Standup' : briefing ? 'Briefing only' : 'Standup only';

/** One working day: the standup ready to paste, above the merged daily briefing. */
export function DailyTasksView({ title, empty, days, day, briefing, standup }: {
  title: string; empty: string; days: DailyDay[]; day?: string; briefing?: StoredReport; standup?: StoredReport;
}) {
  const router = useRouter();

  return (
    <Workspace>
      <PageHeader
        eyebrow="Personal observatory"
        title={title}
        actions={
          !!days.length && (
            <div className="flex items-center gap-2">
              <span id="daily-history-label" className="text-muted-foreground text-xs font-semibold">
                Day
              </span>
              <Select value={day ?? ''} onValueChange={value => router.push(`?day=${value}`)}>
                <SelectTrigger aria-labelledby="daily-history-label" className="w-[240px]">
                  <SelectValue>{day ? dayLabel(day) : 'Choose a day'}</SelectValue>
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {days.map(item => (
                    <SelectItem key={item.day} value={item.day}>
                      <span className="grid">
                        <strong className="text-sm">{dayLabel(item.day)}</strong>
                        <small className="text-muted-foreground font-mono text-[11px]">{holds(item)}</small>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        }
      />

      {!briefing && !standup ? (
        <EmptyState title="No published reports yet" description={empty} />
      ) : (
        <>
          {standup ? (
            <section aria-label="Standup" className="grid gap-4">
              <ReportStatus report={standup} />
              <ReportBody report={standup} />
            </section>
          ) : (
            <EmptyState className="p-4" title="No standup for this day" description="The standup publishes on weekdays." />
          )}
          {briefing ? (
            <section aria-label="Daily briefing" className="grid gap-4">
              <ReportStatus report={briefing} />
              <ReportBody report={briefing} />
            </section>
          ) : (
            <EmptyState className="p-4" title="No briefing for this day" description="The daily briefing publishes every morning." />
          )}
        </>
      )}
    </Workspace>
  );
}
