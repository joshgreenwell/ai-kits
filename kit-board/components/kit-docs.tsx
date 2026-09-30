import Link from 'next/link';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { kitById, reportContract, sectionPath, type Download, type Endpoint, type EndpointAuth, type KitReport, type Schedule } from '@/lib/kits';
import { sourceLinks } from '@/lib/kits/source';
import { contractFields } from '@/lib/contract-fields';
import type { ContractStatus } from '@/lib/contract-status';
import { reportContractRegistry, type ReportContractId } from '@/lib/report-contracts';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { CopyButton, Disclosure, StatusBadge, TerminalBlock } from './kit';
import { ContractValidatorForm } from './contract-validator-form';

/*
 * The documentation blocks /kits and /kits/[kit] share. Every fact comes from the kit manifests in
 * lib/kits/ and the contract registry, so the page cannot describe an endpoint the board does not serve.
 */

const authLabels: Record<EndpointAuth, string> = {
  session: 'Signed-in session',
  producer: 'Producer key',
  'producer-or-session': 'Producer key or session',
  install: 'Companion install key',
  'pairing-code': 'One-time pairing code',
  telemetry: 'Telemetry key',
  'telemetry-or-session': 'Telemetry key or session',
  cron: 'Cron secret',
  public: 'None',
};

const head = 'bg-card uppercase';
const row = 'even:bg-foreground/[0.03] border-b-0';
const link = 'hover:text-primary font-semibold underline-offset-4 hover:underline';

export const stamp = (value: Date | string | null | undefined) =>
  value ? new Date(value).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;

export function EnforcementBadge({ enforcement }: { enforcement: KitReport['enforcement'] }) {
  return enforcement === 'enforce'
    ? <Badge variant="soft">Enforced</Badge>
    : <Badge variant="soft-info">Observed</Badge>;
}

/** A card section whose table scrolls inside it. */
function TableCard({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-28 gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {children}
    </Card>
  );
}

