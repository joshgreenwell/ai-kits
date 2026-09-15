'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, Stat, StatGroup } from '@/components/kit';
import { IntervalBars } from '@/components/usage-chart';
import { UsageFilterBar, type FilterOption, type FilterVocabulary } from '@/components/usage-filter-bar';
import { UsageStatusLine } from '@/components/usage-status-line';
import { useLiveData } from '@/components/telemetry-shared';
import { fetchPrivateJson } from '@/lib/fetch-private-json';
import type { UsageQueryResult } from '@/lib/usage-query';
import {
  STATE_LABELS, compactTokens, compositionView, exactTokens, intervalLabel, parseTokensFilters, percent, queryString, seriesSummary, serializeTokensFilters, whenIn, type TokensFilters,
} from '@/lib/usage-view';

/** The agreed Tokens card order; the cards after the activity chart arrive in their own tasks and share this filter bar. */
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
};

/** The Tokens overview from one query result; every number below the filter bar comes from that result. */
export function TokensOverview({ filters, onFiltersChange, result, vocabulary, error, stale, loading, onRetry, now, status }: TokensOverviewProps) {
  const labels = useMemo(() => ({
    accounts: Object.fromEntries(vocabulary.accounts.map(o => [o.value, o.label])), projects: Object.fromEntries(vocabulary.projects.map(o => [o.value, o.label])),
    machines: Object.fromEntries(vocabulary.machines.map(o => [o.value, o.label])),
  }), [vocabulary]);
  const composition = result ? compositionView(result.headline) : null;
  const summary = result ? seriesSummary(result.series.points) : null;
  const merged = result?.historical.snapshots.filter(s => s.merged !== 'none') ?? [];
  const listedOnly = result?.historical.snapshots.filter(s => s.merged === 'none') ?? [];
  const detail = result?.request_detail;
  const headline = result?.headline;
  // Labels follow the result's own resolution and zone, so bars from the last good result are never labeled with filters still in flight.
  const shown = { resolution: result?.series.resolution ?? filters.resolution, timezone: result?.scope.range.timezone ?? filters.timezone };

  return (
    <div className="grid gap-6" aria-busy={loading}>
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
          <Card className="gap-0 overflow-hidden py-0" aria-label="Total observed tokens">
            <CardHeader className="p-4">
              <CardDescription>Observed tokens in the selected scope</CardDescription>
              <CardTitle className="font-mono text-4xl leading-none font-medium tracking-tight tabular-nums" data-testid="headline-total">{compactTokens(headline.total_tokens)}</CardTitle>
              <CardAction className="flex flex-wrap items-center gap-2">
                {loading ? <Badge variant="outline" aria-live="polite">updating…</Badge> : null}
                {stale ? <Badge variant="soft-warning" title="A refresh failed; these figures are the last good result.">last good · {whenIn(result.as_of, shown.timezone)}</Badge> : null}
                <Badge variant="outline">{headline.basis === 'requests' ? 'request detail' : 'hourly buckets'}{headline.snapshot_tokens > 0 ? ' + monthly snapshots' : ''}</Badge>
              </CardAction>
            </CardHeader>
            <StatGroup className="border-border border-t">
              <Stat label="Exact total" value={exactTokens(headline.total_tokens)} caption="tokens · reasoning counted once inside output" />
              <Stat label="Model calls" value={exactTokens(headline.calls)} caption={headline.basis === 'requests' ? 'canonical requests in scope' : 'canonical hourly buckets in scope'} />
              <Stat label="Conversations" value={headline.conversations === null ? '—' : exactTokens(headline.conversations)} caption={headline.basis === 'requests' ? 'distinct sessions with a matching request' : 'distinct sessions in the buckets'} />
              <Stat label="Last observation" value={whenIn(headline.last_observation, shown.timezone)} caption={headline.last_observation ? `${Math.max(0, Math.round((now - Date.parse(headline.last_observation)) / 60_000))} min ago · ${shown.timezone}` : 'nothing observed in scope'} />
            </StatGroup>
            {headline.basis === 'requests' && (headline.unfilterable_tokens > 0 || headline.unfilterable_calls > 0) ? (
              <p className="border-border text-muted-foreground border-t px-4 py-3 text-xs leading-relaxed">
                The active detail filters apply to request records only. <span className="text-foreground font-mono">{exactTokens(headline.unfilterable_tokens)}</span> tokens and <span className="text-foreground font-mono">{exactTokens(headline.unfilterable_calls)}</span> calls in the selected hourly buckets carry no request detail and are excluded, not matched.
              </p>
            ) : null}
          </Card>

          <Card aria-label="Token composition">
            <CardHeader>
              <CardTitle className="text-base">Composition</CardTitle>
              <CardDescription>Exclusive categories that reconcile to the total. Cached input is part of the observed workload even when it is priced differently.</CardDescription>
              {composition.inconsistent ? <CardAction><Badge variant="soft-warning">components exceed the total</Badge></CardAction> : null}
            </CardHeader>
            <CardContent className="grid gap-4">
              {composition.inconsistent ? (
                <p className="text-muted-foreground text-sm">Known components add up to {exactTokens(composition.classified)} tokens against a reported total of {exactTokens(composition.total)}; shares are withheld rather than clamped.</p>
              ) : (
                <div className="border-border flex h-4 overflow-hidden rounded-sm border" role="img" aria-label={composition.segments.filter(s => s.tokens > 0).map(s => `${s.label} ${percent(s.share)}`).join(', ') || 'no tokens'}>
                  {composition.segments.map(segment => (
                    segment.tokens > 0 ? <span key={segment.key} className={SEGMENT_CLASSES[segment.key]} style={{ width: `${(segment.share ?? 0) * 100}%` }} title={`${segment.label}: ${exactTokens(segment.tokens)}`} /> : null
                  ))}
                </div>
              )}
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-5" data-testid="composition-legend">
                {composition.segments.map(segment => (
                  <div key={segment.key} className="grid gap-0.5">
                    <dt className="flex items-center gap-2 text-xs"><span aria-hidden="true" className={`inline-block size-2.5 rounded-xs ${SEGMENT_CLASSES[segment.key]}`} />{segment.label}</dt>
                    <dd className="font-mono text-sm tabular-nums" data-testid={`composition-${segment.key}`}>{exactTokens(segment.tokens)} <span className="text-muted-foreground text-xs">{percent(segment.share)}</span></dd>
                  </div>
                ))}
              </dl>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {composition.reasoning !== null ? <>Reasoning is <span className="text-foreground font-mono">{exactTokens(composition.reasoning)}</span> of the output tokens ({percent(composition.reasoning_share_of_output)}) and is not added again. </> : <>Reasoning within output is not reported separately for this scope. </>}
                {composition.remainder > 0 ? <>{exactTokens(composition.remainder)} tokens are reported only as a total and are shown as unclassified. </> : null}
              </p>
            </CardContent>
          </Card>

          <Card aria-label="Tokens over time">
            <CardHeader>
              <CardTitle className="text-base">Tokens over time</CardTitle>
              <CardDescription>{shown.resolution === 'day' ? 'Daily' : 'Hourly'} totals in {shown.timezone}. Hover, tap, or arrow through the bars for the exact interval.</CardDescription>
              <CardAction className="flex flex-wrap gap-2">
                {summary.counts.partial ? <Badge variant="outline">{summary.counts.partial} still observed</Badge> : null}
                {summary.counts.missing ? <Badge variant="soft-warning">{summary.counts.missing} without coverage</Badge> : null}
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4">
              {result.series.points.length ? <IntervalBars points={result.series.points} timezone={shown.timezone} resolution={shown.resolution} /> : <EmptyState title="No intervals in range" />}
              <p className="text-muted-foreground text-xs leading-relaxed" data-testid="series-summary">
                {summary.intervals} intervals · {summary.counts.observed} observed · {summary.counts.zero} recorded as zero · {summary.counts.missing} without collector coverage · {summary.counts.partial} still being observed. Bars sum to {exactTokens(summary.total)} tokens{result.series.excludes_snapshot_tokens > 0 ? `; ${exactTokens(result.series.excludes_snapshot_tokens)} snapshot tokens count in the total but cannot be placed on ${shown.resolution === 'day' ? 'days' : 'hours'}` : ''}.
                {shown.resolution === 'day' ? ' Hourly resolution is offered for ranges up to 14 days.' : ''}
              </p>
              <details>
                <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[11px]">View interval values</summary>
                <div className="border-border mt-3 max-h-72 overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="bg-card uppercase">Interval</TableHead><TableHead className="bg-card uppercase">State</TableHead><TableHead className="bg-card text-right uppercase">Tokens</TableHead><TableHead className="bg-card text-right uppercase">Calls</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {result.series.points.map(point => (
                        <TableRow key={point.start} className="even:bg-foreground/[0.03] border-b-0">
                          <TableCell className="font-mono text-xs">{intervalLabel(point, shown.timezone, shown.resolution)}</TableCell>
                          <TableCell className="text-muted-foreground font-mono text-xs">{STATE_LABELS[point.state]}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{exactTokens(point.total_tokens)}</TableCell>
                          <TableCell className="text-right font-mono text-xs tabular-nums">{exactTokens(point.calls)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </details>
            </CardContent>
          </Card>

          <Card aria-label="Coverage and sources">
            <CardHeader>
              <CardTitle className="text-base">What this scope covers</CardTitle>
              <CardDescription>Where the figures come from and what they leave out.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <StatGroup className="border-border rounded-md border">
                <Stat label="Request detail" value={percent(detail ? detail.coverage.applicable * detail.coverage.complete : null)} caption={detail ? `${exactTokens(detail.covered_tokens)} of ${exactTokens(detail.coverage.headline)} headline tokens carry request records` : ''} />
                <Stat label="Monthly snapshots" value={merged.length ? exactTokens(headline.snapshot_tokens) : '0'} caption={merged.length ? `tokens merged from ${merged.length} snapshot${merged.length === 1 ? '' : 's'} where hourly history has nothing` : 'none merged into this scope'} />
                <Stat label="Range" value={result.scope.range.anchored_to_now ? 'to now' : 'closed'} caption={`${result.scope.range.preset.replaceAll('_', ' ')} · ${result.scope.range.timezone}`} />
              </StatGroup>
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
            </CardContent>
          </Card>

          <p className="text-muted-foreground text-xs leading-relaxed" data-testid="section-order">
            Next in this order, sharing the filter bar above: {TOKENS_SECTIONS.filter(s => s.task !== 'USG-017').map(s => `${s.title} (${s.task})`).join(', ')}.
          </p>
        </>
      )}
    </div>
  );
}

type ProjectsRegistry = { projects: { id: string; label: string }[] };

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
  const [now, setNow] = useState(0);
  const [projects, setProjects] = useState<ProjectsRegistry['projects']>([]);
  const live = useLiveData();
  const retry = useRef<() => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (document.hidden || inFlight || controller.signal.aborted) return;
      inFlight = true; setLoading(true); setNow(Date.now());
      try {
        const next = await fetchPrivateJson<UsageQueryResult>(`/api/usage-query${query ? `?${query}` : ''}`, controller.signal);
        if (!controller.signal.aborted) { setResult(next); setResultQuery(query); setError(null); }
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error && /\(4\d\d\)/.test(caught.message) ? 'The selected filters were not accepted. Adjust the period or remove a filter.' : 'Usage is temporarily unavailable. Retry, or wait for the next refresh.');
      } finally { inFlight = false; if (!controller.signal.aborted) setLoading(false); }
    };
    retry.current = () => { void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh(); const timer = setInterval(refresh, 60_000);
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
      status={<UsageStatusLine data={live.data} now={live.now} error={live.error} />} />
  );
}

export function TokensOverviewLive() {
  return <Suspense fallback={<EmptyState title="Loading usage…" />}><TokensOverviewLiveInner /></Suspense>;
}
