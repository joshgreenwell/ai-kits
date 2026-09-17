'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, EmptyState, Stat, StatGroup, type Column } from '@/components/kit';
import type { UsageQueryResult } from '@/lib/usage-query';
import { PROJECT_STATE_LABELS, compactTokens, exactTokens, percent, type TokensFilters } from '@/lib/usage-view';

type ProjectRow = UsageQueryResult['projects']['rows'][number];
type AgentRow = UsageQueryResult['agents']['rows'][number];
type ToolRow = UsageQueryResult['tools']['by_tool'][number];
type CallerRow = UsageQueryResult['tools']['by_caller'][number];
type KnowledgeRow = UsageQueryResult['knowledge']['rows'][number];
type Coverage = UsageQueryResult['projects']['coverage'];

const shortKey = (key: string) => key.slice(0, 8);
const coveragePercent = (coverage: Coverage) => percent(coverage.headline ? coverage.applicable * coverage.complete : null);
const count = (value: number, singular: string, plural = `${singular}s`) => `${exactTokens(value)} ${value === 1 ? singular : plural}`;
/** The row's display name: the registry label for a named project, the agreed state label otherwise. */
const projectName = (row: Pick<ProjectRow, 'state' | 'label'>) => row.state === 'project' ? row.label ?? 'Unnamed project' : PROJECT_STATE_LABELS[row.state];

/** The filter value a project row applies: the registry id for a named project, the state code otherwise. */
export function projectFilterValue(row: Pick<ProjectRow, 'state' | 'project_id'>): string | null {
  if (row.state === 'project') return row.project_id;
  return row.state;
}

/** How an agent row is named wherever it appears: the recorded name first, then its class with a short key. */
export function agentLabel(row: Pick<AgentRow, 'agent_key' | 'name' | 'class'>): string {
  if (row.name) return row.name;
  if (row.class === 'main') return row.agent_key ? `Main agent ${shortKey(row.agent_key)}` : 'Main agent';
  if (!row.agent_key) return 'Unattributed';
  return `${AGENT_CLASS_LABELS[row.class] ?? row.class} agent ${shortKey(row.agent_key)}`;
}

export const AGENT_CLASS_LABELS: Record<string, string> = { main: 'Main', builtin: 'Built-in', custom: 'Custom', unknown: 'Unknown role' };
const TOOL_CLASS_LABELS: Record<string, string> = { builtin: 'built-in', mcp: 'MCP', function: 'function', custom: 'custom', unknown: 'unknown' };
const KNOWLEDGE_STATE_LABELS: Record<string, string> = { source: 'Configured source', unassigned: 'Unassigned identity', unknown: 'Unknown source' };
const ACCESS_KINDS = ['read', 'search', 'write', 'unknown'] as const;

