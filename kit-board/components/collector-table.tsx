import Link from 'next/link';
import { Badge } from './ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { StatusBadge } from './kit';
import { stamp } from './kit-docs';
import type { CollectorSource } from '@/lib/kit-reads';


/** The usage kit's collectors, and the public reset feeds beside them. */
export function CollectorTable({ id, collectors }: { id?: string; collectors: readonly CollectorSource[] }) {
  return (
    <Card id={id} className="scroll-mt-28 gap-0 overflow-hidden py-0">
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
            const seen = stamp(source.last_seen_at);
            return (
              <TableRow key={source.id} className="even:bg-foreground/[0.03] border-b-0">
                <TableCell className="py-2">
                  <Link href="/settings" className="hover:text-link font-semibold underline-offset-4 hover:underline">{source.label}</Link>
                  <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">{source.machine_label}</span>
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
              <Link href="/usage/allowances#reset-calendar" className="hover:text-link font-semibold underline-offset-4 hover:underline">Public reset feeds</Link>
              <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">Codex Reset &amp; Reset Radar</span>
            </TableCell>
            <TableCell className="text-muted-foreground py-2 whitespace-normal">Daily · 13:15 UTC; hourly local checks</TableCell>
            <TableCell className="py-2">
              <Link href="/settings/feeds" className="text-link text-xs underline-offset-4 hover:underline">View feed health</Link>
            </TableCell>
            <TableCell className="py-2"><Badge variant="outline">Script only</Badge></TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p className="text-muted-foreground border-border border-t p-4 text-sm leading-relaxed">
        Browser collection requires pairing the account and keeping a signed-in Claude tab open.
        Opening Reset intelligence also checks the cached public feeds. Reports from the other
        computer are copied from the old usage site daily at 18:00 UTC until its uploader is
        switched.
      </p>
    </Card>
  );
}
