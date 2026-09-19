'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { EmptyState, Stat, StatGroup } from '@/components/kit';
import { EnvironmentalImpact } from '@/components/environmental-impact';
import { ProjectAgentBreakdown, ToolKnowledgeCard, agentLabel } from '@/components/usage-breakdown-cards';
import { IntervalBars } from '@/components/usage-chart';
import { UsageInsightCards } from '@/components/usage-insight-cards';
import { UsageFilterBar, type FilterOption, type FilterVocabulary } from '@/components/usage-filter-bar';
import { UsageStatusLine } from '@/components/usage-status-line';
import { useLiveData } from '@/components/telemetry-shared';
import { fetchPrivateJson, USAGE_QUERY_TIMEOUT_MS } from '@/lib/fetch-private-json';
import type { UsageQueryResult } from '@/lib/usage-query';
import {
  compactTokens, compositionView, exactTokens, mergeUsageQuerySection, parseTokensFilters, percent, queryString, seriesSummary, serializeTokensFilters, whenIn,
  USAGE_QUERY_CACHE_TTL_MS, USAGE_QUERY_SECTIONS, type TokensFilters, type UsageQuerySection,
} from '@/lib/usage-view';

/** The agreed Tokens card order; every section below shares this filter bar and query result. */
export const TOKENS_SECTIONS = [
  { key: 'filters', title: 'Filter bar', task: 'USG-017' }, { key: 'total', title: 'Total tokens and composition', task: 'USG-017' }, { key: 'activity', title: 'Tokens over time', task: 'USG-017' },
  { key: 'cost', title: 'API-equivalent cost estimate', task: 'USG-018' }, { key: 'models', title: 'Tokens by model', task: 'USG-018' }, { key: 'environment', title: 'Environmental impact', task: 'USG-020' },
  { key: 'projects_agents', title: 'Project and agent breakdowns', task: 'USG-021' }, { key: 'tools', title: 'Tool calls and knowledge sources', task: 'USG-022' },
] as const;

const SEGMENT_CLASSES = { input_fresh: 'bg-chart-2', input_cached: 'bg-primary', input_cache_write: 'bg-chart-4', output: 'bg-chart-3', unclassified: 'bg-muted-foreground/40' } as const;

export type TokensOverviewProps = {
  filters: TokensFilters; onFiltersChange: (next: TokensFilters) => void;
  result: UsageQueryResult | null; vocabulary: FilterVocabulary;
  /** A refresh failed after a result was shown: the last good result stays up and is marked. */
  error: string | null; stale: boolean; loading: boolean; onRetry: () => void; now: number;
  status?: React.ReactNode;
  /** Request, tool, and knowledge cards load after the headline; omit when the result already includes them. */
  pending?: { requests?: boolean; tools?: boolean; knowledge?: boolean };
};

