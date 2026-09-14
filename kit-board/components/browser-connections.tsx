'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { when } from '@/components/telemetry-shared';
import { DEFAULT_CADENCE_MINUTES, readingFreshness } from '@/lib/allowance-freshness';

type BrowserSource = { id: string; account_id: string; machine_label: string; disabled: boolean; last_seen_at: string | null;
  last_observation: string | null; last_received: string | null };
type Connections = { sources: BrowserSource[]; cadence_minutes: number };

/**
 * The v1 Claude quota extension is still the only allowance reader for a browser
 * session until the v2 browser collector ships. Its connections can be paused and
 * resumed here; a paused connection keeps its history and refuses new uploads.
 * Last contact is any accepted post, including an empty one when usage was unreadable;
 * the reading line shows what the extension actually observed.
 */
export function BrowserConnections() {
  const [connections, setConnections] = useState<Connections | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    const response = await fetch('/api/usage-connections', { cache: 'no-store' });
    if (!response.ok) { setMessage('Browser connections are temporarily unavailable.'); return; }
    setConnections(await response.json() as Connections);
    setNow(Date.now());
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(source: BrowserSource) {
    const response = await fetch('/api/usage-connections', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: source.id, disabled: !source.disabled }),
    });
    setMessage(response.ok
      ? `${source.machine_label} ${source.disabled ? 'resumed; its next reading is accepted' : 'paused; new uploads are refused'}.`
      : 'The connection could not be changed.');
    await load();
  }

  const sources = connections?.sources ?? null;
  const cadence = connections?.cadence_minutes ?? DEFAULT_CADENCE_MINUTES;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Browser collectors (v1 quota extension)</CardTitle>
        <CardDescription>
          The signed-in browser is the only allowance reader for Claude sessions that never run a statusline
          hook, such as the desktop app. These connections keep working until the v2 browser collector replaces them;
          the local scripts are retired. The extension reads hourly while its profile is open.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 border-t p-4">
        {sources === null && <p className="text-muted-foreground text-sm">Loading…</p>}
        {sources?.length === 0 && <p className="text-muted-foreground text-sm">No browser connections exist.</p>}
        {sources?.map(source => {
          const freshness = source.last_observation ? readingFreshness({ observedAt: source.last_observation, now, cadenceMinutes: cadence }) : null;
          return (
            <div key={source.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
              <div className="grid gap-0.5">
                <span className="text-sm font-medium">{source.machine_label}</span>
                <span className="text-muted-foreground font-mono text-[11px]">{source.account_id} · last contact {when(source.last_seen_at)}</span>
                <span className="text-muted-foreground font-mono text-[11px]" title={freshness ? `received ${when(source.last_received)} · stale after ${freshness.staleAfterMinutes} min` : undefined}>
                  {freshness ? `last reading ${when(source.last_observation)} (${freshness.stale ? 'stale' : 'fresh'})` : 'no readings yet'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={source.disabled ? 'outline' : 'soft'}>{source.disabled ? 'paused' : 'active'}</Badge>
                <Button variant="outline" size="sm" onClick={() => void toggle(source)}>{source.disabled ? 'Resume' : 'Pause'}</Button>
              </div>
            </div>
          );
        })}
        {message && <p className="text-muted-foreground text-xs" role="status">{message}</p>}
      </CardContent>
    </Card>
  );
}