function ProjectCard({ result, filters, onFiltersChange }: { result: UsageQueryResult; filters: TokensFilters; onFiltersChange: (next: TokensFilters) => void }) {
  const { rows, coverage, registry } = result.projects;
  const named = rows.filter(row => row.state === 'project');
  const selected = rows.find(row => { const value = projectFilterValue(row); return value !== null && filters.projects.includes(value); });
  const columns: Column<ProjectRow>[] = [
    { id: 'project', header: 'Project', sortValue: projectName, cell: row => (
      row.state === 'project'
        ? <span className="text-xs font-medium">{projectName(row)}</span>
        : <span className="flex items-center gap-1.5 text-xs"><Badge variant="outline">{projectName(row)}</Badge></span>
    ) },
    { id: 'tokens', header: 'Tokens', numeric: true, sortValue: row => row.total_tokens, cell: row => exactTokens(row.total_tokens) },
    { id: 'share', header: 'Share', numeric: true, sortValue: row => row.share ?? -1, cell: row => percent(row.share) },
    { id: 'calls', header: 'Calls', numeric: true, sortValue: row => row.calls, cell: row => exactTokens(row.calls) },
    { id: 'conversations', header: 'Conversations', numeric: true, sortValue: row => row.conversations, cell: row => exactTokens(row.conversations) },
  ];
  const select = (row: ProjectRow) => {
    const value = projectFilterValue(row);
    if (value === null) return;
    onFiltersChange({ ...filters, projects: filters.projects.includes(value) ? filters.projects.filter(v => v !== value) : [value] });
  };
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-label="Projects">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Projects</CardTitle>
        <CardDescription>Tokens by the project each conversation belongs to.</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1.5">
          {selected ? <Badge variant="soft">filtering: {projectName(selected)}</Badge> : null}
          {coverage.headline > 0 && coverage.eligible < coverage.headline ? <Badge variant="soft-warning">{percent(1 - coverage.eligible / coverage.headline)} without request detail</Badge> : null}
        </CardAction>
      </CardHeader>
      <StatGroup className="border-border border-y">
        <Stat label="Named projects" value={String(named.length)} caption={`${count(rows.filter(r => r.state !== 'project').length, 'state bucket')} kept inside the total`} />
        <Stat label="Attribution coverage" value={coveragePercent(coverage)} caption={`${exactTokens(coverage.classified)} of ${exactTokens(coverage.headline)} headline tokens carry a project`} />
        <Stat label="Registry mapping" value={percent(registry.eligible ? registry.complete : null)} caption={`${exactTokens(registry.classified)} of ${exactTokens(registry.eligible)} attributed tokens map to a named project`} />
      </StatGroup>
      <div className="grid gap-3 p-4">
        <DataTable columns={columns} rows={rows} getRowId={row => `${row.state}:${row.project_id ?? ''}`} defaultSort={{ id: 'tokens', dir: 'desc' }}
          selectedId={selected ? `${selected.state}:${selected.project_id ?? ''}` : undefined} onSelect={select} className="max-h-80 overflow-auto"
          caption="Select a row to filter the whole page to that project; select it again, or remove the chip above, to go back."
          empty={<EmptyState title="No project evidence in scope" description="Projects are read from request records. Nothing here means the selected scope carries only hourly buckets, which name no project; raise the collection detail level to requests or requests_with_tools and map working directories under Settings." actions={<Button size="sm" variant="outline" asChild><Link href="/settings/projects">Open project settings</Link></Button>} />} />
      </div>
      <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed" data-testid="projects-footnote">
        No project and Unknown project are separate rows and both stay inside the headline total. {coverage.note} {registry.note}
      </p>
    </Card>
  );
}

