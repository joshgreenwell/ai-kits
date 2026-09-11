'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from './ui/card';
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
  return <Card>
    <CardHeader><div className="telemetry-card-heading"><div><CardDescription>{account.label}</CardDescription><CardTitle>Cloud &amp; uncollected estimate</CardTitle></div><Badge variant="outline">Experimental · low confidence</Badge></div>
      <CardDescription>Local-equivalent tokens inferred from account allowance changes. Separate from measured token totals.</CardDescription></CardHeader>
    <CardContent>
      {estimate.ok ? <>
        <div className="telemetry-quota-number">≈ {tokens(estimate.value.estimated_unobserved_tokens)}<small>uncollected token-equivalent</small></div>
        <dl className="telemetry-facts">
          <div><dt>Observed local · same intervals</dt><dd>{tokens(estimate.value.local_tokens)}</dd></div>
          <div><dt>Estimated local + uncollected</dt><dd>≈ {tokens(estimate.value.estimated_total_tokens)}</dd></div>
          <div><dt>Coverage within the last 24 hours</dt><dd>{estimate.value.covered_hours.toFixed(1)}h · {estimate.value.interval_count} sampled intervals</dd></div>
          <div><dt>Allowance used for this estimate</dt><dd>{estimate.value.window_key === 'five_hour' ? '5-hour · all models' : 'Weekly · all models'} · {estimate.value.points.toFixed(1)} points</dd></div>
          <div><dt>Calibration</dt><dd>{tokens(estimate.value.tokens_per_point)} tokens/point · {estimate.value.baseline_count} baseline{estimate.value.baseline_count === 1 ? '' : 's'}</dd></div>
        </dl>
        <p className="telemetry-footnote">Covered {when(estimate.value.started_at)}–{when(estimate.value.ended_at)}. Gaps and reset crossings are excluded. This is not a complete daily total.</p>
      </> : <p className="telemetry-muted" role="status">{estimate.reason} <Link href="/usage/connections">Usage connections</Link></p>}
      <p className="telemetry-footnote">Different models, caching, quota rounding, and missing machine logs can change this estimate substantially. “Uncollected” may include browser chats, cloud tasks, and local activity we did not collect. Boundary-hour tokens are prorated by time; no exact cloud timing is known.</p>
      <details className="telemetry-details"><summary>Calibrate from a local-only period</summary>
        <p>Pick a period when this account used <strong>only local sessions covered by your collectors</strong>, with no browser, cloud, or uncollected machine activity. Use at least two hours, three readings, and three allowance percentage points within one reset.</p>
        {readings.length ? <>
          <div className="telemetry-filters">
            <Choice label={`${account.label} calibration allowance`} value={scope} onChange={v => { setWindowKey(v); setStartId(''); setEndId(''); }} options={keys.map(key => ({ value: key, label: key === 'five_hour' ? '5-hour · all models' : 'Weekly · all models' }))} />
            <Choice label={`${account.label} baseline start`} value={start?.id ?? 'none'} onChange={setStartId} options={starts.length ? starts.map(q => ({ value: q.id, label: `${when(q.observed_at)} · ${q.used_percent}% used` })) : [{ value: 'none', label: 'Need earlier readings' }]} />
            <Choice label={`${account.label} baseline end`} value={end?.id ?? 'none'} onChange={setEndId} options={complete.length ? complete.map(q => ({ value: q.id, label: `${when(q.observed_at)} · ${q.used_percent}% used` })) : [{ value: 'none', label: 'Waiting for a complete hour' }]} />
          </div>
          <p className="telemetry-muted">{preview.ok ? `${tokens(preview.value.local_tokens)} local tokens ÷ ${preview.value.percent_delta.toFixed(1)} allowance points = ${tokens(preview.value.tokens_per_point)} tokens per point. ${preview.samples} readings.` : preview.reason}</p>
          <Button className="telemetry-wrap-button" disabled={busy || !preview.ok || alreadySaved} onClick={() => void mutate({ account_id: accountId, start_sample_id: start?.id, end_sample_id: end?.id, confirm_local_only: true }, 'POST')}>
            {alreadySaved ? 'This baseline is saved' : busy ? 'Saving…' : 'Confirm local-only use & save baseline'}
          </Button>
        </> : <p className="telemetry-muted">Waiting for allowance readings on this account. The second account needs its own local-only baseline; another account’s quota capacity is not assumed.</p>}
        <p className="telemetry-footnote">Up to five non-overlapping baselines use their median conversion. The most recently saved allowance scope is used; 5-hour and weekly estimates are never added. Baselines expire after 30 days. Recalibrate after a plan, model, or workload change.</p>
      </details>
      {saved.length > 0 && <details className="telemetry-details"><summary>Saved baselines ({saved.length})</summary><div className="telemetry-source-list">{saved.map(c => <div key={c.id}><div><strong>{c.window_key === 'five_hour' ? '5-hour' : 'Weekly'} · {tokens(c.tokens_per_point)} tokens/point</strong><small>{when(c.started_at)}–{when(c.ended_at)}</small></div><Button variant="outline" disabled={busy} onClick={() => void mutate({ id: c.id }, 'DELETE')}>Remove baseline</Button></div>)}</div></details>}
      {message && <p className="telemetry-notice" role="status">{message}</p>}
    </CardContent>
  </Card>;
}
