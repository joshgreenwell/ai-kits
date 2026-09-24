'use client';

import Link from 'next/link';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, RankedList, Stat, StatGroup, type RankedColumn, type RankedSegment } from '@/components/kit';
import { ProviderRing } from '@/components/reset-dot';
import { providerColor } from '@/lib/provider-colors';
import type { UsageQueryResult } from '@/lib/usage-query';
import { PROJECT_STATE_LABELS, PROVIDER_LABELS, compactTokens, exactTokens, percent, unsupportedFilterLabel, type TokensFilters } from '@/lib/usage-view';

type ProjectRow = UsageQueryResult['projects']['rows'][number];
type AgentRow = UsageQueryResult['agents']['rows'][number];
type ToolRow = UsageQueryResult['tools']['by_tool'][number];
type ChildRow = ToolRow['children'][number];
type CallerRow = UsageQueryResult['tools']['by_caller'][number];
type KnowledgeRow = UsageQueryResult['knowledge']['rows'][number];
type Coverage = UsageQueryResult['projects']['coverage'];

const coveragePercent = (coverage: Coverage) => percent(coverage.headline ? coverage.applicable * coverage.complete : null);
const count = (value: number, singular: string, plural = `${singular}s`) => `${exactTokens(value)} ${value === 1 ? singular : plural}`;
const plural = (singular: string, pluralForm = `${singular}s`) => (value: number) => value === 1 ? singular : pluralForm;
const shareOf = (value: number, total: number) => percent(total ? value / total : null);
/**
 * The row's display name: the app project's name for a project; otherwise the label the read gave the
 * row ("Chats / no project", "<machine>: companion update needed") or the state's own name.
 */
const projectName = (row: Pick<ProjectRow, 'state' | 'label'>) => row.state === 'project' ? row.label ?? 'Unnamed project' : row.label ?? PROJECT_STATE_LABELS[row.state];
const projectRowId = (row: Pick<ProjectRow, 'state' | 'filter_value' | 'label'>) => `${row.state}:${row.filter_value}:${row.label ?? ''}`;

/**
 * The filter value a project row applies, as the read gives it: the project id for a named project,
 * `projectless` for Chats / no project, `not_reported:<install>` for one machine's update row, and the
 * state code otherwise. Every row's value is its own, so selecting a row never widens to its neighbours.
 */
export function projectFilterValue(row: Pick<ProjectRow, 'filter_value'>): string | null {
  return row.filter_value || null;
}

/** How an agent group is named wherever it appears: its provider, then the name the labels or the ledger give it. */
export function agentLabel(row: Pick<AgentRow, 'name' | 'provider'>): string {
  const name = row.name === 'main' ? 'main agent' : row.name;
  return `${PROVIDER_LABELS[row.provider] ?? row.provider} · ${name}`;
}

export const AGENT_CLASS_LABELS: Record<string, string> = { main: 'Main', builtin: 'Built-in', custom: 'Custom', unattributed: 'Unattributed', unknown: 'Unknown role' };
const ROLE_LABELS: Record<string, string> = { main: 'Main', subagent: 'Subagent', unattributed: 'Unattributed' };
const TOOL_CLASS_LABELS: Record<string, string> = { builtin: 'built-in', mcp: 'MCP', function: 'function', custom: 'custom', unknown: 'unknown' };
const KNOWLEDGE_STATE_LABELS: Record<string, string> = { source: 'Configured source', unassigned: 'Unassigned identity', unknown: 'Unknown source' };
const ACCESS_KINDS = ['read', 'search', 'write', 'unknown'] as const;

/**
 * One color per role class, shared by the class bar and every agent row's bar, so a row reads as the
 * part of the split it belongs to. The same idea colors a nested call by its outcome and a knowledge
 * access by its kind; anything without a recorded value stays a muted grey rather than a guess.
 */
const MUTED = 'color-mix(in oklab, var(--muted-foreground) 45%, transparent)';
const CLASS_COLORS: Record<string, string> = { main: 'var(--primary)', builtin: 'var(--info)', custom: 'var(--chart-2)', unattributed: MUTED, unknown: MUTED };
const OUTCOME_COLORS: Record<string, string> = { succeeded: 'color-mix(in oklab, var(--primary) 80%, transparent)', failed: 'var(--warning)', denied: 'var(--destructive)', cancelled: 'var(--info)', unknown: MUTED };
const OUTCOME_ORDER = ['succeeded', 'failed', 'denied', 'cancelled', 'unknown'];
const ACCESS_COLORS: Record<string, string> = { read: 'var(--chart-2)', search: 'var(--info)', write: 'var(--warning)', unknown: MUTED };

const agentClass = (row: Pick<AgentRow, 'role' | 'builtin'>) => row.role === 'main' ? 'main' : row.role === 'unattributed' ? 'unattributed' : row.builtin ? 'builtin' : 'custom';
const outcomeRank = (outcome: string) => { const index = OUTCOME_ORDER.indexOf(outcome); return index === -1 ? OUTCOME_ORDER.length : index; };
const outcomeSegments = (outcomes: Record<string, number>): RankedSegment[] =>
  Object.entries(outcomes).sort((a, b) => outcomeRank(a[0]) - outcomeRank(b[0])).map(([outcome, value]) => ({ value, label: outcome, color: OUTCOME_COLORS[outcome] ?? MUTED }));