function AgentCard({ result, filters, onFiltersChange }: { result: UsageQueryResult; filters: TokensFilters; onFiltersChange: (next: TokensFilters) => void }) {
  const { rows, summary, coverage } = result.agents;
  const attributed = summary.main_tokens + summary.subagent_tokens;
  const total = attributed + summary.unattributed_tokens;
  const share = (tokens: number) => percent(total ? tokens / total : null);
  const names = new Map(rows.filter(row => row.agent_key).map(row => [row.agent_key as string, agentLabel(row)]));
  const selected = rows.find(row => row.agent_key && filters.agents.includes(row.agent_key));
  const columns: Column<AgentRow>[] = [
    { id: 'agent', header: 'Agent', sortValue: row => agentLabel(row), cell: row => (
      <span className="grid gap-0.5 text-xs">
        <span className={row.agent_key ? 'font-medium' : 'text-muted-foreground'}>{agentLabel(row)}</span>
        {row.agent_key ? <span className="text-muted-foreground font-mono text-[10.5px]">{shortKey(row.agent_key)}</span> : null}
      </span>
    ) },
    { id: 'class', header: 'Role', sortValue: row => row.class, cell: row => <Badge variant={row.class === 'unknown' ? 'outline' : 'soft'}>{AGENT_CLASS_LABELS[row.class] ?? row.class}</Badge> },
    { id: 'parent', header: 'Parent', sortValue: row => row.parent_agent_key ?? '', cell: row => row.parent_agent_key ? <span className="text-xs">{names.get(row.parent_agent_key) ?? `agent ${shortKey(row.parent_agent_key)}`}</span> : <span className="text-muted-foreground text-xs">{row.class === 'main' ? 'session root' : 'not recorded'}</span> },
    { id: 'model', header: 'Model', sortValue: row => row.model ?? '', cell: row => <span className="font-mono text-xs">{row.model ?? <span className="text-muted-foreground font-sans">not recorded</span>}</span> },
    { id: 'depth', header: 'Depth', numeric: true, sortValue: row => row.depth ?? -1, cell: row => row.depth === null ? '—' : String(row.depth) },
    { id: 'tokens', header: 'Tokens', numeric: true, sortValue: row => row.total_tokens, cell: row => exactTokens(row.total_tokens) },
    { id: 'share', header: 'Share', numeric: true, sortValue: row => row.share ?? -1, cell: row => percent(row.share) },
    { id: 'calls', header: 'Calls', numeric: true, sortValue: row => row.calls, cell: row => exactTokens(row.calls) },
  ];
  const select = (row: AgentRow) => {
    if (!row.agent_key) return;
    const key = row.agent_key;
    onFiltersChange({ ...filters, agents: filters.agents.includes(key) ? filters.agents.filter(v => v !== key) : [key] });
  };
  const scope = (next: TokensFilters['agent_scope']) => onFiltersChange({ ...filters, agent_scope: filters.agent_scope === next ? 'all' : next });
  const classes = Object.entries(summary.by_class).filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]);
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-label="Agents">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Agents</CardTitle>
        <CardDescription>How the same tokens divide between the main agent and its observed subagents.</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1.5">
          {selected ? <Badge variant="soft">filtering: {agentLabel(selected)}</Badge> : null}
          <Button type="button" size="xs" variant={filters.agent_scope === 'main' ? 'default' : 'outline'} aria-pressed={filters.agent_scope === 'main'} onClick={() => scope('main')}>Main agent only</Button>
          <Button type="button" size="xs" variant={filters.agent_scope === 'subagent' ? 'default' : 'outline'} aria-pressed={filters.agent_scope === 'subagent'} onClick={() => scope('subagent')}>Subagents only</Button>
        </CardAction>
      </CardHeader>
      <StatGroup className="border-border border-y">
        <Stat label="Main agent" value={compactTokens(summary.main_tokens)} caption={`${share(summary.main_tokens)} of attributable tokens · ${exactTokens(summary.main_tokens)} exact`} />
        <Stat label="Subagents" value={compactTokens(summary.subagent_tokens)} caption={`${share(summary.subagent_tokens)} · ${count(summary.observed_children, 'distinct observed child', 'distinct observed children')}`} />
        <Stat label="Unattributed" value={compactTokens(summary.unattributed_tokens)} caption={`${share(summary.unattributed_tokens)} · request records without an agent identity`} tone={summary.unattributed_tokens > 0 ? 'warning' : 'default'} />
        <Stat label="Spawn events" value={exactTokens(summary.spawns)} caption="recorded attempts; a child counts only once observed" />
      </StatGroup>
      <div className="grid gap-3 p-4">
        {classes.length ? (
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="agent-classes">
            <dt className="text-muted-foreground">Role classes</dt>
            {classes.map(([cls, tokens]) => <dd key={cls} className="flex items-baseline gap-1"><span>{AGENT_CLASS_LABELS[cls] ?? cls}</span> <span className="font-mono tabular-nums">{exactTokens(tokens)}</span></dd>)}
          </dl>
        ) : null}
        <DataTable columns={columns} rows={rows} getRowId={row => row.agent_key ?? `unattributed:${row.class}`} defaultSort={{ id: 'tokens', dir: 'desc' }}
          selectedId={selected?.agent_key ?? undefined} onSelect={select} className="max-h-80 overflow-auto"
          caption="Select an agent to filter the whole page to it; select it again, or remove the chip above, to go back. Unattributed rows cannot be selected."
          empty={<EmptyState title="No agent evidence in scope" description="Agent identity, parent, model, and depth arrive with request records and agent lifecycle events. Hourly buckets carry none of them, so this scope has nothing to divide." />} />
      </div>
      <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed" data-testid="agents-footnote">
        Agent tokens divide the headline above; they are never added to it, and missing identity stays unattributed rather than counted as the main agent. A role class describes the child, not who started it: a custom role can be launched by another model, and the collected logs do not say whether a user or a model asked for the delegation. {coverage.note}
      </p>
    </Card>
  );
}

/** USG-021: the project and agent breakdowns, side by side on wide screens, each row a reversible filter. */
export function ProjectAgentBreakdown({ result, filters, onFiltersChange }: { result: UsageQueryResult; filters: TokensFilters; onFiltersChange: (next: TokensFilters) => void }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2" data-testid="project-agent-breakdown">
      <ProjectCard result={result} filters={filters} onFiltersChange={onFiltersChange} />
      <AgentCard result={result} filters={filters} onFiltersChange={onFiltersChange} />
    </div>
  );
}

