'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  return <main className="telemetry-workspace"><PageHeader eyebrow="Codex global resets · Claude window flushes" title="Reset intelligence" actions={<Button variant="outline" onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking…' : 'Check feeds'}</Button>} />
    <div className="telemetry-body">{error && <p role="alert" className="telemetry-notice">{error}</p>}
      <div className="telemetry-filters reset-filters"><Choice label="Provider" value={provider} onChange={value => { setProvider(value); setSelectedDay(null); setLimit(10); }} options={[{ value: 'all', label: 'Codex & Claude' }, { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} /><div className="reset-type-filter"><Choice label="Show" value={kind} onChange={value => { setKind(value); setSelectedDay(null); setLimit(10); }} options={[{ value: 'all', label: 'All reset types' }, ...resetTypes]} /></div></div>

      {announcement && provider !== 'claude' && <section className="reset-announcement-banner" role="status">
        <div><span className="reset-announcement-kicker">{announcement.preview ? 'Local preview · sample data' : 'Official announcement detected'}</span><h2>{announcement.title}</h2><p>{announcement.detail}</p></div>
        <a href="https://codex-reset.com/" target="_blank" rel="noreferrer">View source ↗</a>
      </section>}

      <div className="reset-browser">
      <div className="reset-side"><ResetCalendar items={items.map(entry => entry.item)} selectedDay={selectedDay} onSelectDay={day => { setSelectedDay(day); setLimit(10); }} busy={busy} />
        {provider !== 'claude' && <aside className="reset-forecast" aria-label="Codex global reset forecast">
          <div className="reset-forecast-heading"><span>Codex global reset forecast</span><small>{forecast && stale(forecast) ? 'stale' : outlook?.confidence || 'waiting'}</small></div>
          <div className="reset-forecast-values"><div><strong>{outlook?.probability24 ?? '—'}{outlook?.probability24 != null && <small>%</small>}</strong><span>next 24h</span></div><div><strong>{outlook?.probability48 ?? '—'}{outlook?.probability48 != null && <small>%</small>}</strong><span>by 48h</span></div></div>
          <p>External likelihood model; separate from personal allowance windows.</p><a href="https://codex-reset.com/forecast" target="_blank" rel="noreferrer">Method ↗</a>
        </aside>}
      </div>
      <Card className="reset-record-list"><CardHeader><CardTitle>{selectedDay ? `Events · ${selectedDay} UTC` : 'Reset record'}</CardTitle><CardDescription>Codex global and banked resets stay separate from Claude allowance-window flushes. Select a day to narrow the record.</CardDescription></CardHeader><CardContent>
        {!visibleItems.length ? <p className="telemetry-muted">{busy ? 'Loading the reset record…' : selectedDay ? 'No matching entries on this day in the saved feeds.' : 'No matching entries in the saved feeds.'}</p> : <div className="telemetry-feed">{visibleItems.slice(0, limit).map(({ item, feed }) => <article className="telemetry-feed-item" key={resetEntryKey(item)}>
          <div className="telemetry-feed-date"><span>{new Date(`${resetDay(item)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span><small>{resetDay(item).slice(0, 4)}</small></div>
          <div><div className="telemetry-feed-badges"><Badge variant="secondary">{item.provider === 'codex' ? 'Codex' : 'Claude'}</Badge><Badge variant="outline"><i className={`reset-dot ${resetMarker(item)}`} />{resetTypeLabel(item)}</Badge><Badge variant="outline">{item.category === 'history' ? 'Reported' : item.category === 'announcement' ? 'Announced / update' : 'Forecast'}</Badge><span>{item.status.replaceAll('_', ' ')}{stale(feed) ? ' · stale source' : ''}</span></div>
            <a href={item.url} target="_blank" rel="noreferrer" className="telemetry-feed-title">{item.title.split('\n')[0]} ↗</a>
            {item.title.includes('\n') && <details className="telemetry-details"><summary>Read source context</summary><p className="telemetry-feed-context">{item.title.slice(item.title.indexOf('\n') + 1)}</p></details>}
            <p className="telemetry-footnote">{feed.label}{item.scope ? ` · ${item.scope}` : ''}{item.confidence ? ` · ${item.confidence} confidence` : ''}{item.banked_state ? ` · banked: ${item.banked_state.replaceAll('_', ' ')}` : ''}{item.verification_status && item.verification_status !== item.status ? ` · verification: ${item.verification_status.replaceAll('_', ' ')}` : ''}{item.effective_at ? ` · ${item.category === 'history' ? 'effective' : 'expected'} ${when(item.effective_at)}` : ''}</p>
          </div></article>)}</div>}
        {visibleItems.length > limit && <Button variant="ghost" onClick={() => setLimit(n => n + 20)}>Show more ({visibleItems.length - limit})</Button>}
      </CardContent></Card></div>
      <Card><CardHeader><CardTitle>Feed health & provenance</CardTitle><CardDescription>Daily cloud check, hourly checks from the local collector, and cached checks when this view opens. No AI calls.</CardDescription></CardHeader><CardContent><div className="telemetry-source-list">{feeds.map(f => <div key={f.source}><div><a href={f.url} target="_blank" rel="noreferrer">{f.label} ↗</a><small>Last successful check {when(f.succeeded_at)} · {f.revisions} saved revisions</small></div><Badge variant="outline">{stale(f) ? 'Stale / retry pending' : 'Available'}</Badge></div>)}</div><p className="telemetry-footnote">Independent sources may revise or retract claims. The latest fetched revision is displayed; earlier snapshots remain stored. Public forecasts never change the calculator’s measured account reset time.</p></CardContent></Card>
    </div></main>;
}
