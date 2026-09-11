'use client';
import { useRouter } from 'next/navigation';
import type { StoredReport } from '@/lib/contracts';
import { ReportFrame } from './report-frame';
import { PageHeader } from './page-header';
import { Workspace } from './workspace';
import { Card, CardContent } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { CopyButton, EmptyState, StatusBadge } from './kit';

const date = (value: string) =>
  new Date(value).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const statusLabel = (status: StoredReport['status']) =>
  status === 'partial' ? 'Partial coverage' : status === 'failed' ? 'Run failed' : 'Published';

export function ReportView({ title, empty, history, report }: { title: string; empty: string; history: StoredReport[]; report?: StoredReport }) {
  const router = useRouter();
  const markdown = typeof report?.payload?.markdown === 'string' ? report.payload.markdown : '';

  return (
    <Workspace>
      <PageHeader
        eyebrow="Personal observatory"
        title={title}
        actions={
          !!history.length && (
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
          )
        }
      />

      {!report ? (
        <EmptyState title="No published reports yet" description={empty} />
      ) : (
        <>
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

          {report.html ? (
            <ReportFrame key={report.id} id={report.id} title={report.title} />
          ) : (
            <Card>
              <CardContent className="grid gap-2">
                {markdown ? (
                  markdown.split('\n').map((line, index) =>
                    /^(#{1,3} |Yesterday|Potential priorities|Blockers)/.test(line) ? (
                      <h2 key={index} className="mt-3 text-base font-semibold tracking-tight first:mt-0">
                        {line.replace(/^#+ /, '')}
                      </h2>
                    ) : /^[-*] /.test(line) ? (
                      <p key={index} className="text-muted-foreground border-border border-l-2 pl-3 text-sm leading-relaxed">
                        {line.slice(2)}
                      </p>
                    ) : (
                      <p key={index} className="text-muted-foreground max-w-[74ch] text-sm leading-relaxed">
                        {line || '\u00a0'}
                      </p>
                    )
                  )
                ) : (
                  <p className="text-muted-foreground text-sm">
                    This revision contains structured data without a rendered report.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </Workspace>
  );
}