function KnowledgeSources({ result }: { result: UsageQueryResult }) {
  const { rows, distinct_invocations, note } = result.knowledge;
  const configured = rows.filter(row => row.state === 'source');
  const label = (row: KnowledgeRow) => row.label ?? KNOWLEDGE_STATE_LABELS[row.state] ?? row.state;
  const columns: Column<KnowledgeRow>[] = [
    { id: 'source', header: 'Source', sortValue: row => label(row), cell: row => (
      <span className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className={row.state === 'source' ? 'font-medium' : 'text-muted-foreground'}>{label(row)}</span>
        {row.state !== 'source' ? <Badge variant="outline">{row.state === 'unassigned' ? 'not yet named' : 'no identity'}</Badge> : null}
      </span>
    ) },
    { id: 'accesses', header: 'Accesses', numeric: true, sortValue: row => row.accesses, cell: row => exactTokens(row.accesses) },
    { id: 'invocations', header: 'Tool calls', numeric: true, sortValue: row => row.distinct_invocations, cell: row => exactTokens(row.distinct_invocations) },
    { id: 'sessions', header: 'Sessions', numeric: true, sortValue: row => row.distinct_sessions, cell: row => exactTokens(row.distinct_sessions) },
    { id: 'agents', header: 'Agents', numeric: true, sortValue: row => row.distinct_agents, cell: row => exactTokens(row.distinct_agents) },
    ...ACCESS_KINDS.map<Column<KnowledgeRow>>(kind => ({ id: kind, header: kind[0].toUpperCase() + kind.slice(1), numeric: true, sortValue: row => row.by_access_kind[kind] ?? 0, cell: row => exactTokens(row.by_access_kind[kind] ?? 0) })),
    { id: 'earlier', header: 'Earlier config', numeric: true, sortValue: row => row.earlier_configuration_accesses, cell: row => row.earlier_configuration_accesses ? exactTokens(row.earlier_configuration_accesses) : '—' },
  ];
  return (
    <section className="border-border grid gap-3 border-t p-4" aria-label="Knowledge sources" data-testid="knowledge-sources">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold">Knowledge sources</h3>
          <p className="text-muted-foreground text-xs">Tool calls that touched a configured vault or connector, one row per source. Access counts overlap; the distinct tool-call total does not.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{count(configured.length, 'configured source')}</Badge>
          <Badge variant="outline">{count(distinct_invocations, 'distinct tool call')}</Badge>
          <Button size="xs" variant="outline" asChild><Link href="/settings/sources">Configure sources</Link></Button>
        </div>
      </div>
      <DataTable columns={columns} rows={rows} getRowId={(row) => `${row.state}:${row.source_id ?? rows.indexOf(row)}`} defaultSort={{ id: 'accesses', dir: 'desc' }} className="max-h-80 overflow-auto"
        empty={<EmptyState title="No knowledge-source access in scope" description="Access rows arrive only at the requests_with_tools detail level, from installs with at least one configured source, and only for tool calls the companion could classify against it. A conversation running inside a vault folder is not counted as access." actions={<Button size="sm" variant="outline" asChild><Link href="/settings/sources">Configure sources</Link></Button>} />} />
      <p className="text-muted-foreground text-xs leading-relaxed" data-testid="knowledge-footnote">
        {note ? `${note} ` : ''}Reading or searching a source shows access, not that the answer used its contents, and no token cost is assigned to a source. Unassigned identities have been seen but not yet named under Settings; unknown rows carry no identity the registry can resolve.
      </p>
    </section>
  );
}

