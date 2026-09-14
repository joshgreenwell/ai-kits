'use client';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, Stat, StatGroup } from '@/components/kit';
import { Registry, useRegistry, type RegistryEntry, type RegistryIdentity } from '@/components/registry';

type ProjectsData = {
  projects: { id: string; label: string; created_at: string; updated_at: string }[];
  identities: {
    id: string; basis: 'working_directory' | 'native'; evidence_key: string; first_seen: string; last_seen: string;
    install_id: string | null; machine_label: string | null; account_id: string | null; account_label: string | null; provider: string | null;
    project_id: string | null; project_label: string | null;
  }[];
  coverage: {
    evidence: { request_observations: number; canonical_requests: number; with_identity: number; no_project: number; unknown: number };
    mapping: { identities: number; mapped: number; unassigned: number };
    resolved_requests: { project: number; unassigned: number; no_project: number; unknown: number };
  };
};

/** Project naming over the USG-007 registry: hashed working directories and native ids become labels here. */
export function ProjectRegistry() {
  const { data, error, refresh } = useRegistry<ProjectsData>('/api/usage-projects', 'The project registry is temporarily unavailable.');
  const entries: RegistryEntry[] = (data?.projects ?? []).map(project => ({ id: project.id, label: project.label, identities: data?.identities.filter(identity => identity.project_id === project.id).length ?? 0 }));
  const identities: RegistryIdentity[] = (data?.identities ?? []).map(identity => ({
    id: identity.id, key: identity.evidence_key, basis: identity.basis,
    where: identity.basis === 'working_directory' ? (identity.machine_label ?? 'unknown machine') : `${identity.account_label ?? 'unknown account'} · ${identity.provider ?? '—'}`,
    mapped_id: identity.project_id, mapped_label: identity.project_label, first_seen: identity.first_seen, last_seen: identity.last_seen,
  }));
  return (
    <div className="grid gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Projects are temporarily unavailable</AlertTitle>
          <AlertDescription><p>{error}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => void refresh()}>Retry loading</Button></AlertDescription>
        </Alert>
      )}
      {!data ? (
        !error && <p className="text-muted-foreground text-sm" role="status">Loading projects…</p>
      ) : (
        <>
          <Card className="gap-0 overflow-hidden py-0">
            <StatGroup>
              <Stat label="Identities" value={String(data.coverage.mapping.identities)} caption={`${data.coverage.mapping.mapped} mapped · ${data.coverage.mapping.unassigned} unassigned`} />
              <Stat label="Requests with identity" value={String(data.coverage.evidence.with_identity)} caption={`of ${data.coverage.evidence.canonical_requests} canonical · ${data.coverage.evidence.no_project} no project · ${data.coverage.evidence.unknown} unknown`} />
              <Stat label="Resolved to a project" value={String(data.coverage.resolved_requests.project)} caption={`${data.coverage.resolved_requests.unassigned} unassigned · ${data.coverage.resolved_requests.no_project} no project · ${data.coverage.resolved_requests.unknown} unknown`} />
            </StatGroup>
          </Card>
          <Registry
            kind="project" url="/api/usage-projects" nouns={{ singular: 'project', plural: 'projects' }}
            entries={entries} identities={identities} refresh={refresh}
            keyHeading="Evidence key" whereHeading="Seen by"
            empty={(
              <EmptyState
                title="No project identities yet"
                description="Identities appear once a companion uploads requests with project attribution on. Turn on hashed project attribution under Collection and wait for the next run; the hash of each working directory arrives, never the path."
                actions={<Button size="sm" variant="outline" asChild><Link href="/settings/collection">Open collection settings</Link></Button>}
              />
            )}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            A working-directory identity is scoped to the machine that reported it; the same folder on another machine is a second identity to map to the same project. Run <span className="font-mono">observatory projects</span> on the machine to see which folder a hash stands for.
          </p>
        </>
      )}
    </div>
  );
}
