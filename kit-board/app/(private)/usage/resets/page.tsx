'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ListRow, ListRows, Stat, StatGroup } from '@/components/kit';
import { ResetDot } from '@/components/reset-dot';
import { Choice, when } from '@/components/telemetry-shared';
import { ResetCalendar } from '@/components/reset-calendar';
import { matchesResetType, resetDay, resetEntryKey, resetMarker, resetTypeLabel, resetTypes } from '@/lib/reset-calendar';
import type { ResetDocument } from '@/lib/reset-feeds';

type Feed = { source: string; label: string; url: string; provider: string; succeeded_at: string | null; checked_at: string | null; error: string | null; revisions: number; payload: ResetDocument | null };

export default function Resets() {
  const [feeds, setFeeds] = useState<Feed[]>([]), [provider, setProvider] = useState('all'), [kind, setKind] = useState('all'), [error, setError] = useState(''), [busy, setBusy] = useState(true);
  const [limit, setLimit] = useState(10);
  const [selectedDay, setSelectedDay] = useState<string | null>(null), [previewAnnouncement, setPreviewAnnouncement] = useState(false);

  async function refresh(signal?: AbortSignal) {
    setBusy(true);
    try { const r = await fetch('/api/reset-feeds', { method: 'POST', signal }); if (!r.ok) throw new Error(); setFeeds((await r.json()).feeds); setError(''); }
    catch { if (!signal?.aborted) setError('Refresh unavailable. Showing the last saved feeds.'); }
    finally { if (!signal?.aborted) setBusy(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    if (process.env.NODE_ENV !== 'production') setPreviewAnnouncement(new URLSearchParams(window.location.search).get('preview') === 'announcement');
    fetch('/api/reset-feeds', { signal: controller.signal }).then(r => r.ok ? r.json() : Promise.reject()).then(d => setFeeds(d.feeds)).catch(() => {}).finally(() => { if (!controller.signal.aborted) void refresh(controller.signal); });
    return () => controller.abort();
  }, []);

  const forecast = feeds.find(f => f.source === 'codex-forecast');
  const outlook = forecast?.payload?.forecast;
  const byUrl = new Map<string, { item: NonNullable<Feed['payload']>['items'][number]; feed: Feed }>();
  // Prefer the curated timeline over the same post in the announcement stream.
  for (const feed of [...feeds].sort((a, b) => Number(a.source === 'codex-timeline') - Number(b.source === 'codex-timeline'))) {
    for (const item of feed.payload?.items ?? []) byUrl.set(resetEntryKey(item), { item, feed });
  }
  const items = [...byUrl.values()].filter(({ item }) => (provider === 'all' || item.provider === provider) && matchesResetType(item, kind)).sort((a, b) => resetDay(b.item).localeCompare(resetDay(a.item)) || b.item.at.localeCompare(a.item.at));
  const visibleItems = selectedDay ? items.filter(({ item }) => resetDay(item) === selectedDay) : items;
  const stale = (f: Feed) => !!f.error || !f.succeeded_at || Date.now() - Date.parse(f.succeeded_at) > 26 * 3_600_000 || !!f.payload?.upstream_stale || (f.source === 'codex-forecast' && (!f.payload?.source_updated_at || Date.now() - Date.parse(f.payload.source_updated_at) > 24 * 3_600_000));
  const announcement = outlook?.official ? { title: 'Codex global reset announced', detail: outlook.official, preview: false } : previewAnnouncement ? {
    title: 'Codex global reset announced', detail: 'Paid subscription usage is expected to reset by 8 PM Pacific. The exact arrival time may vary by account.', preview: true,
  } : null;

  return (
    <Workspace>
      <PageHeader
        eyebrow="Codex global resets · Claude window flushes"
        title="Reset intelligence"
        actions={<Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking…' : 'Check feeds'}</Button>}
      />

      {error && (
        <Alert variant="warning" role="alert">
          <AlertTitle>Refresh unavailable</AlertTitle>
          <AlertDescription>Showing the last saved feeds.</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-4">
        <Choice label="Provider" value={provider} onChange={value => { setProvider(value); setSelectedDay(null); setLimit(10); }} options={[{ value: 'all', label: 'Codex & Claude' }, { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} />
        <Choice label="Show" value={kind} onChange={value => { setKind(value); setSelectedDay(null); setLimit(10); }} options={[{ value: 'all', label: 'All reset types' }, ...resetTypes]} />
      </div>

      {announcement && provider !== 'claude' && (
        <Alert variant={announcement.preview ? 'default' : 'success'} role="status">
          <AlertTitle>{announcement.title}</AlertTitle>
          <AlertDescription>
            <p>{announcement.detail}</p>
            <p className="text-muted-foreground mt-1 font-mono text-[11px]">
              {announcement.preview ? 'Local preview · sample data' : 'Official announcement detected'} ·{' '}
              <a href="https://codex-reset.com/" target="_blank" rel="noreferrer" className="underline underline-offset-4">View source</a>
            </p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="grid gap-4">
          <ResetCalendar items={items.map(entry => entry.item)} selectedDay={selectedDay} onSelectDay={day => { setSelectedDay(day); setLimit(10); }} busy={busy} />

          {provider !== 'claude' && (
            <Card className="gap-0 overflow-hidden py-0" aria-label="Codex global reset forecast">
              <CardHeader className="p-4">
                <CardTitle className="text-sm">Codex global reset forecast</CardTitle>
                <CardDescription className="font-mono text-[11px]">
                  {forecast && stale(forecast) ? 'stale' : outlook?.confidence || 'waiting'}
                </CardDescription>
              </CardHeader>
              <StatGroup className="border-border border-t">
                <Stat label="Next 24h" value={outlook?.probability24 != null ? `${outlook.probability24}%` : '—'} />
                <Stat label="By 48h" value={outlook?.probability48 != null ? `${outlook.probability48}%` : '—'} />
              </StatGroup>
              <div className="border-border border-t p-4">
                <p className="text-muted-foreground text-xs leading-relaxed">
                  External likelihood model; separate from personal allowance windows.{' '}
                  <a href="https://codex-reset.com/forecast" target="_blank" rel="noreferrer" className="text-primary underline underline-offset-4">Method</a>
                </p>
              </div>
            </Card>
          )}
        </div>

        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">{selectedDay ? `Events · ${selectedDay} UTC` : 'Reset record'}</CardTitle>
            <CardDescription>
              Codex global and banked resets stay separate from Claude allowance-window flushes.
              Select a day to narrow the record.
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
                  <article key={resetEntryKey(item)} className="border-border grid grid-cols-[52px_minmax(0,1fr)] gap-3 border-b pb-3 last:border-b-0 last:pb-0">
                    <div className="text-center">
                      <span className="block font-mono text-xs font-medium">
                        {new Date(`${resetDay(item)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                      </span>
                      <span className="text-muted-foreground block font-mono text-[10px]">{resetDay(item).slice(0, 4)}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">{item.provider === 'codex' ? 'Codex' : 'Claude'}</Badge>
                        <Badge variant="outline"><ResetDot marker={resetMarker(item)} />{resetTypeLabel(item)}</Badge>
                        <Badge variant="outline">{item.category === 'history' ? 'Reported' : item.category === 'announcement' ? 'Announced / update' : 'Forecast'}</Badge>
                        <span className="text-muted-foreground font-mono text-[11px]">
                          {item.status.replaceAll('_', ' ')}{stale(feed) ? ' · stale source' : ''}
                        </span>
                      </div>
                      <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-primary mt-1.5 block text-sm font-semibold underline-offset-4 hover:underline">
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

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Feed health &amp; provenance</CardTitle>
          <CardDescription>
            Daily cloud check, hourly checks from the local collector, and cached checks when this
            view opens. No AI calls.
          </CardDescription>
        </CardHeader>
        <ListRows className="rounded-none border-x-0 border-b-0">
          {feeds.map(f => (
            <ListRow
              key={f.source}
              tone={stale(f) ? 'destructive' : 'default'}
              title={
                <a href={f.url} target="_blank" rel="noreferrer" className="hover:text-primary underline-offset-4 hover:underline">
                  {f.label}
                </a>
              }
              detail={`Last successful check ${when(f.succeeded_at)} · ${f.revisions} saved revisions`}
              aside={<Badge variant={stale(f) ? 'soft-warning' : 'soft'}>{stale(f) ? 'stale / retry pending' : 'available'}</Badge>}
            />
          ))}
        </ListRows>
        <div className="border-border border-t p-4">
          <p className="text-muted-foreground text-xs leading-relaxed">
            Independent sources may revise or retract claims. The latest fetched revision is
            displayed; earlier snapshots remain stored. Public forecasts never change the
            calculator’s measured account reset time.
          </p>
        </div>
      </Card>
    </Workspace>
  );
}