const outcomeText = (outcomes: Record<string, number>) =>
  Object.entries(outcomes).sort((a, b) => outcomeRank(a[0]) - outcomeRank(b[0])).map(([outcome, n]) => `${outcome.replaceAll('_', ' ')} ${exactTokens(n)}`).join(' · ');

function tokensColumn<T>(tokens: (row: T) => number): RankedColumn<T> {
  return { header: 'Tokens', width: '4.5rem', value: row => compactTokens(tokens(row)), unit: () => 'tokens', title: row => `${exactTokens(tokens(row))} tokens` };
}
function shareColumn<T>(share: (row: T) => ReactNode): RankedColumn<T> {
  return { header: 'Share', width: '3.5rem', value: share };
}
function countColumn<T>(header: string, width: string, value: (row: T) => number, unit: (value: number) => string): RankedColumn<T> {
  return { header, width, value: row => exactTokens(value(row)), unit: row => unit(value(row)) };
}

/** A small segmented switch between two readings of the same rows. */
function ViewSwitch<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: { value: V; label: string }[]; onChange: (value: V) => void }) {
  return (
    <div role="group" aria-label={label} className="bg-muted inline-flex items-center gap-0.5 rounded-md p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'focus-visible:ring-ring/50 h-6 rounded-[5px] px-2 text-[11px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2',
            value === option.value ? 'bg-input/40 text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Names the colors a set of segmented bars use, listing only the parts present. */
function SegmentLegend({ label, items, className }: { label: string; items: { key: string; label: string; color: string }[]; className?: string }) {
  if (!items.length) return null;
  return (
    <p className={cn('text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px]', className)}>
      <span>{label}</span>
      {items.map(item => (
        <span key={item.key} className="flex items-center gap-1.5">
          <i aria-hidden="true" className="inline-block size-2 shrink-0 rounded-xs" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </p>
  );
}

/** A titled part of the tools card; the ranked list inside runs to the section's own edge. */
function Section({ title, description, actions, children, className, ...props }: Omit<ComponentProps<'section'>, 'title'> & { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cn('grid min-w-0 content-start', className)} {...props}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-4 pb-3">
        <div className="grid min-w-0 gap-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? <p className="text-muted-foreground text-xs leading-relaxed">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

type Placement = { className?: string; id?: string };

function ProjectCard({ result, filters, onFiltersChange, className, id }: { result: UsageQueryResult; filters: TokensFilters; onFiltersChange: (next: TokensFilters) => void } & Placement) {
  const { rows: given, coverage, registry } = result.projects;
  const rows = [...given].sort((a, b) => b.total_tokens - a.total_tokens);
  const named = rows.filter(row => row.state === 'project');
  const isSelected = (row: ProjectRow) => { const value = projectFilterValue(row); return value !== null && filters.projects.includes(value); };
  const selected = rows.find(isSelected);
  const select = (row: ProjectRow) => {
    const value = projectFilterValue(row);
    if (value === null) return;
    onFiltersChange({ ...filters, projects: filters.projects.includes(value) ? filters.projects.filter(v => v !== value) : [value] });
  };
  return (
    <Card id={id} className={cn('scroll-mt-28 gap-0 overflow-hidden py-0', className)} aria-label="Projects">
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
        <Stat label="In an app project" value={percent(registry.eligible ? registry.complete : null)} caption={`${exactTokens(registry.classified)} of ${exactTokens(registry.eligible)} placed tokens land in a project an app defines`} />
      </StatGroup>
      <RankedList
        className="pt-3"
        label="Projects by tokens"
        rows={rows}
        rowKey={projectRowId}
        amount={row => row.total_tokens}
        nameHeader="Project"
        name={row => row.state === 'project' ? <span className="font-medium">{projectName(row)}</span> : <Badge variant="outline">{projectName(row)}</Badge>}
        detail={row => count(row.conversations, 'conversation')}
        columns={[
          tokensColumn<ProjectRow>(row => row.total_tokens),
          shareColumn<ProjectRow>(row => percent(row.share)),
          countColumn<ProjectRow>('Calls', '4rem', row => row.calls, plural('call')),
        ]}
        isSelected={isSelected}
        onSelect={select}
        canSelect={row => projectFilterValue(row) !== null}
        noun="projects"
        empty={<div className="p-4"><EmptyState title="No project evidence in scope" description="Projects are read from request records. Nothing here means the selected scope carries only hourly buckets, which name no project; raise the collection detail level to requests or requests_with_tools. Projects are the groups you create in your apps, reported by companion 2.2.0." actions={<Button size="sm" variant="outline" asChild><Link href="/settings/projects">Open project settings</Link></Button>} /></div>}
      />
      {rows.length ? <p className="border-border text-muted-foreground border-t px-4 py-2.5 text-xs">Select a row to filter the whole page to that project; select it again, or remove the chip above, to go back.</p> : null}
      <p className="border-border text-muted-foreground mt-auto border-t p-3 text-xs leading-relaxed" data-testid="projects-footnote">
        No project, Chats / no project, Unassigned and Unknown are separate rows and all stay inside the headline total. A machine whose companion predates 2.2.0 shows as “companion update needed” until it reports its projects. {coverage.note} {registry.note}
      </p>
    </Card>
  );
}

type AgentRoleView = 'all' | 'main' | 'subagent';
const ROLE_VIEW_LABELS: Record<Exclude<AgentRoleView, 'all'>, string> = { main: 'Main agents', subagent: 'Subagents' };

/** The split between role classes as one bar, with each class's tokens and share named under it. */
function RoleClasses({ byClass }: { byClass: Record<string, number> }) {
  const classes = Object.entries(byClass).filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]);
  const total = classes.reduce((n, [, tokens]) => n + tokens, 0);
  if (!classes.length) return null;
  return (
    <div className="grid gap-2 px-4 pt-3 pb-1" data-testid="agent-classes">
      <div aria-hidden="true" className="bg-muted flex h-2 overflow-hidden rounded-full">
        {classes.map(([cls, tokens]) => <span key={cls} className="h-full" style={{ width: `${(tokens / total) * 100}%`, background: CLASS_COLORS[cls] ?? MUTED }} />)}
      </div>
      <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Role classes</dt>
        {classes.map(([cls, tokens]) => (
          <dd key={cls} className="flex items-center gap-1.5" title={`${exactTokens(tokens)} tokens`}>
            <i aria-hidden="true" className="inline-block size-2 shrink-0 rounded-xs" style={{ background: CLASS_COLORS[cls] ?? MUTED }} />
            <span>{AGENT_CLASS_LABELS[cls] ?? cls}</span>
            <span className="font-mono tabular-nums">{compactTokens(tokens)}</span>
            <span className="text-muted-foreground font-mono tabular-nums">{shareOf(tokens, total)}</span>
          </dd>
        ))}
      </dl>
    </div>
  );
}

/** An agent or caller's name, with its role and built-in badges; a main agent's name already says its role. */
function AgentName({ name, role, builtin }: { name: string | null; role: string | null; builtin: boolean }) {
  return (
    <>
      <span className={role === 'unattributed' ? 'text-muted-foreground' : 'font-medium'}>{name === 'main' ? 'main agent' : name ?? 'unattributed'}</span>
      {role && role !== 'main' ? <Badge variant={role === 'unattributed' ? 'outline' : 'soft'}>{ROLE_LABELS[role] ?? role}</Badge> : null}
      {builtin ? <Badge variant="soft">built-in</Badge> : null}
    </>
  );
}

const ProviderName = ({ provider }: { provider: string | null }) => (
  <span className="font-medium" style={{ color: providerColor(provider) }}>{provider ? PROVIDER_LABELS[provider] ?? provider : 'Unknown provider'}</span>
);

function AgentCard({ result, filters, onFiltersChange, className }: { result: UsageQueryResult; filters: TokensFilters; onFiltersChange: (next: TokensFilters) => void; className?: string }) {
  const { rows: allRows, summary, coverage } = result.agents;
  // The role buttons narrow this list in place. Every row already carries its role, so showing main agents or
  // subagents needs no new read; the page-wide agent scope (More filters) is the one that re-reads.
  const [roleView, setRoleView] = useState<AgentRoleView>('all');
  const rows = [...(roleView === 'all' ? allRows : allRows.filter(row => row.role === roleView))].sort((a, b) => b.total_tokens - a.total_tokens);
  const attributed = summary.main_tokens + summary.subagent_tokens;
  const total = attributed + summary.unattributed_tokens;
  const share = (tokens: number) => shareOf(tokens, total);
  const selected = rows.find(row => filters.agents.includes(row.group_id));
  const select = (row: AgentRow) => {
    if (!row.group_id) return;
    const key = row.group_id;
    onFiltersChange({ ...filters, agents: filters.agents.includes(key) ? filters.agents.filter(v => v !== key) : [key] });
  };
  const view = (next: Exclude<AgentRoleView, 'all'>) => setRoleView(current => current === next ? 'all' : next);
  return (
    <Card className={cn('gap-0 overflow-hidden py-0', className)} aria-label="Agents">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Agents</CardTitle>
        <CardDescription>How the same tokens divide between each provider&apos;s main agent and its subagents, by name.</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1.5">
          {selected ? <Badge variant="soft">filtering: {agentLabel(selected)}</Badge> : null}
          {(['main', 'subagent'] as const).map(role => (
            <Button key={role} type="button" size="xs" variant={roleView === role ? 'default' : 'outline'} aria-pressed={roleView === role} onClick={() => view(role)}>{ROLE_VIEW_LABELS[role]}</Button>
          ))}
        </CardAction>
      </CardHeader>
      <StatGroup className="border-border border-y">
        <Stat label="Main agent" value={compactTokens(summary.main_tokens)} caption={`${share(summary.main_tokens)} of attributable tokens · ${exactTokens(summary.main_tokens)} exact`} />
        <Stat label="Subagents" value={compactTokens(summary.subagent_tokens)} caption={`${share(summary.subagent_tokens)} · ${count(summary.observed_children, 'distinct observed child', 'distinct observed children')}`} />
        <Stat label="Unattributed" value={compactTokens(summary.unattributed_tokens)} caption={`${share(summary.unattributed_tokens)} · request records without an agent identity`} tone={summary.unattributed_tokens > 0 ? 'warning' : 'default'} />
        <Stat label="Spawn events" value={exactTokens(summary.spawns)} caption="recorded attempts; a child counts only once observed" />
      </StatGroup>
      <RoleClasses byClass={summary.by_class} />
      <RankedList
        className="pt-3"
        label="Agents by tokens"
        rows={rows}
        rowKey={row => row.group_id || `${row.provider}:${row.role}:${row.name}`}
        amount={row => row.total_tokens}
        segments={row => [{ value: row.total_tokens, color: CLASS_COLORS[agentClass(row)], label: agentClass(row) }]}
        marker={row => <ProviderRing provider={row.provider} />}
        nameHeader="Agent"
        name={row => <AgentName name={row.name} role={row.role} builtin={row.builtin} />}
        detail={row => <><ProviderName provider={row.provider} /> · {count(row.instances, 'instance')} · {count(row.sessions, 'session')}</>}
        columns={[
          tokensColumn<AgentRow>(row => row.total_tokens),
          shareColumn<AgentRow>(row => percent(row.share)),
          countColumn<AgentRow>('Calls', '4rem', row => row.calls, plural('call')),
        ]}
        isSelected={row => !!row.group_id && filters.agents.includes(row.group_id)}
        onSelect={select}
        canSelect={row => !!row.group_id}
        noun="agents"
        empty={<div className="p-4">{roleView !== 'all' && allRows.length
          ? <EmptyState title={`No ${ROLE_VIEW_LABELS[roleView].toLowerCase()} in scope`} description="Every agent in this scope has another role. Select the button again to show them all." />
          : <EmptyState title="No agent evidence in scope" description="Agent identity, parent, model, and depth arrive with request records and agent lifecycle events. Hourly buckets carry none of them, so this scope has nothing to divide." />}</div>}
      />
      {rows.length ? <p className="border-border text-muted-foreground border-t px-4 py-2.5 text-xs">Select an agent to filter the whole page to it; select it again, or remove the chip above, to go back. The ring is the provider; the bar takes its role class&apos;s color.</p> : null}
      <p className="border-border text-muted-foreground mt-auto border-t p-3 text-xs leading-relaxed" data-testid="agents-footnote">
        Agent tokens divide the headline above; they are never added to it, and missing identity stays unattributed rather than counted as the main agent. One row is every agent of a provider with the same role and name; instances counts the distinct agents behind it. Forked Codex subagent rollouts record their parent session and agent, so their tokens count under Codex main. A role describes the child, not who started it: a custom role can be launched by another model, and the collected logs do not say whether a user or a model asked for the delegation. {coverage.note}
      </p>
    </Card>
  );
}

/**
 * USG-021: the project and agent breakdowns, side by side on wide screens, each row a reversible filter.
 * A dashboard passes `className="contents"` so the two cards join its own grid, `cardClassName` to size
 * each, and `id` to anchor the pair on the projects card.
 */
export function ProjectAgentBreakdown({ result, filters, onFiltersChange, loading, className = 'grid gap-6 xl:grid-cols-2', cardClassName, id }: {
  result: UsageQueryResult; filters: TokensFilters; onFiltersChange: (next: TokensFilters) => void; loading?: boolean; className?: string; cardClassName?: string; id?: string;
}) {
  if (loading) {
    return (
      <div className={className} data-testid="project-agent-breakdown" aria-busy="true">
        <Card id={id} className={cn('scroll-mt-28 gap-0 overflow-hidden py-0', cardClassName)} aria-label="Projects">
          <CardHeader className="p-4"><CardTitle className="text-base">Projects</CardTitle></CardHeader>
          <EmptyState title="Loading projects…" description="Reading request records in the selected range." className="m-4" />
        </Card>
        <Card className={cn('gap-0 overflow-hidden py-0', cardClassName)} aria-label="Agents">
          <CardHeader className="p-4"><CardTitle className="text-base">Agents</CardTitle></CardHeader>
          <EmptyState title="Loading agents…" description="Reading request records in the selected range." className="m-4" />
        </Card>
      </div>
    );
  }
  return (
    <div className={className} data-testid="project-agent-breakdown">
      <ProjectCard result={result} filters={filters} onFiltersChange={onFiltersChange} className={cardClassName} id={id} />
      <AgentCard result={result} filters={filters} onFiltersChange={onFiltersChange} className={cardClassName} />
    </div>
  );
}

/**
 * Tools grouped by the MCP server, connector, or namespace that provides them. The read already shows a
 * Codex connector's namespace as "<app> (connector)"; the suffix reads as a badge here.
 */
type Server = { key: string; namespace: string | null; invocations: number; tools: { name: string | null; invocations: number }[]; outcomes: Record<string, number> };
const CONNECTOR_SUFFIX = ' (connector)';
const serverKey = (namespace: string | null) => namespace === null ? 'none' : `ns:${namespace}`;

function groupByServer(rows: { namespace: string | null; name: string | null; invocations: number; outcomes?: Record<string, number> }[]): Server[] {
  const servers = new Map<string, Server>();
  for (const row of rows) {
    const key = serverKey(row.namespace);
    const server = servers.get(key) ?? { key, namespace: row.namespace, invocations: 0, tools: [], outcomes: {} };
    server.invocations += row.invocations;
    server.tools.push({ name: row.name, invocations: row.invocations });
    for (const [outcome, n] of Object.entries(row.outcomes ?? {})) server.outcomes[outcome] = (server.outcomes[outcome] ?? 0) + n;
    servers.set(key, server);
  }
  return [...servers.values()]
    .map(server => ({ ...server, tools: [...server.tools].sort((a, b) => b.invocations - a.invocations) }))
    .sort((a, b) => b.invocations - a.invocations || String(a.namespace).localeCompare(String(b.namespace)));
}

function ServerName({ namespace }: { namespace: string | null }) {
  if (namespace === null) return <span className="text-muted-foreground">No server</span>;
  const connector = namespace.endsWith(CONNECTOR_SUFFIX);
  return (
    <>
      <span className="font-mono">{connector ? namespace.slice(0, -CONNECTOR_SUFFIX.length) : namespace}</span>
      {connector ? <Badge variant="outline">connector</Badge> : null}
    </>
  );
}
const serverText = (namespace: string | null) => namespace === null ? 'No server' : namespace;
/** A server's tool count and its busiest tools, which stands in for a Tools column so the bar keeps its room. */
const topToolsLine = (tools: Server['tools'], limit = 2) =>
  [count(tools.length, 'tool'), ...tools.slice(0, limit).map(tool => `${tool.name ?? 'Unnamed tool'} ${exactTokens(tool.invocations)}`)].join(' · ');

/** The chip a server drill-down leaves in the tool view; selecting it widens the list back to every server. */
function ServerChip({ namespace, onClear }: { namespace: string | null; onClear: () => void }) {
  return (
    <button type="button" onClick={onClear} aria-label={`Show tools from every server, not only ${serverText(namespace)}`}
      className="bg-primary/15 text-foreground hover:bg-primary/25 focus-visible:ring-ring/50 inline-flex h-6 items-center gap-1 rounded-full pr-1.5 pl-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2">
      {serverText(namespace)}
      <X aria-hidden="true" className="size-3" />
    </button>
  );
}

type ToolView = 'tool' | 'server';
const TOOL_VIEWS: { value: ToolView; label: string }[] = [{ value: 'tool', label: 'By tool' }, { value: 'server', label: 'By server' }];

/** A breakdown's reading and drill-down: selecting a server switches to its tools, and the chip widens back. */
function useServerDrill(initial: ToolView) {
  const [view, setView] = useState<ToolView>(initial);
  const [server, setServer] = useState<string | null>(null);
  return {
    view, server,
    setView,
    drill: (key: string) => { setServer(key); setView('tool'); },
    clear: () => setServer(null),
  };
}

const toolRowKey = (row: ToolRow) => `${row.synthetic ? 'synthetic' : row.class}:${row.namespace ?? ''}:${row.name ?? ''}:${row.machine ?? ''}`;

/** Every top-level tool, the way the models rank: exec's nested calls are named on its row and broken down beside it. */
function TopTools({ tools, className }: { tools: UsageQueryResult['tools']; className?: string }) {
  const drill = useServerDrill('tool');
  const rows = tools.by_tool.filter(row => !row.synthetic);
  const servers = groupByServer(rows);
  const named = servers.filter(server => server.namespace !== null).length;
  const current = servers.find(server => server.key === drill.server) ?? null;
  const shown = current ? rows.filter(row => serverKey(row.namespace) === current.key) : rows;
  const empty = <div className="p-4"><EmptyState title="No tool invocations in scope" description="Tool events arrive at the requests_with_tools detail level. Hourly buckets and plain request records carry none." actions={<Button size="sm" variant="outline" asChild><Link href="/settings/collection">Open collection settings</Link></Button>} /></div>;
  return (
    <Section
      className={className}
      aria-label="Top tools"
      title="Top tools"
      description={`${count(rows.length, 'tool')}${named ? ` · ${count(named, 'server')}` : ''}, ranked by their own invocations.`}
      actions={rows.length ? (
        <>
          {drill.view === 'tool' && current ? <ServerChip namespace={current.namespace} onClear={drill.clear} /> : null}
          <ViewSwitch label="Top tools view" value={drill.view} options={TOOL_VIEWS} onChange={drill.setView} />
        </>
      ) : null}
    >
      {drill.view === 'server' ? (
        <RankedList
          label="Top tools by server"
          rows={servers}
          rowKey={server => server.key}
          amount={server => server.invocations}
          nameHeader="Server"
          name={server => <ServerName namespace={server.namespace} />}
          detail={server => topToolsLine(server.tools)}
          columns={[
            countColumn<Server>('Invocations', '5.5rem', server => server.invocations, plural('invocation')),
            shareColumn<Server>(server => shareOf(server.invocations, tools.invocations)),
          ]}
          isSelected={server => server.key === drill.server}
          onSelect={server => drill.drill(server.key)}
          noun="servers"
          empty={empty}
        />
      ) : (
        <RankedList
          label={current ? `Top tools from ${serverText(current.namespace)}` : 'Top tools'}
          rows={shown}
          rowKey={toolRowKey}
          amount={row => row.invocations}
          nameHeader="Tool"
          name={row => (
            <>
              <span className={row.name ? 'font-mono' : 'text-muted-foreground'}>{row.name ?? 'Unnamed tool'}</span>
              {row.builtin ? <Badge variant="soft">built-in</Badge> : null}
            </>
          )}
          detail={row => {
            const nested = row.children.reduce((n, child) => n + child.invocations, 0);
            const parts = [
              row.builtin ? null : TOOL_CLASS_LABELS[row.class] ?? row.class,
              current ? null : row.namespace,
              row.machine ? `unnamed on ${row.machine}` : null,
              nested ? `+ ${count(nested, 'nested call')} across ${count(groupByServer(row.children).length, 'server')}` : null,
            ].filter(Boolean);
            return parts.join(' · ');
          }}
          columns={[
            countColumn<ToolRow>('Invocations', '5.5rem', row => row.invocations, plural('invocation')),
            shareColumn<ToolRow>(row => percent(row.share)),
          ]}
          noun="tools"
          empty={empty}
        />
      )}
    </Section>
  );
}

type NestedTool = ChildRow & { key: string; failed: number };

/**
 * What Codex ran through exec: every nested MCP and connector call, by the server that answered it and
 * then by tool, with each bar split by outcome. A nested call whose exec started before the range is
 * kept here too (the read files it under "exec (outside range)"), so the breakdown is one reading.
 */
function InsideExec({ tools, className }: { tools: UsageQueryResult['tools']; className?: string }) {
  const drill = useServerDrill('server');
  const parents = tools.by_tool.filter(row => row.children.length);
  const merged = new Map<string, NestedTool>();
  for (const parent of parents) {
    for (const child of parent.children) {
      const key = JSON.stringify([child.namespace, child.name]);
      const entry = merged.get(key) ?? { key, name: child.name, namespace: child.namespace, invocations: 0, outcomes: {}, failed: 0 };
      entry.invocations += child.invocations;
      for (const [outcome, n] of Object.entries(child.outcomes)) entry.outcomes[outcome] = (entry.outcomes[outcome] ?? 0) + n;
      entry.failed = entry.outcomes.failed ?? 0;
      merged.set(key, entry);
    }
  }
  const calls = [...merged.values()].sort((a, b) => b.invocations - a.invocations || String(a.name).localeCompare(String(b.name)));
  const total = calls.reduce((n, call) => n + call.invocations, 0);
  const failed = calls.reduce((n, call) => n + call.failed, 0);
  const outsideRange = parents.filter(row => row.synthetic).reduce((n, row) => n + row.children.reduce((m, child) => m + child.invocations, 0), 0);
  const servers = groupByServer(calls);
  const current = servers.find(server => server.key === drill.server) ?? null;
  const shown = current ? calls.filter(call => serverKey(call.namespace) === current.key) : calls;
  const outcomes = [...new Set(calls.flatMap(call => Object.keys(call.outcomes)))].sort((a, b) => outcomeRank(a) - outcomeRank(b));
  const failedColumn = <T,>(value: (row: T) => number): RankedColumn<T> => ({
    header: 'Failed', width: '3.5rem', value: row => exactTokens(value(row)), unit: () => 'failed', className: row => value(row) ? 'text-warning' : undefined,
  });
  const name = parents.find(row => !row.synthetic)?.name ?? 'exec';
  return (
    <Section
      className={className}
      aria-label={`Inside ${name}`}
      data-testid="tool-children"
      title={<>Inside <span className="font-mono">{name}</span></>}
      description={
        <>
          {count(total, 'nested call')} · {count(calls.length, 'tool')} · {count(servers.length, 'server')}
          {failed ? <> · <span className="text-warning">{exactTokens(failed)} failed</span></> : null}
          {outsideRange ? ` · ${exactTokens(outsideRange)} under an exec that started before the range` : ''}. Shares are of the nested calls.
        </>
      }
      actions={
        <>
          {drill.view === 'tool' && current ? <ServerChip namespace={current.namespace} onClear={drill.clear} /> : null}
          <ViewSwitch label={`Inside ${name} view`} value={drill.view} options={TOOL_VIEWS} onChange={drill.setView} />
        </>
      }
    >
      {drill.view === 'server' ? (
        <RankedList
          label={`Inside ${name} by server`}
          rows={servers}
          rowKey={server => server.key}
          amount={server => server.invocations}
          segments={server => outcomeSegments(server.outcomes)}
          nameHeader="Server"
          name={server => <ServerName namespace={server.namespace} />}
          detail={server => topToolsLine(server.tools)}
          columns={[
            countColumn<Server>('Calls', '4rem', server => server.invocations, plural('call')),
            shareColumn<Server>(server => shareOf(server.invocations, total)),
            failedColumn<Server>(server => server.outcomes.failed ?? 0),
          ]}
          isSelected={server => server.key === drill.server}
          onSelect={server => drill.drill(server.key)}
          noun="servers"
        />
      ) : (
        <RankedList
          label={current ? `Inside ${name}: ${serverText(current.namespace)}` : `Inside ${name} by tool`}
          rows={shown}
          rowKey={call => call.key}
          amount={call => call.invocations}
          segments={call => outcomeSegments(call.outcomes)}
          nameHeader="Tool"
          name={call => <span className={call.name ? 'font-mono' : 'text-muted-foreground'}>{call.name ?? 'Unnamed tool'}</span>}
          detail={call => [current ? null : serverText(call.namespace), outcomeText(call.outcomes)].filter(Boolean).join(' · ')}
          columns={[
            countColumn<NestedTool>('Calls', '4rem', call => call.invocations, plural('call')),
            shareColumn<NestedTool>(call => shareOf(call.invocations, total)),
            failedColumn<NestedTool>(call => call.failed),
          ]}
          noun="tools"
        />
      )}
      <SegmentLegend className="px-4 pt-2.5 pb-3" label="Bars split by outcome:" items={outcomes.map(outcome => ({ key: outcome, label: outcome === 'unknown' ? 'no outcome recorded' : outcome.replaceAll('_', ' '), color: OUTCOME_COLORS[outcome] ?? MUTED }))} />
    </Section>
  );
}

function TopCallers({ tools, className }: { tools: UsageQueryResult['tools']; className?: string }) {
  const named = (row: CallerRow) => row.state === 'group' || row.state === 'label';
  return (
    <Section className={className} aria-label="Top callers" title="Top callers" description="The agent that issued each invocation, nested calls included.">
      <RankedList
        label="Top callers"
        rows={tools.by_caller}
        rowKey={row => `${row.state}:${row.group_id ?? ''}:${row.provider ?? ''}:${row.role ?? ''}:${row.name ?? ''}`}
        amount={row => row.invocations}
        segments={row => [{ value: row.invocations, label: row.role ?? 'none', color: named(row) ? CLASS_COLORS[agentClass({ role: row.role === 'subagent' || row.role === 'main' ? row.role : 'unattributed', builtin: row.builtin })] : MUTED }]}
        marker={row => <ProviderRing provider={row.provider ?? 'unknown'} />}
        nameHeader="Caller"
        name={row => named(row)
          ? <AgentName name={row.name} role={row.role} builtin={row.builtin} />
          : <span className="text-muted-foreground">{row.state === 'outside_range' ? 'Caller outside range' : 'No caller recorded'}</span>}
        detail={row => named(row) ? <ProviderName provider={row.provider} /> : row.state === 'outside_range' ? 'its request is outside the range' : 'not recorded'}
        columns={[
          countColumn<CallerRow>('Invocations', '5.5rem', row => row.invocations, plural('invocation')),
          shareColumn<CallerRow>(row => shareOf(row.invocations, tools.invocations)),
        ]}
        noun="callers"
        empty={<div className="p-4"><EmptyState title="No caller attribution" description="Callers are named only where an invocation carries its agent or request; none in scope does." /></div>}
      />
    </Section>
  );
}

function KnowledgeSources({ result, className }: { result: UsageQueryResult; className?: string }) {
  const { rows: given, distinct_invocations, note, unsupported_filters } = result.knowledge;
  const rows = [...given].sort((a, b) => b.accesses - a.accesses);
  const configured = rows.filter(row => row.state === 'source');
  const label = (row: KnowledgeRow) => row.label ?? KNOWLEDGE_STATE_LABELS[row.state] ?? row.state;
  const kinds = ACCESS_KINDS.filter(kind => rows.some(row => (row.by_access_kind[kind] ?? 0) > 0));
  return (
    <Section
      className={className}
      aria-label="Knowledge sources"
      data-testid="knowledge-sources"
      title="Knowledge sources"
      description="Tool calls that touched a configured vault or connector, one row per source. Access counts overlap; the distinct tool-call total does not."
      actions={
        <>
          {unsupported_filters.map(entry => <Badge key={entry} variant="soft-warning" title={entry}>{unsupportedFilterLabel(entry, 'knowledge')}</Badge>)}
          <Badge variant="outline">{count(configured.length, 'configured source')}</Badge>
          <Badge variant="outline">{count(distinct_invocations, 'distinct tool call')}</Badge>
          <Button size="xs" variant="outline" asChild><Link href="/settings/sources">Configure sources</Link></Button>
        </>
      }
    >
      <RankedList
        label="Knowledge sources by access"
        rows={rows}
        rowKey={row => `${row.state}:${row.source_id ?? given.indexOf(row)}`}
        amount={row => row.accesses}
        segments={row => ACCESS_KINDS.map(kind => ({ value: row.by_access_kind[kind] ?? 0, label: kind, color: ACCESS_COLORS[kind] }))}
        nameHeader="Source"
        name={row => (
          <>
            <span className={row.state === 'source' ? 'font-medium' : 'text-muted-foreground'}>{label(row)}</span>
            {row.state !== 'source' ? <Badge variant="outline">{row.state === 'unassigned' ? 'not yet named' : 'no identity'}</Badge> : null}
          </>
        )}
        detail={row => [
          ...ACCESS_KINDS.filter(kind => (row.by_access_kind[kind] ?? 0) > 0).map(kind => `${kind} ${exactTokens(row.by_access_kind[kind])}`),
          row.earlier_configuration_accesses ? `${exactTokens(row.earlier_configuration_accesses)} under an earlier configuration` : null,
        ].filter(Boolean).join(' · ')}
        columns={[
          countColumn<KnowledgeRow>('Accesses', '4.5rem', row => row.accesses, plural('access', 'accesses')),
          countColumn<KnowledgeRow>('Tool calls', '4.5rem', row => row.distinct_invocations, plural('tool call')),
          countColumn<KnowledgeRow>('Sessions', '4rem', row => row.distinct_sessions, plural('session')),
          countColumn<KnowledgeRow>('Agents', '3.5rem', row => row.distinct_agents, plural('agent')),
        ]}
        noun="sources"
        empty={<div className="p-4"><EmptyState title="No knowledge-source access in scope" description="Access rows arrive only at the requests_with_tools detail level, from installs with at least one configured source, and only for tool calls the companion could classify against it. A conversation running inside a vault folder is not counted as access." actions={<Button size="sm" variant="outline" asChild><Link href="/settings/sources">Configure sources</Link></Button>} /></div>}
      />
      {rows.length ? <SegmentLegend className="px-4 pt-2.5" label="Bars split by access kind:" items={kinds.map(kind => ({ key: kind, label: kind, color: ACCESS_COLORS[kind] }))} /> : null}
      <p className="text-muted-foreground px-4 pt-2.5 pb-4 text-xs leading-relaxed" data-testid="knowledge-footnote">
        {note ? `${note} ` : ''}Reading or searching a source shows access, not that the answer used its contents, and no token cost is assigned to a source. Unassigned identities have been seen but not yet named under Settings; unknown rows carry no identity the registry can resolve.
      </p>
    </Section>
  );
}

/**
 * USG-022: the final Tokens card - deduplicated tool invocations, what ran inside exec, their callers and
 * outcomes, then the knowledge-source area. Once the card is wide enough its sections pair up: top tools
 * beside what ran inside exec, callers beside knowledge sources.
 */
export function ToolKnowledgeCard({ result, loading, knowledgeLoading, className, id }: { result: UsageQueryResult; loading?: boolean; knowledgeLoading?: boolean } & Placement) {
  if (loading) {
    return (
      <Card id={id} className={cn('scroll-mt-28 gap-0 overflow-hidden py-0', className)} aria-label="Tool calls and knowledge sources" aria-busy="true">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Tool calls and knowledge sources</CardTitle>
          <CardDescription>Reported tool invocations in scope, who issued them, and which knowledge sources they reached.</CardDescription>
        </CardHeader>
        <EmptyState title="Loading tool calls…" description="Reading tool events in the selected range." className="m-4" />
      </Card>
    );
  }
  const { tools, agents, headline } = result;
  const outcomes = Object.entries(tools.by_outcome).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const outcomesCollected = tools.outcome_coverage.classified > 0;
  const nested = tools.by_tool.some(row => row.children.length);
  // Sections take a top border; the left one of each pair also takes a right border once they pair.
  const section = 'border-border border-t';
  const left = '@min-[60rem]/tools:border-r';
  return (
    <Card id={id} className={cn('scroll-mt-28 gap-0 overflow-hidden py-0', className)} aria-label="Tool calls and knowledge sources">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Tool calls and knowledge sources</CardTitle>
        <CardDescription>Reported tool invocations in scope, what ran inside exec, who issued them, and which knowledge sources they reached.</CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-1.5">
          {tools.unsupported_filters.map(entry => <Badge key={entry} variant="soft-warning" title={entry}>{unsupportedFilterLabel(entry, 'tools')}</Badge>)}
        </CardAction>
      </CardHeader>
      <StatGroup className="border-border border-y">
        <Stat label="Tool invocations" value={exactTokens(tools.invocations)} caption="each invocation once; results and status updates are not counted again" />
        <Stat label="Model calls" value={exactTokens(headline.calls)} caption="a separate count: the requests that issued these tools" />
        <Stat label="Agent spawns" value={exactTokens(agents.summary.spawns)} caption="a separate count: delegation attempts, not tool calls" />
        <Stat label="Caller attribution" value={coveragePercent(tools.caller_coverage)} caption={`${exactTokens(tools.caller_coverage.classified)} of ${exactTokens(tools.caller_coverage.headline)} invocations name their caller`} />
      </StatGroup>
      <div className="flex flex-wrap items-center gap-2 p-4 text-xs" data-testid="tool-outcomes">
        <span className="text-muted-foreground">Outcomes</span>
        {outcomesCollected
          ? outcomes.map(([outcome, n]) => <Badge key={outcome} variant={outcome === 'failed' ? 'soft-warning' : outcome === 'unknown' ? 'outline' : 'soft'}>{outcome.replaceAll('_', ' ')} {exactTokens(n)}</Badge>)
          : <span className="text-muted-foreground">not collected for these invocations; success and failure are unknown rather than assumed.</span>}
        {outcomesCollected && tools.outcome_coverage.classified < tools.outcome_coverage.headline ? <span className="text-muted-foreground">· {exactTokens(tools.outcome_coverage.headline - tools.outcome_coverage.classified)} without a recorded outcome</span> : null}
      </div>
      {/* The query container wraps the grid: an element cannot answer a query about its own width. */}
      <div className="@container/tools min-w-0">
      <div className="grid min-w-0 @min-[60rem]/tools:grid-cols-2">
        <TopTools tools={tools} className={cn(section, left)} />
        {nested ? <InsideExec tools={tools} className={section} /> : null}
        <TopCallers tools={tools} className={cn(section, nested && left)} />
        {knowledgeLoading
          ? (
            <section className={cn(section, 'grid gap-3 p-4', !nested && '@min-[60rem]/tools:col-span-2')} aria-label="Knowledge sources" aria-busy="true">
              <EmptyState title="Loading knowledge sources…" description="Reading classified access in the selected range." />
            </section>
          )
          : <KnowledgeSources result={result} className={cn(section, !nested && '@min-[60rem]/tools:col-span-2')} />}
      </div>
      </div>
      <p className="border-border text-muted-foreground mt-auto border-t p-3 text-xs leading-relaxed" data-testid="tools-footnote">
        Tool invocations, model calls, and agent spawns are three different counts and are never summed. A call Codex makes through exec to an MCP server or connector counts once, inside exec, and not again in exec&apos;s own invocations. {tools.caller_coverage.note} {tools.outcome_coverage.note} Tool events and knowledge accesses follow the requests that issued them through the account, project, machine, and agent filters; a model filter cannot be applied to either where no calling request is recorded.
      </p>
    </Card>
  );
}
