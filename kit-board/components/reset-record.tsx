'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/kit';
import { ResetIcon, RESET_TYPE_STYLES } from '@/components/reset-dot';
import { Choice, when } from '@/components/telemetry-shared';
import { ResetCalendar } from '@/components/reset-calendar';
import { RESET_EVENT_LABELS, RESET_PROVIDERS, matchesResetType, resetDay, resetEntryKey, resetEventType, resetPlanned, resetProviderLabel, resetProviderOrder, resetTypes } from '@/lib/reset-calendar';
import { providerColor } from '@/lib/provider-colors';
import { resetFeedFailureLabel } from '@/lib/reset-feed-errors';
import { resetFeedCoverageNotes } from '@/lib/nextreset-feeds';
import type { ResetDocument } from '@/lib/reset-feeds';

type Feed = { source: string; label: string; url: string; provider: string; succeeded_at: string | null; checked_at: string | null; error: string | null; revisions: number; payload: ResetDocument | null };
type SyncResult = { source: string; ok?: boolean; error?: string; cached?: boolean; unchanged?: boolean };

/**
 * The reset calendar and its record (USG-024), as a section rather than a destination: reset tracking
 * belongs beside the allowance windows it explains, so this is everything the old page rendered apart
 * from the page chrome, and the manual feed check now sits with the filters it re-runs.
 */
