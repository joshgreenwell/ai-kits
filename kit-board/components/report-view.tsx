'use client';
import { useRouter } from 'next/navigation';
import type { StoredReport } from '@/lib/contracts';
import { ReportFrame } from './report-frame';
import { PageHeader } from './page-header';
import { Workspace } from './workspace';
import { Card, CardContent } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { CopyButton, EmptyState, Prose, StatusBadge } from './kit';

const date = (value: string) =>
  new Date(value).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export const statusLabel = (status: StoredReport['status']) =>
  status === 'partial' ? 'Partial coverage' : status === 'failed' ? 'Run failed' : 'Published';

export const markdownOf = (report: StoredReport) => (typeof report.payload?.markdown === 'string' ? report.payload.markdown : '');

export { date as reportDate };

export function ReportStatus({ report }: { report: StoredReport }) {
  const markdown = markdownOf(report);
  return (
    <div className="border-border flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border px-4 py-3">
      <StatusBadge status={report.status === 'failed' ? 'failed' : report.status === 'partial' ? 'incomplete' : 'validated'}>
        {statusLabel(report.status)}
      </StatusBadge>
      <strong className="text-sm font-semibold">{report.title}</strong>
      <span className="text-muted-foreground font-mono text-[11px]">Observed {date(report.produced_at)}</span>
      {markdown && (
        <CopyButton value={markdown} label="Copy update" variant="outline" className="ml-auto" />
      )}
    </div>
  );
}

export function ReportBody({ report }: { report: StoredReport }) {
  const markdown = markdownOf(report);
  return report.html ? (
    <ReportFrame key={report.id} id={report.id} title={report.title} />
  ) : (
    <Card>
      <CardContent className="py-2">
        {markdown ? (
          <Prose markdown={markdown} />
        ) : (
          <p className="text-muted-foreground text-sm">
            This revision contains structured data without a rendered report.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The history picker both report views put in their header; a choice navigates to `?report=<id>`. */
export function ReportHistory({ history, report }: { history: StoredReport[]; report?: StoredReport }) {
  const router = useRouter();
  return (
    <div className="flex items-center gap-2">
      <span id="report-history-label" className="text-muted-foreground text-xs font-semibold">
        Report history
      </span>
      <Select value={report?.id ?? ''} onValueChange={id => router.push(`?report=${id}`)}>
        <SelectTrigger aria-labelledby="report-history-label" className="w-[240px]">
          <SelectValue>{report ? date(report.produced_at) : 'Choose a report'}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {history.map(item => (
            <SelectItem key={item.id} value={item.id}>
              <span className="grid">
                <strong className="text-sm">{item.title}</strong>
                <small className="text-muted-foreground font-mono text-[11px]">
                  {date(item.produced_at)} · {statusLabel(item.status)}
                </small>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ReportView({ title, empty, history, report }: { title: string; empty: string; history: StoredReport[]; report?: StoredReport }) {
  return (
    <Workspace>
      <PageHeader
        eyebrow="Personal observatory"
        title={title}
        actions={!!history.length && <ReportHistory history={history} report={report} />}
      />

      {!report ? (
        <EmptyState title="No published reports yet" description={empty} />
      ) : (
        <>
          <ReportStatus report={report} />
          <ReportBody report={report} />
        </>
      )}
    </Workspace>
  );
}