export function EndpointTable({ id, title, description, endpoints }: { id?: string; title: string; description?: ReactNode; endpoints: readonly Endpoint[] }) {
  return (
    <TableCard id={id} title={title} description={description}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={head}>Endpoint</TableHead>
            <TableHead className={head}>Credential</TableHead>
            <TableHead className={head}>What it does</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {endpoints.map(endpoint => (
            <TableRow key={`${endpoint.method} ${endpoint.path}`} className={row}>
              <TableCell className="py-2 font-mono text-xs">
                <span className="text-muted-foreground mr-2 inline-block w-12">{endpoint.method}</span>{endpoint.path}
              </TableCell>
              <TableCell className="py-2 text-xs">
                {authLabels[endpoint.auth]}
                {endpoint.scope ? <span className="text-muted-foreground block font-mono text-[11px]">scope {endpoint.scope}</span> : null}
              </TableCell>
              <TableCell className="text-muted-foreground py-2 whitespace-normal">
                {endpoint.summary}
                {endpoint.contract ? <span className="block font-mono text-[11px]">{endpoint.contract}</span> : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}

type Observation = { kind: string; produced_at: Date | string };

export function ScheduleTable({ id, schedules, reports, showKit = false }: { id?: string; schedules: readonly Schedule[]; reports: readonly Observation[]; showKit?: boolean }) {
  return (
    <TableCard id={id} title="Report schedules" description="Each schedule belongs to its original task; connected means its publisher is configured, while the latest observation shows the report actually received. The readings task and other local jobs need this Mac available.">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={head}>Report</TableHead>
            <TableHead className={head}>Schedule · Central time</TableHead>
            <TableHead className={head}>Latest observation</TableHead>
            <TableHead className={head}>Publishing</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {schedules.map(job => {
            const observed = stamp(reports.find(report => report.kind === job.kind)?.produced_at);
            const kit = showKit ? kitById(reportContract(job.kind).kit) : undefined;
            return (
              <TableRow key={job.source} className={row}>
                <TableCell className="py-2">
                  <Link href={sectionPath(job.kind)} className={link}>{job.name}</Link>
                  <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">
                    {job.owner}
                    {kit ? <> · <Link href={`/kits/${kit.id}`} className="underline-offset-4 hover:underline">{kit.title} kit</Link></> : null}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground py-2 whitespace-normal">{job.cadence}</TableCell>
                <TableCell className="py-2 font-mono text-xs">{observed ?? <span className="text-muted-foreground">No report received</span>}</TableCell>
                <TableCell className="py-2">
                  {job.connected ? <StatusBadge status="validated">Connected</StatusBadge> : <StatusBadge status="never-run">Setup pending</StatusBadge>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableCard>
  );
}

/** A repository path as links: the GitHub page, and for a file its raw copy. */
export function SourceLinks({ path, label }: { path: string; label?: string }) {
  const links = sourceLinks(path);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-3">
      <a href={links.view} target="_blank" rel="noreferrer" className={link}>{label ?? path.split('/').pop()}</a>
      {links.raw ? <a href={links.raw} target="_blank" rel="noreferrer" className="text-muted-foreground text-xs underline-offset-4 hover:underline">raw</a> : null}
    </span>
  );
}

export function DownloadTable({ id, downloads }: { id?: string; downloads: readonly Download[] }) {
  return (
    <TableCard id={id} title="Downloads" description="Links go to the public repository at the commit this board was built from.">
      <Table>
        <TableBody>
          {downloads.map(download => (
            <TableRow key={download.path} className={row}>
              <TableCell className="py-2">
                <SourceLinks path={download.path} label={download.label} />
                <span className="text-muted-foreground mt-0.5 block font-mono text-[11px]">{download.path}</span>
              </TableCell>
              <TableCell className="text-muted-foreground py-2 whitespace-normal">{download.summary}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}

/** How a kind's recent revisions compare with its contract. */
export function ContractHealth({ status }: { status: ContractStatus | undefined }) {
  if (!status?.checked) return <p className="text-muted-foreground text-sm">No revision is stored yet, so nothing has been checked.</p>;
  return (
    <div className="grid gap-2">
      <p className="text-sm">
        <span className="font-mono font-semibold">{status.matched} of {status.checked}</span> recent revisions match.{' '}
        {status.latest ? <StatusBadge status="validated">Latest matches</StatusBadge> : <StatusBadge status="failed">Latest drifts</StatusBadge>}
      </p>
      {status.issues.length ? (
        <ul className="text-muted-foreground grid gap-1 font-mono text-xs">
          {status.issues.map(issue => (
            <li key={`${issue.path} ${issue.message}`}><span className="text-foreground">{issue.path}</span>: {issue.message} · {issue.revisions} {issue.revisions === 1 ? 'revision' : 'revisions'}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const contractPath = (file: string) => `kit-board/lib/generated/contracts/${file}`;

/** One report kind's contract: what it checks, how recent reports compare, and how to check your own. */
export function ContractCard({ report, status }: { report: KitReport; status?: ContractStatus }) {
  if (report.kind === 'usage') {
    return (
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">Companion usage upload <EnforcementBadge enforcement={report.enforcement} /></CardTitle>
          <CardDescription className="font-mono text-[11px]">{report.contract}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 text-sm">
          <p className="text-muted-foreground">What the companion posts to POST /api/v1/usage. The companion checks each upload against its vendored copy of this schema before it posts, and the board refuses any mismatch.</p>
          <SourceLinks path="kit-board/lib/generated/usage-v2.schema.json" label="usage-v2.schema.json" />
        </CardContent>
      </Card>
    );
  }
  const contract = reportContractRegistry[report.contract as ReportContractId];
  const schema = z.toJSONSchema(contract.schema, { io: 'input' }) as Parameters<typeof contractFields>[0];
  const fields = contractFields(schema);
  const example = JSON.stringify(contract.example, null, 2);
  const endpoint = `/api/v1/reports/${report.kind}`;
  const local = `node validate.mjs ${contract.id}.schema.json report.json`;
  const remote = `curl -sS "$BOARD_URL${endpoint}/validate" \\\n  -H "Authorization: Bearer $PRODUCER_KEY" -H 'Content-Type: application/json' \\\n  --data @report.json`;
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">{contract.title} <EnforcementBadge enforcement={report.enforcement} /></CardTitle>
        <CardDescription><span className="font-mono text-[11px]">{contract.id}</span> · {contract.summary}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-4">
        <p className="text-muted-foreground text-sm">
          {report.enforcement === 'enforce'
            ? `POST ${endpoint} answers 422 and stores nothing when the payload does not match.`
            : `POST ${endpoint} stores any report whose envelope is valid and returns this contract's result in its receipt. It will refuse a mismatch once the contract is enforced.`}
        </p>
        <ContractHealth status={status} />
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <SourceLinks path={contractPath(`${contract.id}.schema.json`)} label="JSON Schema" />
          <SourceLinks path={contractPath(`${contract.id}.example.json`)} label="Example" />
          <SourceLinks path={contractPath('validate.mjs')} label="validate.mjs" />
        </div>
        <Disclosure title={`Fields (${fields.length})`}>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={head}>Field</TableHead>
                  <TableHead className={head}>Type</TableHead>
                  <TableHead className={head}>Rules</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.map(field => (
                  <TableRow key={field.path} className={row}>
                    <TableCell className="py-1.5 font-mono text-xs" style={{ paddingLeft: `${0.5 + field.depth}rem` }}>
                      {field.path}{field.required ? <span className="text-primary" title="Required"> *</span> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground py-1.5 font-mono text-xs">{field.type}</TableCell>
                    <TableCell className="text-muted-foreground py-1.5 text-xs whitespace-normal">
                      {[...field.rules, ...(field.description ? [field.description] : [])].join('; ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">* required. Objects accept keys the board does not read yet, so a producer can add a field before the board draws it.</p>
        </Disclosure>
        <Disclosure title="Example body">
          <div className="grid gap-2">
            <CopyButton value={example} label="Copy the example" copiedLabel="Copied the example" size="xs" className="justify-self-start" />
            <TerminalBlock caption={`${contract.id}.example.json`}>{example}</TerminalBlock>
          </div>
        </Disclosure>
        <Disclosure title="Check a report">
          <div className="grid gap-4">
            <ContractValidatorForm kind={report.kind} example={example} />
            <TerminalBlock caption="Offline, with the downloaded schema. Exits 1 on a mismatch." command={local}>{local}</TerminalBlock>
            <TerminalBlock caption="Against the board, with the producer's key. Stores nothing." command={remote}>{remote}</TerminalBlock>
          </div>
        </Disclosure>
      </CardContent>
    </Card>
  );
}