/** The Tokens overview; headline cards can render before request and tool sections finish. */
export function TokensOverview({ filters, onFiltersChange, result, vocabulary, error, stale, loading, onRetry, now, status, pending }: TokensOverviewProps) {
  // Agent chips take their names from the result itself: the registry has no agent vocabulary, and a drill-down chip should read like the row that made it.
  const labels = useMemo(() => ({
    accounts: Object.fromEntries(vocabulary.accounts.map(o => [o.value, o.label])), projects: Object.fromEntries(vocabulary.projects.map(o => [o.value, o.label])),
    machines: Object.fromEntries(vocabulary.machines.map(o => [o.value, o.label])),
    agents: Object.fromEntries((result?.agents.rows ?? []).filter(row => row.agent_key).map(row => [row.agent_key as string, agentLabel(row)])),
  }), [vocabulary, result]);
  const composition = result ? compositionView(result.headline) : null;
  const summary = result ? seriesSummary(result.series.points) : null;
  const merged = result?.historical.snapshots.filter(s => s.merged !== 'none') ?? [];
  const listedOnly = result?.historical.snapshots.filter(s => s.merged === 'none') ?? [];
  const detail = result?.request_detail;
  const requestDetailPending = !!pending?.requests && !(detail && (detail.covered_tokens > 0 || detail.covered_calls > 0));
  const headline = result?.headline;
  // Labels follow the result's own resolution and zone, so bars from the last good result are never labeled with filters still in flight.
  const shown = { resolution: result?.series.resolution ?? filters.resolution, timezone: result?.scope.range.timezone ?? filters.timezone };

  return (
    <div className="grid gap-6" aria-busy={loading || !!pending?.requests || !!pending?.tools || !!pending?.knowledge}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <UsageFilterBar filters={filters} onChange={onFiltersChange} vocabulary={vocabulary} range={result?.scope.range ?? null} labels={labels} disabled={loading && !result} />
        {status}
      </div>

      {error && (
        <Alert variant={result ? 'warning' : 'destructive'} role="alert">
          <AlertTitle>{result ? 'The latest refresh failed' : 'Usage is temporarily unavailable'}</AlertTitle>
          <AlertDescription>
            <p>{error}{result ? ` The figures below are from ${whenIn(result.as_of, shown.timezone)} and have not changed.` : ''}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>Retry</Button>
          </AlertDescription>
        </Alert>
      )}

      {!result && !error && <EmptyState title="Loading usage…" description="Reading the selected scope from the collected ledgers." />}

      {result && headline && composition && summary && (
        <>
          <Card className="gap-0 overflow-hidden py-0" aria-label="Total tokens and composition">
            <div className="grid lg:grid-cols-[minmax(0,3fr)_minmax(0,7fr)]">
              {/* One figure, centred in its own column: the breakdown beside it is the wide half, and
                  provenance stacks under the number rather than competing with it for the header row. */}
              <CardHeader className="content-center justify-items-center gap-2 p-4 text-center">
                <CardDescription>Observed tokens in the selected scope</CardDescription>
                <CardTitle className="font-mono text-5xl leading-none font-medium tracking-tight tabular-nums sm:text-6xl" data-testid="headline-total">{compactTokens(headline.total_tokens)}</CardTitle>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {loading ? <Badge variant="outline" aria-live="polite">updating…</Badge> : null}
                  {stale ? <Badge variant="soft-warning" title="A refresh failed; these figures are the last good result.">last good · {whenIn(result.as_of, shown.timezone)}</Badge> : null}
                  {headline.basis === 'requests' ? <Badge variant="outline">request detail</Badge> : null}
                  {headline.snapshot_tokens > 0 ? <Badge variant="outline">+ monthly snapshots</Badge> : null}
                </div>
              </CardHeader>
              {/* The breakdown sits beside the total it divides: one reading, not two cards. */}
              <div className="border-border grid content-start gap-3 border-t p-4 lg:border-t-0 lg:border-l">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">Composition</span>
                  {composition.inconsistent ? <Badge variant="soft-warning">components exceed the total</Badge> : null}
                </div>
                {composition.inconsistent ? (
                  <p className="text-muted-foreground text-sm">Known components add up to {exactTokens(composition.classified)} tokens against a reported total of {exactTokens(composition.total)}; shares are withheld rather than clamped.</p>
                ) : (
                  <div className="bg-muted flex h-2.5 overflow-hidden rounded-full" role="img" aria-label={composition.segments.filter(s => s.tokens > 0).map(s => `${s.label} ${percent(s.share)}`).join(', ') || 'no tokens'}>
                    {composition.segments.map(segment => (
                      segment.tokens > 0 ? <span key={segment.key} className={SEGMENT_CLASSES[segment.key]} style={{ width: `${(segment.share ?? 0) * 100}%` }} title={`${segment.label}: ${exactTokens(segment.tokens)}`} /> : null
                    ))}
                  </div>
                )}
                <dl className="grid gap-y-1.5" data-testid="composition-legend">
                  {composition.segments.map(segment => (
                    <div key={segment.key} className="flex items-baseline gap-3">
                      <dt className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                        <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-xs ${SEGMENT_CLASSES[segment.key]}`} />
                        <span className="truncate">{segment.label}</span>
                      </dt>
                      <dd className="shrink-0 font-mono text-xs tabular-nums" data-testid={`composition-${segment.key}`}>{exactTokens(segment.tokens)} <span className="text-muted-foreground inline-block w-11 text-right">{percent(segment.share)}</span></dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
            <StatGroup className="border-border border-t">
              <Stat label="Exact total" value={exactTokens(headline.total_tokens)} caption="tokens · reasoning counted once inside output" />
              <Stat label="Model calls" value={exactTokens(headline.calls)} caption={headline.basis === 'requests' ? 'canonical requests in scope' : 'canonical hourly buckets in scope'} />
              <Stat label="Conversations" value={headline.conversations === null ? '—' : exactTokens(headline.conversations)} caption={headline.basis === 'requests' ? 'distinct sessions with a matching request' : 'distinct sessions in the buckets'} />
              <Stat label="Last observation" value={whenIn(headline.last_observation, shown.timezone)} caption={headline.last_observation ? `${Math.max(0, Math.round((now - Date.parse(headline.last_observation)) / 60_000))} min ago · ${shown.timezone}` : 'nothing observed in scope'} />
            </StatGroup>
            <div className="border-border text-muted-foreground grid gap-1.5 border-t p-3 text-xs leading-relaxed">
              {composition.reasoning !== null || composition.remainder > 0 ? (
                <p>
                  {composition.reasoning !== null ? <>Reasoning is <span className="text-foreground font-mono">{exactTokens(composition.reasoning)}</span> of the output tokens ({percent(composition.reasoning_share_of_output)}) and is not added again. </> : null}
                  {composition.remainder > 0 ? <>{exactTokens(composition.remainder)} tokens are reported only as a total and are shown as unclassified. </> : null}
                </p>
              ) : null}
              {headline.basis === 'requests' && (headline.unfilterable_tokens > 0 || headline.unfilterable_calls > 0) ? (
                <p>
                  The active detail filters apply to request records only. <span className="text-foreground font-mono">{exactTokens(headline.unfilterable_tokens)}</span> tokens and <span className="text-foreground font-mono">{exactTokens(headline.unfilterable_calls)}</span> calls in the selected hourly buckets carry no request detail and are excluded, not matched.
                </p>
              ) : null}
            </div>
          </Card>

          <Card className="gap-0 overflow-hidden py-0" aria-label="Tokens over time">
            <CardHeader className="p-4">
              <CardTitle className="text-base">Tokens over time</CardTitle>
              <CardAction className="flex flex-wrap justify-end gap-1.5">
                {summary.counts.partial ? (
                  <Tooltip>
                    <TooltipTrigger asChild><Badge variant="outline" className="cursor-help">{summary.counts.partial} still observed</Badge></TooltipTrigger>
                    <TooltipContent className="max-w-[20rem]">
                      {summary.counts.partial === 1 ? 'One interval has' : `${summary.counts.partial} intervals have`} not finished yet: the collectors have covered part of {summary.counts.partial === 1 ? 'it' : 'them'}, so {summary.counts.partial === 1 ? 'its bar' : 'those bars'} can still rise as the rest of the interval is observed.
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {summary.counts.missing ? <Badge variant="soft-warning">{summary.counts.missing} without coverage</Badge> : null}
              </CardAction>
            </CardHeader>
            <div className="grid gap-4 px-4 pt-4 pb-4">
              {result.series.points.length ? <IntervalBars points={result.series.points} timezone={shown.timezone} resolution={shown.resolution} /> : <EmptyState title="No intervals in range" />}
            </div>
            <p className="border-border text-muted-foreground border-t p-3 text-xs leading-relaxed" data-testid="series-summary">
              {summary.intervals} intervals · {summary.counts.observed} observed · {summary.counts.zero} recorded as zero · {summary.counts.missing} without collector coverage · {summary.counts.partial} still being observed. Bars sum to {exactTokens(summary.total)} tokens{result.series.excludes_snapshot_tokens > 0 ? `; ${exactTokens(result.series.excludes_snapshot_tokens)} snapshot tokens count in the total but cannot be placed on ${shown.resolution === 'day' ? 'days' : 'hours'}` : ''}.
              {shown.resolution === 'day' ? ' Hourly resolution is offered for ranges up to 14 days.' : ''}
            </p>
          </Card>

          <UsageInsightCards result={result} />
          <EnvironmentalImpact estimate={result.environment} />
          <ProjectAgentBreakdown result={result} filters={filters} onFiltersChange={onFiltersChange} loading={!!pending?.requests} />
          <ToolKnowledgeCard result={result} loading={!!pending?.tools} knowledgeLoading={!!pending?.knowledge} />

          <Card className="gap-0 overflow-hidden py-0" aria-label="Coverage and sources">
            <CardHeader className="p-4">
              <CardTitle className="text-base">What this scope covers</CardTitle>
              <CardDescription>Where the figures come from and what they leave out.</CardDescription>
            </CardHeader>
            <StatGroup className="border-border border-y">
              <Stat label="Request detail" value={requestDetailPending ? '…' : percent(detail ? detail.coverage.applicable * detail.coverage.complete : null)} caption={requestDetailPending ? 'reading request records in the selected range' : detail ? `${exactTokens(detail.covered_tokens)} of ${exactTokens(detail.coverage.headline)} headline tokens carry request records` : ''} />
              <Stat label="Monthly snapshots" value={merged.length ? exactTokens(headline.snapshot_tokens) : '0'} caption={merged.length ? `tokens merged from ${merged.length} snapshot${merged.length === 1 ? '' : 's'} where hourly history has nothing` : 'none merged into this scope'} />
              <Stat label="Range" value={result.scope.range.anchored_to_now ? 'to now' : 'closed'} caption={`${result.scope.range.preset.replaceAll('_', ' ')} · ${result.scope.range.timezone}`} />
            </StatGroup>
            <div className="grid gap-3 p-4 text-sm">
              {merged.length ? (
                <ul className="text-muted-foreground grid gap-1 text-xs" data-testid="merged-snapshots">
                  {merged.map(s => <li key={`${s.subject_key}:${s.month}`}>{s.machine_name ?? s.subject_key} · {s.month} · {s.merged === 'month' ? 'whole month merged' : 'whole source days merged'} · {exactTokens(s.merged_tokens)} tokens · method {s.methodology_version ?? 'not recorded'}</li>)}
                </ul>
              ) : null}
              {listedOnly.length ? (
                <p className="text-muted-foreground text-xs">{listedOnly.length} stored monthly snapshot{listedOnly.length === 1 ? '' : 's'} in this range {listedOnly.length === 1 ? 'is' : 'are'} listed and not counted: {[...new Set(listedOnly.map(s => s.reason ?? 'no reason'))].map(r => r.replaceAll('_', ' ')).join('; ')}.</p>
              ) : null}
              {result.unsupported.length ? <ul className="grid gap-1 text-xs" data-testid="unsupported">{result.unsupported.map(note => <li key={note} className="text-warning">{note}</li>)}</ul> : null}
              {result.notes.length ? <ul className="text-muted-foreground grid gap-1 text-xs" data-testid="notes">{result.notes.map(note => <li key={note}>{note}</li>)}</ul> : null}
              <p className="text-muted-foreground text-xs">Local logs do not cover browser or cloud conversations; those move account allowances without exposing tokens here. Configure collectors and project names under <Link href="/settings" className="underline underline-offset-4">Settings</Link>.</p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

type ProjectsRegistry = { projects: { id: string; label: string }[] };
type SectionPending = { requests: boolean; tools: boolean; knowledge: boolean };

const clientCache = new Map<string, { expires: number; value: UsageQueryResult }>();
function cacheKey(query: string, section: UsageQuerySection) { return `${query}|${section}`; }
function readClientCache(query: string, section: UsageQuerySection) {
  const key = cacheKey(query, section);
  const hit = clientCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  clientCache.delete(key);
  return null;
}
function writeClientCache(query: string, section: UsageQuerySection, value: UsageQueryResult) {
  if (clientCache.size >= 32) clientCache.delete(clientCache.keys().next().value!);
  clientCache.set(cacheKey(query, section), { expires: Date.now() + USAGE_QUERY_CACHE_TTL_MS, value });
}

/** Owns the private URL state and the bounded poll; renders the overview from the last good result. */
function TokensOverviewLiveInner() {
  const router = useRouter(), pathname = usePathname(), searchParams = useSearchParams();
  const urlFilters = useMemo(() => parseTokensFilters(new URLSearchParams(searchParams.toString())), [searchParams]);
  // Filters change locally at once, so quick successive toggles compose; the URL follows and, when it changes on its own, wins.
  const [filters, setFilters] = useState(urlFilters);
  useEffect(() => { setFilters(urlFilters); }, [urlFilters]);
  const query = queryString(filters);
  const [result, setResult] = useState<UsageQueryResult | null>(null);
  const [resultQuery, setResultQuery] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<SectionPending>({ requests: true, tools: true, knowledge: true });
  const [now, setNow] = useState(0);
  const [projects, setProjects] = useState<ProjectsRegistry['projects']>([]);
  const live = useLiveData();
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const filterError = (caught: unknown) => caught instanceof Error && /\(4\d\d\)/.test(caught.message)
      ? 'The selected filters were not accepted. Adjust the period or remove a filter.'
      : 'Usage is temporarily unavailable. Retry, or wait for the next refresh.';
    const loadSection = async (section: UsageQuerySection) => {
      const cached = readClientCache(query, section);
      if (cached) return cached;
      const params = new URLSearchParams(query);
      params.set('section', section);
      const value = await fetchPrivateJson<UsageQueryResult>(`/api/usage-query?${params}`, controller.signal, USAGE_QUERY_TIMEOUT_MS, false);
      writeClientCache(query, section, value);
      return value;
    };
    const refresh = async () => {
      if (document.hidden || inFlight || controller.signal.aborted) return;
      inFlight = true; setNow(Date.now());
      const cached = Object.fromEntries(USAGE_QUERY_SECTIONS.map(section => [section, readClientCache(query, section)])) as Record<UsageQuerySection, UsageQueryResult | null>;
      const overlay = (base: UsageQueryResult) => USAGE_QUERY_SECTIONS.slice(1).reduce(
        (result, section) => cached[section] ? mergeUsageQuerySection(result, section, cached[section]!) : result, base,
      );
      if (cached.overview && cached.requests && cached.tools && cached.knowledge) {
        setResult(overlay(cached.overview));
        setResultQuery(query); setError(null); setLoading(false); setPending({ requests: false, tools: false, knowledge: false });
        inFlight = false; return;
      }
      try {
        if (!cached.overview) setLoading(true);
        const overview = cached.overview ?? await loadSection('overview');
        if (controller.signal.aborted) return;
        const merged = { current: overlay(overview) };
        setResult(merged.current); setResultQuery(query); setError(null); setLoading(false);
        setPending({ requests: !cached.requests, tools: !cached.tools, knowledge: !cached.knowledge });
        const later: UsageQuerySection[] = ['requests', 'tools', 'knowledge'];
        await Promise.all(later.map(async section => {
          if (cached[section]) {
            setPending(current => ({ ...current, [section]: false }));
            return;
          }
          try {
            const part = await loadSection(section);
            if (controller.signal.aborted) return;
            merged.current = mergeUsageQuerySection(merged.current, section, part);
            setResult(merged.current);
          } catch (caught) {
            if (!controller.signal.aborted) setError(filterError(caught));
          } finally {
            if (!controller.signal.aborted) setPending(current => ({ ...current, [section]: false }));
          }
        }));
      } catch (caught) {
        if (!controller.signal.aborted) setError(filterError(caught));
      } finally { inFlight = false; if (!controller.signal.aborted) setLoading(false); }
    };
    retry.current = () => { void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh(); const timer = setInterval(refresh, USAGE_QUERY_CACHE_TTL_MS);
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    fetchPrivateJson<ProjectsRegistry>('/api/usage-projects', controller.signal).then(registry => { if (!controller.signal.aborted) setProjects(registry.projects); }).catch(() => {});
    return () => controller.abort();
  }, []);

  const onFiltersChange = useCallback((next: TokensFilters) => {
    setFilters(next);
    const params = serializeTokensFilters(next).toString();
    router.replace(params ? `${pathname}?${params}` : pathname, { scroll: false });
  }, [router, pathname]);

  // Vocabularies accumulate across results, so narrowing to one account or model never hides the others from the pickers.
  const [seen, setSeen] = useState<{ accounts: Map<string, FilterOption>; machines: Map<string, FilterOption>; models: Map<string, FilterOption>; efforts: Map<string, FilterOption> }>(() => ({ accounts: new Map(), machines: new Map(), models: new Map(), efforts: new Map() }));
  useEffect(() => {
    if (!result) return;
    setSeen(current => {
      const next = { accounts: new Map(current.accounts), machines: new Map(current.machines), models: new Map(current.models), efforts: new Map(current.efforts) };
      for (const a of result.scope.accounts) next.accounts.set(a.id, { value: a.id, label: a.label, hint: a.provider });
      for (const mach of result.scope.machines) next.machines.set(mach.id, { value: mach.id, label: mach.machine_label, hint: mach.mode });
      for (const m of result.by_model) next.models.set(m.model, { value: m.model, label: m.model });
      for (const r of result.pricing_inputs.rows) { const e = r.reasoning_effort ?? 'unknown'; next.efforts.set(e, { value: e, label: e }); }
      return next;
    });
  }, [result]);
  const vocabulary = useMemo<FilterVocabulary>(() => {
    const accounts = new Map(seen.accounts);
    for (const a of live.data?.accounts ?? []) if (!accounts.has(a.id)) accounts.set(a.id, { value: a.id, label: a.label, hint: a.provider });
    const sorted = (map: Map<string, FilterOption>) => [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
    return { accounts: sorted(accounts), projects: projects.map(p => ({ value: p.id, label: p.label })), machines: sorted(seen.machines), models: sorted(seen.models), efforts: sorted(seen.efforts) };
  }, [seen, live.data, projects]);

  // The last good result stays up: marked stale after a failed refresh, and marked loading while a changed query is in flight.
  return (
    <TokensOverview filters={filters} onFiltersChange={onFiltersChange} result={result} vocabulary={vocabulary}
      error={error} stale={!!error && !!result} loading={loading || (result !== null && resultQuery !== query)} onRetry={() => retry.current()} now={now || Date.now()}
      pending={resultQuery === query ? pending : { requests: true, tools: true, knowledge: true }}
      status={<UsageStatusLine data={live.data} now={live.now} error={live.error} />} />
  );
}

export function TokensOverviewLive() {
  return <Suspense fallback={<EmptyState title="Loading usage…" />}><TokensOverviewLiveInner /></Suspense>;
}