/** USG-022: the final Tokens card - deduplicated tool invocations, their callers and outcomes, then the knowledge-source area. */
export function ToolKnowledgeCard({ result }: { result: UsageQueryResult }) {
  const { tools, agents, headline } = result;
  const outcomes = Object.entries(tools.by_outcome).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const outcomesCollected = tools.outcome_coverage.classified > 0;
  const toolColumns: Column<ToolRow>[] = [
    { id: 'tool', header: 'Tool', sortValue: row => row.name ?? '', cell: row => (
      <span className="grid gap-0.5 text-xs">
        <span className={row.name ? 'font-mono' : 'text-muted-foreground'}>{row.name ?? 'Unnamed tool'}</span>
        <span className="text-muted-foreground text-[10.5px]">{TOOL_CLASS_LABELS[row.class] ?? row.class}{row.namespace ? ` · ${row.namespace}` : ''}</span>
      </span>
    ) },
    { id: 'invocations', header: 'Invocations', numeric: true, sortValue: row => row.invocations, cell: row => exactTokens(row.invocations) },
    { id: 'share', header: 'Share', numeric: true, sortValue: row => row.share ?? -1, cell: row => percent(row.share) },
  ];
  const callerColumns: Column<CallerRow>[] = [
    { id: 'caller', header: 'Caller', sortValue: row => row.agent_name ?? row.agent_class ?? '', cell: row => (
      <span className="grid gap-0.5 text-xs">
        <span className={row.agent_key ? 'font-medium' : 'text-muted-foreground'}>{row.agent_key ? agentLabel({ agent_key: row.agent_key, name: row.agent_name, class: row.agent_class ?? 'unknown' }) : 'No caller recorded'}</span>
        {row.agent_key ? <span className="text-muted-foreground font-mono text-[10.5px]">{shortKey(row.agent_key)}</span> : null}
      </span>
    ) },
    { id: 'model', header: 'Model', sortValue: row => row.model ?? '', cell: row => row.model ? <span className="font-mono text-xs">{row.model}</span> : <span className="text-muted-foreground text-xs">not recorded</span> },
    { id: 'invocations', header: 'Invocations', numeric: true, sortValue: row => row.invocations, cell: row => exactTokens(row.invocations) },
  ];
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-label="Tool calls and knowledge sources">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Tool calls and knowledge sources</CardTitle>
        <CardDescription>Reported tool invocations in scope, who issued them, and which knowledge sources they reached.</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1.5">
          {tools.unsupported_filters.map(note => <Badge key={note} variant="soft-warning" title={note}>{note === 'models' ? 'model filter not applied to tools' : note}</Badge>)}
        </CardAction>
      </CardHeader>
      <StatGroup className="border-border border-y">
        <Stat label="Tool invocations" value={exactTokens(tools.invocations)} caption="each invocation once; results and status updates are not counted again" />
        <Stat label="Model calls" value={exactTokens(headline.calls)} caption="a separate count: the requests that issued these tools" />
        <Stat label="Agent spawns" value={exactTokens(agents.summary.spawns)} caption="a separate count: delegation attempts, not tool calls" />
        <Stat label="Caller attribution" value={coveragePercent(tools.caller_coverage)} caption={`${exactTokens(tools.caller_coverage.classified)} of ${exactTokens(tools.caller_coverage.headline)} invocations name their caller`} />
      </StatGroup>
      <div className="grid gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="tool-outcomes">
          <span className="text-muted-foreground">Outcomes</span>
          {outcomesCollected
            ? outcomes.map(([outcome, n]) => <Badge key={outcome} variant={outcome === 'failed' ? 'soft-warning' : outcome === 'unknown' ? 'outline' : 'soft'}>{outcome.replaceAll('_', ' ')} {exactTokens(n)}</Badge>)
            : <span className="text-muted-foreground">not collected for these invocations; success and failure are unknown rather than assumed.</span>}
          {outcomesCollected && tools.outcome_coverage.classified < tools.outcome_coverage.headline ? <span className="text-muted-foreground">· {exactTokens(tools.outcome_coverage.headline - tools.outcome_coverage.classified)} without a recorded outcome</span> : null}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-2">
            <h3 className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Top tools</h3>
            <DataTable columns={toolColumns} rows={tools.by_tool} getRowId={row => `${row.class}:${row.namespace ?? ''}:${row.name ?? ''}`} defaultSort={{ id: 'invocations', dir: 'desc' }} className="max-h-80 overflow-auto"
              empty={<EmptyState title="No tool invocations in scope" description="Tool events arrive at the requests_with_tools detail level. Hourly buckets and plain request records carry none." actions={<Button size="sm" variant="outline" asChild><Link href="/settings/collection">Open collection settings</Link></Button>} />} />
          </div>
          <div className="grid gap-2">
            <h3 className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Top callers</h3>
            <DataTable columns={callerColumns} rows={tools.by_caller} getRowId={row => `${row.agent_key ?? 'none'}:${row.model ?? ''}`} defaultSort={{ id: 'invocations', dir: 'desc' }} className="max-h-80 overflow-auto"
              empty={<EmptyState title="No caller attribution" description="Callers are named only where an invocation carries its agent or request; none in scope does." />} />
          </div>
        </div>
      </div>
      <KnowledgeSources result={result} />
      <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed" data-testid="tools-footnote">
        Tool invocations, model calls, and agent spawns are three different counts and are never summed. {tools.caller_coverage.note} {tools.outcome_coverage.note} Tool events follow the requests that issued them through the account, project, machine, and agent filters; a model filter cannot be applied to them where no calling request is recorded.
      </p>
    </Card>
  );
}
