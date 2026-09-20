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
 * The legacy bridge: v1 browser sources of the Claude quota extension, publishing to
 * `/api/v1/telemetry`. The same extension at version 2.0.0 pairs as a browser install
 * (`CompanionInstalls`, kind `browser`) and may publish both during the reconciliation
 * period; a v1 sample the v2 reading duplicates is shown once, as the v2 reading. Pausing
 * a source here is the server-side cutover step. A paused connection keeps its history and
 * refuses new uploads. Last contact is any accepted post, including an empty one when usage
 * was unreadable; the reading line shows what the extension actually observed.
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
        <CardTitle className="text-base">Legacy browser bridge (v1 quota sources)</CardTitle>
        <CardDescription>
          The v1 upload path of the Claude quota extension. Its replacement is the same extension at version 2.0.0, paired
          above as a browser install; a profile may publish both while old and new readings are compared, and a v1 sample the
          v2 reading duplicates is shown once, as the v2 reading. Cutover per profile: once the paired install shows fresh readings
          for the same account, pause the v1 source here, then remove the legacy connection on the extension&apos;s options page.
          History stays visible after pausing. The extension reads while its profile is open.
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
