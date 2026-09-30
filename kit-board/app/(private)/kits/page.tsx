import Link from 'next/link';
import { boardEndpoints, kits, schedules } from '@/lib/kits';
import { latestByKind } from '@/lib/db';
import { kitReads } from '@/lib/kit-reads';
import { requireSession } from '@/lib/auth';
import { contractStatus, type StoredBody } from '@/lib/contract-status';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Button } from '@/components/ui/button';
import { KitCard } from '@/components/kit';
import { EndpointTable, EnforcementBadge, ScheduleTable } from '@/components/kit-docs';

export default async function Kits() {
  await requireSession();
  const [reports, bodies] = await Promise.all([latestByKind(), kitReads.recentReportBodies()]);
  const rows = bodies as unknown as StoredBody[];

  return (
    <Workspace width="dashboard">
      <PageHeader
        eyebrow="Board and kits"
        title="Kits"
        description="Each kit is the producer side of one section: the contract its reports follow, the endpoints it calls, the jobs that run it, and the files to download. The board keeps storage, rendering and credentials."
      />

      <section aria-label="Kits" className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {kits.map(kit => {
          const statuses = kit.reports.flatMap(report => report.kind === 'usage' ? [] : [contractStatus(report.kind, rows)]);
          const checked = statuses.reduce((sum, status) => sum + status.checked, 0);
          const matched = statuses.reduce((sum, status) => sum + status.matched, 0);
          return (
            <KitCard
              key={kit.id}
              enabled
              name={kit.title}
              cadence={kit.extracted ? `${kit.directory}/` : `${kit.directory}/ · not yet extracted`}
              description={kit.summary}
              figures={[
                ...(statuses.length ? [{ label: 'Recent revisions matching', value: checked ? `${matched}/${checked}` : '—', tone: checked && matched < checked ? 'destructive' as const : 'default' as const }] : []),
                { label: 'Endpoints', value: kit.endpoints.length },
                { label: 'Downloads', value: kit.downloads.length },
              ]}
              status={kit.reports.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {kit.reports.map(report => (
                    <span key={report.kind} className="inline-flex items-center gap-1.5 font-mono text-[11px]">
                      {report.contract} <EnforcementBadge enforcement={report.enforcement} />
                    </span>
                  ))}
                </div>
              ) : <span className="text-muted-foreground text-xs">No report contract yet</span>}
              actions={
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline"><Link href={kit.page.path}>Open {kit.page.path}</Link></Button>
                  <Button asChild size="sm"><Link href={`/kits/${kit.id}`}>Open the kit</Link></Button>
                </div>
              }
            />
          );
        })}
      </section>

      <ScheduleTable schedules={schedules} reports={reports as unknown as { kind: string; produced_at: string }[]} showKit />

      <EndpointTable
        title="Board APIs"
        description="Routes the board keeps for itself: sign-in, sandboxed report HTML, and agent routing, which has no kit."
        endpoints={boardEndpoints}
      />
    </Workspace>
  );
}
