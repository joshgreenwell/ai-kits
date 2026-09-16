'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ListRow, ListRows } from '@/components/kit';
import { when } from '@/components/telemetry-shared';
import { resetFeedFailureLabel } from '@/lib/reset-feed-errors';
import { resetFeedCoverageNotes } from '@/lib/nextreset-feeds';
import type { ResetDocument } from '@/lib/reset-feeds';

type Feed = { source: string; label: string; url: string; provider: string; succeeded_at: string | null; checked_at: string | null; error: string | null; revisions: number; payload: ResetDocument | null };
type SyncResult = { source: string; ok?: boolean; error?: string; cached?: boolean; unchanged?: boolean };

/** The public reset feeds' connection status and provenance; the calendar they feed stays under Usage. */
export function ResetFeedHealth() {
  const [feeds, setFeeds] = useState<Feed[] | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);

  async function check(signal?: AbortSignal) {
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
    catch { if (!signal?.aborted) setError('Check unavailable. Showing the last saved feeds.'); }
    finally { if (!signal?.aborted) setBusy(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/reset-feeds', { signal: controller.signal }).then(r => r.ok ? r.json() : Promise.reject()).then(d => setFeeds(d.feeds)).catch(() => { if (!controller.signal.aborted) setError('Feed status is temporarily unavailable.'); });
    return () => controller.abort();
  }, []);

  const stale = (f: Feed) => !!f.error || !f.succeeded_at || Date.now() - Date.parse(f.succeeded_at) > 26 * 3_600_000 || !!f.payload?.upstream_stale || (f.payload?.coverage && Date.now() - Date.parse(f.payload.coverage.checked_at) > 45 * 60_000);
  const coverageNotes = [...new Set((feeds ?? []).flatMap(f => resetFeedCoverageNotes(f.payload)))];

  return (
    <div className="grid gap-4">
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
      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Feed health &amp; provenance</CardTitle>
          <CardDescription>
            Daily cloud check, and a cached check when the reset calendar opens. No AI calls. The
            calendar and record live under <Link href="/usage/allowances#reset-calendar" className="underline underline-offset-4">Usage → Reset calendar</Link>.
          </CardDescription>
        </CardHeader>
        {feeds === null ? (
          <div className="p-4">{!error && <p className="text-muted-foreground text-sm" role="status">Loading feed status…</p>}</div>
        ) : feeds.length ? (
          <ListRows className="rounded-none border-x-0 border-b-0">
            {feeds.map(f => (
              <ListRow
                key={f.source}
                tone={stale(f) ? 'destructive' : 'default'}
                title={<a href={f.url} target="_blank" rel="noreferrer" className="hover:text-primary underline-offset-4 hover:underline">{f.label}</a>}
                detail={`Last successful check ${when(f.succeeded_at)} · ${f.revisions} saved revisions${f.error ? ` · ${resetFeedFailureLabel(f.error)}` : ''}${f.payload?.coverage ? ` · archive checked ${when(f.payload.coverage.checked_at)} · posts/replies checked ${when(f.payload.coverage.direct_checked_at)}` : ''}`}
                aside={<Badge variant={stale(f) || resetFeedCoverageNotes(f.payload).length ? 'soft-warning' : 'soft'}>{stale(f) ? 'stale / retry pending' : 'available'}</Badge>}
              />
            ))}
          </ListRows>
        ) : (
          <CardContent className="p-4"><EmptyState title="No feeds saved yet" description="The first check stores each feed's latest revision." /></CardContent>
        )}
        <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t p-4">
          <p className="text-muted-foreground text-xs leading-relaxed">
            Independent sources may revise or retract claims. The latest fetched revision is displayed; earlier snapshots remain stored. Public forecasts never change the calculator's measured account reset time.
          </p>
          <Button variant="outline" size="sm" onClick={() => void check()} disabled={busy}>{busy ? 'Checking…' : 'Check feeds now'}</Button>
        </div>
      </Card>
    </div>
  );
}
