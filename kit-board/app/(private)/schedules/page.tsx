import Link from 'next/link';
import { schedules, sections } from '@/lib/catalog';
import { database, latestByKind } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
export default async function Schedules() {
  await requireSession();
  const [reports, collectors] = await Promise.all([latestByKind(), database()`SELECT s.id, s.machine_label, s.mode, s.disabled, s.last_seen_at, a.label
    FROM personal_hub.telemetry_sources s JOIN personal_hub.usage_accounts a ON a.id = s.account_id ORDER BY s.created_at`]);
  return <div className="schedules-workspace"><PageHeader eyebrow="America / Chicago" title="Schedules" actions={<Badge variant="outline" className="storage-badge"><i/> Shared report history</Badge>}/>
    <p className="schedule-intro">Independent jobs. One place for their reports.</p>
    <div className="schedule-table" role="table" aria-label="Report schedules"><div className="schedule-row schedule-table-head" role="row"><span>Report</span><span>Schedule · Central time</span><span>Latest observation</span><span>Publishing</span></div>
      {schedules.map(job => { const report = reports.find(row => row.kind === job.kind); return <div className="schedule-row" role="row" key={job.kind}><div><Link href={sections.find(section => section.kind === job.kind)!.path}>{job.name} <span aria-hidden="true">↗</span></Link><small>{job.owner}</small></div><span>{job.cadence}</span><span>{report ? new Date(report.produced_at as string).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'No report received'}</span><span className="schedule-state">{job.connected ? 'Connected' : 'Setup pending'}</span></div>; })}
    </div><p className="schedule-note">The schedule belongs to each original task. Connected means its publisher is configured; the latest observation shows the report actually received. The readings relay and other local jobs need this Mac available. Reports from the other computer are copied from the old usage site daily at 18:00 UTC until its uploader is switched.</p>
    <h2 className="schedule-intro">Usage collection & reset feeds</h2>
    <div className="schedule-table" role="table" aria-label="Usage collection schedules"><div className="schedule-row schedule-table-head" role="row"><span>Collector</span><span>Cadence</span><span>Last upload</span><span>Status</span></div>
      {collectors.map(source => <div className="schedule-row" role="row" key={source.id as string}><div><Link href="/usage/connections">{source.label as string} ↗</Link><small>{source.machine_label as string}</small></div><span>Hourly · {source.mode === 'browser' ? 'browser open' : 'machine available'}</span><span>{source.last_seen_at ? new Date(source.last_seen_at as string).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Awaiting first reading'}</span><span className="schedule-state">{source.disabled ? 'Disabled' : source.last_seen_at ? 'Receiving data' : 'Pairing pending'}</span></div>)}
      <div className="schedule-row" role="row"><div><Link href="/usage/resets">Public reset feeds ↗</Link><small>Codex Reset & Reset Radar</small></div><span>Daily · 13:15 UTC; hourly local checks</span><span><Link href="/usage/resets">View feed health</Link></span><span className="schedule-state">Script only</span></div>
    </div><p className="schedule-note">These collectors use no AI calls. Hourly is the configured default; the last upload confirms receipt, not continuous coverage. Local scripts catch up after sleep. Browser collection requires pairing the account and keeping a signed-in Claude tab open. Opening Reset intelligence also checks the cached public feeds.</p>
  </div>;
}
