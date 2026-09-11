import Link from 'next/link';
import { schedules, sections } from '@/lib/catalog';
import { database, latestByKind } from '@/lib/db';
import { requireSession } from '@/lib/auth';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/kit';

const stamp = (value: string | null) =>
  value
    ? new Date(value).toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

export default async function Schedules() {
  await requireSession();
  const [reports, collectors] = await Promise.all([
    latestByKind(),
    database()`SELECT s.id, s.machine_label, s.mode, s.disabled, s.last_seen_at, a.label
    FROM personal_hub.telemetry_sources s JOIN personal_hub.usage_accounts a ON a.id = s.account_id ORDER BY s.created_at`,
  ]);

  return (
    <Workspace>
      <PageHeader
        eyebrow="America / Chicago"
        title="Schedules"
        description="Independent jobs, one place for their reports. The schedule belongs to each original task; connected means its publisher is configured, while the latest observation shows the report actually received."
        actions={<Badge variant="outline">Shared report history</Badge>}
      />

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Report schedules</CardTitle>
          <CardDescription>
            The readings relay and other local jobs need this Mac available.
          </CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="bg-card uppercase">Report</TableHead>
              <TableHead className="bg-card uppercase">Schedule · Central time</TableHead>
              <TableHead className="bg-card uppercase">Latest observation</TableHead>
              <TableHead className="bg-card uppercase">Publishing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map(job => {
              const report = reports.find(row => row.kind === job.kind);
              const observed = stamp((report?.produced_at as string) ?? null);
              return (
                <TableRow key={job.kind} className="even:bg-foreground/[0.03] border-b-0">
                  <TableCell className="py-2">
                    <Link
                      href={sections.find(section => section.kind === job.kind)!.path}
                      className="hover:text-primary font-semibold underline-offset-4 hover:underline"
                    >
                      {job.name}
                    </Link>
                    <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">
                      {job.owner}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground py-2 whitespace-normal">
                    {job.cadence}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs">
                    {observed ?? <span className="text-muted-foreground">No report received</span>}
                  </TableCell>
                  <TableCell className="py-2">
                    {job.connected ? (
                      <StatusBadge status="validated">Connected</StatusBadge>
                    ) : (
                      <StatusBadge status="never-run">Setup pending</StatusBadge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Usage collection &amp; reset feeds</CardTitle>
          <CardDescription>
            These collectors use no AI calls. Hourly is the configured default; the last upload
            confirms receipt, not continuous coverage. Local scripts catch up after sleep.
          </CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="bg-card uppercase">Collector</TableHead>
              <TableHead className="bg-card uppercase">Cadence</TableHead>
              <TableHead className="bg-card uppercase">Last upload</TableHead>
              <TableHead className="bg-card uppercase">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collectors.map(source => {
              const seen = stamp((source.last_seen_at as string) ?? null);
              return (
                <TableRow key={source.id as string} className="even:bg-foreground/[0.03] border-b-0">
                  <TableCell className="py-2">
                    <Link
                      href="/usage/connections"
                      className="hover:text-primary font-semibold underline-offset-4 hover:underline"
                    >
                      {source.label as string}
                    </Link>
                    <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">
                      {source.machine_label as string}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground py-2 whitespace-normal">
                    Hourly · {source.mode === 'browser' ? 'browser open' : 'machine available'}
                  </TableCell>
                  <TableCell className="py-2 font-mono text-xs">
                    {seen ?? <span className="text-muted-foreground">Awaiting first reading</span>}
                  </TableCell>
                  <TableCell className="py-2">
                    {source.disabled ? (
                      <StatusBadge status="disabled" />
                    ) : source.last_seen_at ? (
                      <StatusBadge status="validated">Receiving data</StatusBadge>
                    ) : (
                      <StatusBadge status="never-run">Pairing pending</StatusBadge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow className="even:bg-foreground/[0.03] border-b-0">
              <TableCell className="py-2">
                <Link
                  href="/usage/resets"
                  className="hover:text-primary font-semibold underline-offset-4 hover:underline"
                >
                  Public reset feeds
                </Link>
                <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">
                  Codex Reset &amp; Reset Radar
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground py-2 whitespace-normal">
                Daily · 13:15 UTC; hourly local checks
              </TableCell>
              <TableCell className="py-2">
                <Link href="/usage/resets" className="text-primary text-xs underline-offset-4 hover:underline">
                  View feed health
                </Link>
              </TableCell>
              <TableCell className="py-2">
                <Badge variant="outline">Script only</Badge>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <p className="text-muted-foreground max-w-[80ch] text-sm leading-relaxed">
        Browser collection requires pairing the account and keeping a signed-in Claude tab open.
        Opening Reset intelligence also checks the cached public feeds. Reports from the other
        computer are copied from the old usage site daily at 18:00 UTC until its uploader is
        switched.
      </p>
    </Workspace>
  );
}
