'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Card, CardAction, CardHeader, CardTitle, CardDescription, CardContent } from './ui/card';
import { Alert, AlertDescription } from './ui/alert';
import { ListRow, ListRows } from './kit';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Choice, tokens, when, type LiveData } from './telemetry-shared';
import { allModelWindow, calibrationPreview, cloudEstimate } from '@/lib/cloud-estimate';

export function CloudEstimateCard({ data, accountId, now, refresh }: { data: LiveData; accountId: string; now: number; refresh: () => void }) {
  const [windowKey, setWindowKey] = useState('five_hour'), [startId, setStartId] = useState(''), [endId, setEndId] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [revoked, setRevoked] = useState<string[]>([]);
  const account = data.accounts.find(a => a.id === accountId)!;
  const calibrations = (data.calibrations ?? []).filter(c => !revoked.includes(c.id));
  const estimate = cloudEstimate(data, accountId, calibrations, now);
  const readings = data.quotas.filter(q => q.account_id === accountId && allModelWindow(q));
  const keys = [...new Set(readings.map(q => q.window_key))].sort();
  const scope = keys.includes(windowKey) ? windowKey : keys[0] ?? 'five_hour';
  const samples = readings.filter(q => q.window_key === scope).sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const complete = samples.filter(q => Math.ceil(Date.parse(q.observed_at) / 3_600_000) * 3_600_000 <= now);
  const end = complete.find(q => q.id === endId) ?? complete.at(-1);
  const starts = samples.filter(q => end && Date.parse(q.resets_at) === Date.parse(end.resets_at) && Date.parse(end.observed_at) - Date.parse(q.observed_at) >= 2 * 3_600_000);
  const start = starts.find(q => q.id === startId) ?? [...starts].reverse().find(q => end && end.used_percent - q.used_percent >= 3) ?? starts.at(-1);
  const preview = calibrationPreview(data, accountId, start?.id ?? '', end?.id ?? '', now);
  const saved = calibrations.filter(c => c.account_id === accountId);
  const alreadySaved = saved.some(c => c.start_sample_id === start?.id && c.end_sample_id === end?.id);
  async function mutate(body: object, method: 'POST' | 'DELETE') {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/usage-calibrations', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save the baseline');
      if (method === 'DELETE' && 'id' in body) setRevoked(current => [...current, String(body.id)]);
      setMessage(method === 'POST' ? 'Baseline saved. The estimate refreshes within a minute as complete readings arrive.' : 'Baseline removed from estimates. Measured history is preserved.');
      refresh();
    } catch (e) { setMessage(e instanceof Error && e.name !== 'TimeoutError' ? e.message : 'The request timed out. Refresh to check whether it saved before trying again.'); }
    finally { setBusy(false); }
  }
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardDescription>{account.label}</CardDescription>
        <CardTitle className="text-base">Cloud &amp; uncollected estimate</CardTitle>
        <CardAction><Badge variant="soft-warning">Experimental · low confidence</Badge></CardAction>
      </CardHeader>

      <CardContent className="grid gap-4">
        <p className="text-muted-foreground text-sm leading-relaxed">
          Local-equivalent tokens inferred from account allowance changes. Separate from measured
          token totals.
        </p>

        {estimate.ok ? (
          <>
            <p className="font-mono text-3xl leading-none font-medium tracking-tight tabular-nums">
              ≈ {tokens(estimate.value.estimated_unobserved_tokens)}
              <span className="text-muted-foreground ml-2 text-sm font-normal">uncollected token-equivalent</span>
            </p>
            <dl className="border-border grid rounded-lg border">
              {[
                ['Observed local · same intervals', tokens(estimate.value.local_tokens)],
                ['Estimated local + uncollected', `≈ ${tokens(estimate.value.estimated_total_tokens)}`],
                ['Coverage within the last 24 hours', `${estimate.value.covered_hours.toFixed(1)}h · ${estimate.value.interval_count} sampled intervals`],
                ['Allowance used for this estimate', `${estimate.value.window_key === 'five_hour' ? '5-hour · all models' : 'Weekly · all models'} · ${estimate.value.points.toFixed(1)} points`],
                ['Calibration', `${tokens(estimate.value.tokens_per_point)} tokens/point · ${estimate.value.baseline_count} baseline${estimate.value.baseline_count === 1 ? '' : 's'}`],
              ].map(([term, value]) => (
                <div key={term} className="border-border flex flex-wrap items-baseline justify-between gap-3 border-b px-3 py-2 last:border-b-0">
                  <dt className="text-muted-foreground text-sm">{term}</dt>
                  <dd className="font-mono text-sm tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Covered {when(estimate.value.started_at)}–{when(estimate.value.ended_at)}. Gaps and reset
              crossings are excluded. This is not a complete daily total.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm" role="status">
            {estimate.reason}{' '}
            <Link href="/usage/connections" className="text-primary underline underline-offset-4">Usage connections</Link>
          </p>
        )}

        <p className="text-muted-foreground text-xs leading-relaxed">
          Different models, caching, quota rounding, and missing machine logs can change this
          estimate substantially. “Uncollected” may include browser chats, cloud tasks, and local
          activity we did not collect. Boundary-hour tokens are prorated by time; no exact cloud
          timing is known.
        </p>

        <details className="border-border rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-semibold">Calibrate from a local-only period</summary>
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
            Pick a period when this account used{' '}
            <strong className="text-foreground">only local sessions covered by your collectors</strong>,
            with no browser, cloud, or uncollected machine activity. Use at least two hours, three
            readings, and three allowance percentage points within one reset.
          </p>
          {readings.length ? (
            <>
              <div className="mt-3 grid gap-3">
                <Choice label={`${account.label} calibration allowance`} value={scope} onChange={v => { setWindowKey(v); setStartId(''); setEndId(''); }} options={keys.map(key => ({ value: key, label: key === 'five_hour' ? '5-hour · all models' : 'Weekly · all models' }))} />
                <Choice label={`${account.label} baseline start`} value={start?.id ?? 'none'} onChange={setStartId} options={starts.length ? starts.map(q => ({ value: q.id, label: `${when(q.observed_at)} · ${q.used_percent}% used` })) : [{ value: 'none', label: 'Need earlier readings' }]} />
                <Choice label={`${account.label} baseline end`} value={end?.id ?? 'none'} onChange={setEndId} options={complete.length ? complete.map(q => ({ value: q.id, label: `${when(q.observed_at)} · ${q.used_percent}% used` })) : [{ value: 'none', label: 'Waiting for a complete hour' }]} />
              </div>
              <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                {preview.ok ? `${tokens(preview.value.local_tokens)} local tokens ÷ ${preview.value.percent_delta.toFixed(1)} allowance points = ${tokens(preview.value.tokens_per_point)} tokens per point. ${preview.samples} readings.` : preview.reason}
              </p>
              <Button className="mt-3 h-auto py-2 whitespace-normal" disabled={busy || !preview.ok || alreadySaved} onClick={() => void mutate({ account_id: accountId, start_sample_id: start?.id, end_sample_id: end?.id, confirm_local_only: true }, 'POST')}>
                {alreadySaved ? 'This baseline is saved' : busy ? 'Saving…' : 'Confirm local-only use & save baseline'}
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
              Waiting for allowance readings on this account. The second account needs its own
              local-only baseline; another account’s quota capacity is not assumed.
            </p>
          )}
          <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
            Up to five non-overlapping baselines use their median conversion. The most recently saved
            allowance scope is used; 5-hour and weekly estimates are never added. Baselines expire
            after 30 days. Recalibrate after a plan, model, or workload change.
          </p>
        </details>

        {saved.length > 0 && (
          <details className="border-border rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-semibold">Saved baselines ({saved.length})</summary>
            <ListRows className="mt-3">
              {saved.map(c => (
                <ListRow
                  key={c.id}
                  title={`${c.window_key === 'five_hour' ? '5-hour' : 'Weekly'} · ${tokens(c.tokens_per_point)} tokens/point`}
                  detail={`${when(c.started_at)}–${when(c.ended_at)}`}
                  aside={<Button variant="outline" size="sm" disabled={busy} onClick={() => void mutate({ id: c.id }, 'DELETE')}>Remove baseline</Button>}
                />
              ))}
            </ListRows>
          </details>
        )}

        {message && (
          <Alert role="status">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
