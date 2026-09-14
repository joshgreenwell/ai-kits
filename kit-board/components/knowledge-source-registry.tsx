'use client';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, Stat, StatGroup } from '@/components/kit';
import { Registry, useRegistry, type RegistryEntry, type RegistryIdentity } from '@/components/registry';
import type { KnowledgeSourceSummary } from '@/lib/usage-store';

type SourcesData = {
  sources: { id: string; label: string; created_at: string; updated_at: string }[];
  identities: {
    id: string; install_id: string; machine_label: string | null; resource_key: string; configuration_version: number;
    first_seen: string; last_seen: string; source_id: string | null; source_label: string | null;
    accesses: number; distinct_invocations: number; earlier_configuration_accesses: number;
  }[];
  per_source: KnowledgeSourceSummary[];
  coverage: {
    evidence: { access_rows: number; canonical_accesses: number; current_configuration_accesses: number; earlier_configuration_accesses: number; distinct_invocations: number; overlapping_invocations: number };
    mapping: { identities: number; mapped: number; unassigned: number };
    resolved: { source: number; unassigned: number; unknown: number };
    detection: { install_id: string; machine_label: string; adapter: string; state: string; detail_code: string | null; finished_at: string }[];
  };
};

/** Knowledge-source naming over the USG-008 registry: each install's resource keys become one label here. */
export function KnowledgeSourceRegistry() {
  const { data, error, refresh } = useRegistry<SourcesData>('/api/usage-knowledge-sources', 'The knowledge-source registry is temporarily unavailable.');
  const entries: RegistryEntry[] = (data?.sources ?? []).map(source => {
    const summary = data?.per_source.find(row => row.source_id === source.id);
    return { id: source.id, label: source.label, identities: data?.identities.filter(identity => identity.source_id === source.id).length ?? 0,
      detail: summary ? `${summary.accesses} accesses · ${summary.distinct_invocations} tool calls · ${summary.distinct_sessions} sessions` : undefined };
  });
  const identities: RegistryIdentity[] = (data?.identities ?? []).map(identity => ({
    id: identity.id, key: identity.resource_key, where: identity.machine_label ?? 'unknown machine',
    mapped_id: identity.source_id, mapped_label: identity.source_label, first_seen: identity.first_seen, last_seen: identity.last_seen,
    note: `${identity.accesses} accesses · ${identity.distinct_invocations} tool calls · configuration v${identity.configuration_version}${identity.earlier_configuration_accesses ? ` · ${identity.earlier_configuration_accesses} under an earlier configuration` : ''}`,
  }));
  const detection = data?.coverage.detection.filter(row => row.state !== 'complete') ?? [];
  return (
    <div className="grid gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Knowledge sources are temporarily unavailable</AlertTitle>
          <AlertDescription><p>{error}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => void refresh()}>Retry loading</Button></AlertDescription>
        </Alert>
      )}
      {!data ? (
        !error && <p className="text-muted-foreground text-sm" role="status">Loading knowledge sources…</p>
      ) : (
        <>
          <Card className="gap-0 overflow-hidden py-0">
            <StatGroup>
              <Stat label="Identities" value={String(data.coverage.mapping.identities)} caption={`${data.coverage.mapping.mapped} mapped · ${data.coverage.mapping.unassigned} unassigned`} />
              <Stat label="Accesses" value={String(data.coverage.evidence.current_configuration_accesses)} caption={`${data.coverage.evidence.distinct_invocations} tool calls · ${data.coverage.evidence.overlapping_invocations} touching several sources · ${data.coverage.evidence.earlier_configuration_accesses} under earlier configurations`} />
              <Stat label="Resolved to a source" value={String(data.coverage.resolved.source)} caption={`${data.coverage.resolved.unassigned} unassigned · ${data.coverage.resolved.unknown} unknown`} />
            </StatGroup>
          </Card>
          {detection.length > 0 && (
            <Alert variant="warning" role="status">
              <AlertTitle>Detection is partial on some installs</AlertTitle>
              <AlertDescription>
                {detection.map(row => `${row.machine_label} · ${row.adapter}: ${row.state}${row.detail_code ? ` (${row.detail_code.replaceAll('_', ' ')})` : ''}`).join('; ')}. Sources are configured on the machine with <span className="font-mono">observatory resources</span>; access rows need the <span className="font-mono">requests_with_tools</span> detail level.
              </AlertDescription>
            </Alert>
          )}
          <Registry
            kind="source" url="/api/usage-knowledge-sources" nouns={{ singular: 'knowledge source', plural: 'knowledge sources' }}
            entries={entries} identities={identities} refresh={refresh}
            keyHeading="Resource key" whereHeading="Machine"
            empty={(
              <EmptyState
                title="No knowledge-source identities yet"
                description="Identities appear once a companion classifies tool calls against sources configured on that machine. Add a vault or folder with observatory resources add (or accept a discovered vault at setup), set the detail level to requests_with_tools under Collection, and wait for the next run. Only the key and counts arrive, never a root."
                actions={<Button size="sm" variant="outline" asChild><Link href="/settings/collection">Open collection settings</Link></Button>}
              />
            )}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            A resource key is scoped to the install that configured it; the same vault on two machines is two identities to map to one source. Accesses count resource rows and tool calls count invocations, so one call touching several sources appears under each.
          </p>
        </>
      )}
    </div>
  );
}
