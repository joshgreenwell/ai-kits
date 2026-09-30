import Link from 'next/link';
import { notFound } from 'next/navigation';
import { endpointContracts, kitById } from '@/lib/kits';
import { latestByKind } from '@/lib/db';
import { kitReads } from '@/lib/kit-reads';
import { requireSession } from '@/lib/auth';
import { contractStatus, type StoredBody } from '@/lib/contract-status';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionNav } from '@/components/kit/section-nav';
import { ContractCard, DownloadTable, EndpointContractCard, EndpointTable, ScheduleTable } from '@/components/kit-docs';
import { CollectorTable } from '@/components/collector-table';

export default async function Kit({ params }: { params: Promise<{ kit: string }> }) {
  await requireSession();
  const kit = kitById((await params).kit);
  if (!kit) notFound();
  const usage = kit.reports.some(report => report.kind === 'usage');
  const [reports, bodies, collectors] = await Promise.all([
    kit.schedules.length ? latestByKind() : Promise.resolve([]),
    kit.reports.some(report => report.kind !== 'usage') ? kitReads.recentReportBodies() : Promise.resolve([]),
    usage ? kitReads.collectorSources() : Promise.resolve([]),
  ]);
  const rows = bodies as unknown as StoredBody[];
  const contracts = endpointContracts(kit);

  const jumps = [
    ...(kit.reports.length || contracts.length ? [{ anchor: 'contracts', label: 'Contracts' }] : []),
    { anchor: 'endpoints', label: 'Endpoints' },
    ...(kit.schedules.length ? [{ anchor: 'schedules', label: 'Schedules' }] : []),
    ...(usage ? [{ anchor: 'collectors', label: 'Collectors' }] : []),
    { anchor: 'downloads', label: 'Downloads' },
  ];

  return (
    <Workspace>
      <PageHeader
        eyebrow={<Link href="/kits" className="underline-offset-4 hover:underline">Kits</Link>}
        title={kit.title}
        description={kit.summary}
        actions={
          <>
            <Badge variant="outline" className="font-mono">{kit.extracted ? `${kit.directory}/` : `${kit.directory}/ · not yet extracted`}</Badge>
            <Button asChild size="sm" variant="outline"><Link href={kit.page.path}>Open {kit.page.path}</Link></Button>
          </>
        }
      />
      <SectionNav label={`${kit.title} kit sections`} jumps={jumps} />

      {kit.reports.length || contracts.length ? (
        <section id="contracts" aria-labelledby="contracts-heading" className="grid scroll-mt-28 gap-4">
          <h2 id="contracts-heading" className="text-base font-semibold">Contracts</h2>
          {kit.reports.map(report => (
            <ContractCard key={report.kind} report={report} status={report.kind === 'usage' ? undefined : contractStatus(report.kind, rows)} />
          ))}
          {contracts.map(contract => <EndpointContractCard key={contract.id} {...contract} />)}
        </section>
      ) : null}

      <EndpointTable id="endpoints" title="Endpoints" endpoints={kit.endpoints} />
      {kit.schedules.length ? <ScheduleTable id="schedules" schedules={kit.schedules} reports={reports as unknown as { kind: string; produced_at: string }[]} /> : null}
      {usage ? <CollectorTable id="collectors" collectors={collectors as unknown as Parameters<typeof CollectorTable>[0]['collectors']} /> : null}
      <DownloadTable id="downloads" downloads={kit.downloads} />
    </Workspace>
  );
}
