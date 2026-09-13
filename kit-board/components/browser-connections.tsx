'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { when } from '@/components/telemetry-shared';

type BrowserSource = { id: string; account_id: string; machine_label: string; disabled: boolean; last_seen_at: string | null };

/**
 * The v1 Claude quota extension is still the only allowance reader for a browser
 * session until the v2 browser collector ships. Its connections can be paused and
 * resumed here; a paused connection keeps its history and refuses new uploads.
 */
export function BrowserConnections() {
  const [sources, setSources] = useState<BrowserSource[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch('/api/usage-connections', { cache: 'no-store' });
    if (!response.ok) { setMessage('Browser connections are temporarily unavailable.'); return; }
    setSources((await response.json() as { sources: BrowserSource[] }).sources);
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

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="p-4">
        <CardTitle className="text-base">Browser collectors (v1 quota extension)</CardTitle>
        <CardDescription>
          The signed-in browser is the only allowance reader for Claude sessions that never run a statusline
          hook, such as the desktop app. These connections keep working until the v2 browser collector replaces them;
          the local scripts are retired.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 border-t p-4">
        {sources === null && <p className="text-muted-foreground text-sm">Loading…</p>}
        {sources?.length === 0 && <p className="text-muted-foreground text-sm">No browser connections exist.</p>}
        {sources?.map(source => (
          <div key={source.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2">
            <div className="grid gap-0.5">
              <span className="text-sm font-medium">{source.machine_label}</span>
              <span className="text-muted-foreground font-mono text-[11px]">{source.account_id} · last reading {when(source.last_seen_at)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={source.disabled ? 'outline' : 'soft'}>{source.disabled ? 'paused' : 'active'}</Badge>
              <Button variant="outline" size="sm" onClick={() => void toggle(source)}>{source.disabled ? 'Resume' : 'Pause'}</Button>
            </div>
          </div>
        ))}
        {message && <p className="text-muted-foreground text-xs" role="status">{message}</p>}
      </CardContent>
    </Card>
  );
}
