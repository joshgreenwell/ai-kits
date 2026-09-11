'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StoredReport } from '@/lib/contracts';
import { ReportFrame } from './report-frame';
import { PageHeader } from './page-header';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Button } from './ui/button';

const date = (value: string) => new Date(value).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export function ReportView({ title, empty, history, report }: { title: string; empty: string; history: StoredReport[]; report?: StoredReport }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const markdown = typeof report?.payload?.markdown === 'string' ? report.payload.markdown : '';
  return <div className="report-workspace">
    <PageHeader eyebrow="Personal observatory" title={title} actions={!!history.length && <div className="history-control"><span id="report-history-label">Report history</span>
      <Select value={report?.id ?? ''} onValueChange={id => router.push(`?report=${id}`)}>
        <SelectTrigger aria-labelledby="report-history-label"><SelectValue>{report ? date(report.produced_at) : 'Choose a report'}</SelectValue></SelectTrigger>
        <SelectContent position="popper" align="end">{history.map(item => <SelectItem key={item.id} value={item.id}><span className="history-option"><strong>{item.title}</strong><small>{date(item.produced_at)} · {item.status === 'partial' ? 'Partial coverage' : item.status === 'failed' ? 'Run failed' : 'Published'}</small></span></SelectItem>)}</SelectContent>
      </Select>
    </div>}/>
    {!report ? <section className="portal-empty"><span className="empty-orbit" aria-hidden="true">○</span><h2>No published reports yet</h2><p>{empty}</p></section> : <>
      <div className="report-meta"><span className={`status-dot ${report.status}`} aria-hidden="true"/><strong>{report.title}</strong><span>{report.status === 'partial' ? 'Partial coverage' : report.status === 'failed' ? 'Run failed' : 'Published'}</span><span>Observed {date(report.produced_at)}</span>
        {markdown && <Button variant="outline" className="copy-button" onClick={async () => { try { await navigator.clipboard.writeText(markdown); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy update'}</Button>}
      </div>
      {report.html ? <ReportFrame key={report.id} id={report.id} title={report.title}/> : markdown ? <article className="standup-card">{markdown.split('\n').map((line, index) => /^(#{1,3} |Yesterday|Potential priorities|Blockers)/.test(line) ? <h2 key={index}>{line.replace(/^#+ /, '')}</h2> : /^[-*] /.test(line) ? <p key={index} className="standup-bullet">{line.slice(2)}</p> : <p key={index}>{line || '\u00a0'}</p>)}</article> : <article className="standup-card"><p>This revision contains structured data without a rendered report.</p></article>}
    </>}
  </div>;
}