export function ResetRecord() {
  const [feeds, setFeeds] = useState<Feed[]>([]), [provider, setProvider] = useState('all'), [kind, setKind] = useState('all'), [error, setError] = useState(''), [busy, setBusy] = useState(true);
  const [limit, setLimit] = useState(10);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  async function refresh(signal?: AbortSignal) {
    setBusy(true);
    try {
      const r = await fetch('/api/reset-feeds', { method: 'POST', signal });
      const data = await r.json() as { feeds?: Feed[]; results?: SyncResult[] };
      if (!data.feeds) throw new Error();
      setFeeds(data.feeds);
      const failed = (data.results ?? []).filter(result => result.ok === false);
      const unavailable = failed.length
        ? failed.map(result => `${data.feeds?.find(feed => feed.source === result.source)?.label ?? result.source}: ${resetFeedFailureLabel(result.error)}`).join('; ')
        : data.feeds.filter(feed => feed.error).map(feed => `${feed.label}: ${resetFeedFailureLabel(feed.error)}`).join('; ');
      setError(unavailable ? `Some feeds are using saved data. ${unavailable}` : '');
      if (!r.ok && r.status !== 207) throw new Error();
    }
    catch { if (!signal?.aborted) setError('Refresh unavailable. Showing the last saved feeds.'); }
    finally { if (!signal?.aborted) setBusy(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/reset-feeds', { signal: controller.signal }).then(r => r.ok ? r.json() : Promise.reject()).then(d => setFeeds(d.feeds)).catch(() => {}).finally(() => { if (!controller.signal.aborted) void refresh(controller.signal); });
    return () => controller.abort();
  }, []);

  const byUrl = new Map<string, { item: NonNullable<Feed['payload']>['items'][number]; feed: Feed }>();
  // Prefer the curated timeline over the same post in the announcement stream.
  for (const feed of [...feeds].sort((a, b) => Number(a.source === 'nextreset-timeline') - Number(b.source === 'nextreset-timeline'))) {
    for (const item of feed.payload?.items ?? []) byUrl.set(resetEntryKey(item), { item, feed });
  }
  // Every provider a feed can name is offered, plus any other one an entry carries, so a new feed shows up in the filter.
  const providers = [...new Set([...RESET_PROVIDERS.filter(name => feeds.some(feed => feed.provider === name)), ...[...byUrl.values()].map(({ item }) => item.provider)])].sort((a, b) => resetProviderOrder(a) - resetProviderOrder(b));
  const items = [...byUrl.values()].filter(({ item }) => (provider === 'all' || item.provider === provider) && matchesResetType(item, kind)).sort((a, b) => resetDay(b.item).localeCompare(resetDay(a.item)) || b.item.at.localeCompare(a.item.at));
  const visibleItems = selectedDay ? items.filter(({ item }) => resetDay(item) === selectedDay) : items;
  const stale = (f: Feed) => !!f.error || !f.succeeded_at || Date.now() - Date.parse(f.succeeded_at) > 26 * 3_600_000 || !!f.payload?.upstream_stale || (f.payload?.coverage && Date.now() - Date.parse(f.payload.coverage.checked_at) > 45 * 60_000);
  const coverageNotes = [...new Set(feeds.flatMap(f => resetFeedCoverageNotes(f.payload)))];

  // The calendar sits beside the record once both have room; narrower, it runs above the record with its
  // legend beside the month, and on a phone the legend wraps under it.
  return (
    <div className="@container/reset grid gap-4">
      {error && (
        <Alert variant="warning" role="alert">
          <AlertTitle>Some feeds are stale</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {coverageNotes.length > 0 && (
        <Alert variant="warning" role="status">
          <AlertTitle>Feed coverage limited</AlertTitle>
          <AlertDescription>NextReset: {coverageNotes.join('; ')}. Saved history is available, but newer announcements may be missing.</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap gap-4">
          <Choice label="Provider" value={provider} onChange={value => { setProvider(value); setSelectedDay(null); setLimit(10); }} options={[{ value: 'all', label: 'All providers' }, ...providers.map(name => ({ value: name, label: resetProviderLabel(name) }))]} />
          <Choice label="Show" value={kind} onChange={value => { setKind(value); setSelectedDay(null); setLimit(10); }} options={[{ value: 'all', label: 'All reset types' }, ...resetTypes]} />
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking…' : 'Check feeds'}</Button>
      </div>

      <div className="grid gap-4 @6xl/reset:grid-cols-[minmax(0,40rem)_minmax(0,1fr)] @6xl/reset:items-start">
        {/* Beside the record the calendar stays in view while the record scrolls, below the sticky header and jump links. */}
        <div className="min-w-0 @6xl/reset:sticky @6xl/reset:top-28">
          <ResetCalendar items={items.map(entry => entry.item)} selectedDay={selectedDay} onSelectDay={day => { setSelectedDay(day); setLimit(10); }} busy={busy} />
        </div>

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">{selectedDay ? `Events · ${selectedDay} UTC` : 'Reset record'}</CardTitle>
            {/*
              USG-024 asks the reader to be told, where they read them, that these are the providers'
              own claims. That sentence used to live in a numbered section heading above the page; it
              belongs to the record itself, so it moved in here when the page chrome came off.
            */}
            <CardDescription>
              Public feed claims about Codex global resets and Claude window flushes — not readings from this
              Observatory, and never an account&apos;s own reset anchor. Codex global and banked resets stay
              separate from Claude allowance-window flushes. Select a day to narrow the record.
            </CardDescription>
          </CardHeader>

          <CardContent className="p-4">
            {!visibleItems.length ? (
              <EmptyState
                title={busy ? 'Loading the reset record…' : 'No matching entries'}
                description={busy ? undefined : selectedDay ? 'No matching entries on this day in the saved feeds.' : 'No matching entries in the saved feeds.'}
                actions={selectedDay && !busy ? <Button size="sm" variant="outline" onClick={() => setSelectedDay(null)}>Clear the day filter</Button> : undefined}
              />
            ) : (
              <div className="grid gap-3">
                {visibleItems.slice(0, limit).map(({ item, feed }) => (
                  <article key={resetEntryKey(item)} className="border-border grid grid-cols-[40px_32px_minmax(0,1fr)] gap-3 border-b pb-3 last:border-b-0 last:pb-0">
                    <div className="pt-0.5 text-center">
                      <span className="block font-mono text-xs font-medium">
                        {new Date(`${resetDay(item)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                      </span>
                      <span className="text-muted-foreground block font-mono text-[10px]">{resetDay(item).slice(0, 4)}</span>
                    </div>
                    <ResetIcon type={resetEventType(item)} provider={item.provider} planned={resetPlanned(item)} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                        <span className="font-semibold" style={{ color: providerColor(item.provider) }}>{resetProviderLabel(item.provider)}</span>
                        <span aria-hidden="true" className="text-muted-foreground">·</span>
                        <span className="font-medium" style={{ color: RESET_TYPE_STYLES[resetEventType(item)].color }}>{RESET_EVENT_LABELS[resetEventType(item)]}</span>
                        <Badge variant="outline" className="ml-0.5">{item.category === 'history' ? 'Reported' : item.category === 'announcement' ? 'Announced / update' : 'Forecast'}</Badge>
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {item.status.replaceAll('_', ' ')}{stale(feed) ? ' · stale source' : ''}
                        </span>
                      </div>
                      <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-primary mt-1 block text-sm font-semibold underline-offset-4 hover:underline">
                        {item.title.split('\n')[0]}
                      </a>
                      {item.title.includes('\n') && (
                        <details className="mt-1">
                          <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[11px]">Read source context</summary>
                          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{item.title.slice(item.title.indexOf('\n') + 1)}</p>
                        </details>
                      )}
                      <p className="text-muted-foreground mt-1.5 font-mono text-[11px] leading-snug">
                        {feed.label}{item.scope ? ` · ${item.scope}` : ''}{item.confidence ? ` · ${item.confidence} confidence` : ''}{item.banked_state ? ` · banked: ${item.banked_state.replaceAll('_', ' ')}` : ''}{item.verification_status && item.verification_status !== item.status ? ` · verification: ${item.verification_status.replaceAll('_', ' ')}` : ''}{item.effective_at ? ` · ${item.category === 'history' ? 'effective' : 'expected'} ${when(item.effective_at)}` : ''}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {visibleItems.length > limit && (
              <Button variant="ghost" size="sm" className="mt-3" onClick={() => setLimit(n => n + 20)}>
                Show more ({visibleItems.length - limit})
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-muted-foreground text-xs leading-relaxed">
        Feed health and provenance moved to <Link href="/settings/feeds" className="underline underline-offset-4">Settings → Reset feeds</Link>.{' '}
        Independent sources may revise or retract claims; the latest fetched revision is displayed and earlier snapshots remain stored.
      </p>
    </div>
  );
}
