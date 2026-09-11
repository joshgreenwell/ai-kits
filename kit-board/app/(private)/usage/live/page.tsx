'use client';
import { useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Choice, tokens, useLiveData, when } from '@/components/telemetry-shared';
import { isSparkWindow, quotaPace, tokenPace } from '@/lib/telemetry-contract';
import { AllowanceCard } from '@/components/allowance-card';

export default function LiveUsage() {
  const { data, error, now, retry } = useLiveData();
  const [account, setAccount] = useState('all'), [granularity, setGranularity] = useState('hour'), [showSpark, setShowSpark] = useState(false);
  const rows = data?.hourly.filter(r => account === 'all' || r.account_id === account) ?? [];
  const localSources = data?.sources.filter(s => !s.disabled && s.mode === 'local' && (account === 'all' || s.account_id === account)) ?? [];
  const recent = localSources.length > 0 && localSources.every(s => s.last_seen_at && now - Date.parse(s.last_seen_at) <= 2 * 3_600_000 && !s.coverage?.unavailable_roots && !s.coverage?.malformed_lines);
  const pace = tokenPace(rows, now);
  const chart = new Map<string, number>();
  const size = granularity === 'hour' ? 3_600_000 : 86_400_000, count = granularity === 'hour' ? 48 : 30;
  const end = Math.floor(now / size) * size;
  for (let i = count - 1; i >= 0; i--) chart.set(new Date(end - i * size).toISOString(), 0);
  for (const row of rows) { const key = new Date(Math.floor(Date.parse(row.hour) / size) * size).toISOString(); if (chart.has(key)) chart.set(key, chart.get(key)! + row.total_tokens); }
  const bars = [...chart]; const max = Math.max(1, ...chart.values());
  const projected = pace.tokensPerHour * 24;
  const windows = data?.accounts.filter(a => account === 'all' || a.id === account).flatMap(a => {
    const samples = data.quotas.filter(q => q.account_id === a.id);
    return [...new Set(samples.map(q => q.window_key))].map(key => ({ account: a, pace: quotaPace(samples.filter(q => q.window_key === key), now)! }));
  }) ?? [];
  const sparkCount = windows.filter(w => isSparkWindow(w.pace)).length;
  const visibleWindows = windows.filter(w => showSpark || !isSparkWindow(w.pace));
  return <main className="telemetry-workspace">
    <PageHeader eyebrow="Token Observatory · hourly collection" title="Usage & pace" actions={<Badge variant="outline">0 AI calls to collect</Badge>} />
    <div className="telemetry-body">
      {error && <div role="alert" className="telemetry-notice"><p>{error}</p><Button variant="outline" onClick={retry}>Retry loading</Button></div>}
      {localSources.some(s => s.coverage?.unavailable_roots || s.coverage?.malformed_lines) && <p className="telemetry-notice">Some local logs could not be read. Collected totals remain visible; pace estimates are paused until collection is complete. <Link href="/usage/connections">Check collectors</Link></p>}
      {!data ? (!error && <p className="telemetry-muted">Loading usage…</p>) : <>
        <div className="telemetry-filters"><Choice label="Account" value={account} onChange={setAccount} options={[{ value: 'all', label: 'All connected accounts' }, ...data.accounts.map(a => ({ value: a.id, label: a.label }))]} />
          <p className="telemetry-muted">Updated {when(data.as_of)} · <Link href="/usage/connections">{data.sources.filter(s => !s.disabled).length} collectors</Link></p></div>
        <div className="telemetry-metrics">
          <Card><CardHeader><CardDescription>Observed tokens · last 24 complete hours</CardDescription><CardTitle className="telemetry-number">{rows.length ? tokens(pace.tokensLast24Hours) : '—'}</CardTitle></CardHeader><CardContent>From connected local logs</CardContent></Card>
          <Card><CardHeader><CardDescription>Recent burn · trailing 6 complete hours</CardDescription><CardTitle className="telemetry-number">{rows.length && recent ? tokens(pace.tokensPerHour) : '—'}<small> / hour</small></CardTitle></CardHeader><CardContent>{recent ? 'Idle hours are included in this rate' : 'Waiting for fresh local collection'}</CardContent></Card>
          <Card><CardHeader><CardDescription>Next 24 hours · at the recent pace</CardDescription><CardTitle className="telemetry-number">{rows.length && recent ? tokens(projected) : '—'}</CardTitle></CardHeader><CardContent>Scenario estimate from collected activity</CardContent></Card>
        </div>
        <Card><CardHeader className="telemetry-card-heading"><div><CardTitle>Token activity</CardTitle><CardDescription>UTC buckets · current bucket is still accumulating</CardDescription></div><Choice label="View" value={granularity} onChange={setGranularity} options={[{ value: 'hour', label: 'Hourly · 48 hours' }, { value: 'day', label: 'Daily · 30 days' }]} /></CardHeader>
          <CardContent>{rows.length ? <><div className="telemetry-chart" role="img" aria-label={`${granularity === 'hour' ? 'Hourly' : 'Daily'} collected token usage`}>
            {bars.map(([at, n]) => <div className="telemetry-bar-slot" key={at} title={`${at.slice(0, 16).replace('T', ' ')} UTC: ${n.toLocaleString()} tokens`}><div style={{ height: `${Math.max(0.7, n / max * 100)}%` }} className={Date.parse(at) === end ? 'telemetry-bar current' : 'telemetry-bar'} /></div>)}
          </div><div className="telemetry-chart-labels"><span>{bars[0]?.[0].slice(0, 16).replace('T', ' ')} UTC</span><span>{tokens(max)} peak</span><span>Now</span></div>
          <details className="telemetry-details"><summary>View activity values</summary><div className="telemetry-table-wrap"><table><thead><tr><th>Bucket (UTC)</th><th>Tokens</th></tr></thead><tbody>{bars.map(([at, n]) => <tr key={at}><td>{at.slice(0, 16).replace('T', ' ')}</td><td>{n.toLocaleString()}</td></tr>)}</tbody></table></div></details></> : <p className="telemetry-muted">No token logs have been collected for this selection. Browser connections report allowance usage only.</p>}
          <p className="telemetry-footnote">Empty buckets mean no recorded activity; they may include collection gaps. Local logs do not cover browser or cloud conversations. Monthly reports are excluded from this series.</p></CardContent></Card>
        <div className="telemetry-section-heading"><div><h2>Allowance outlook</h2><span>How much of each subscription window you’ll use by reset, based on measured history.</span></div>
          {sparkCount > 0 && <Button variant="outline" aria-pressed={showSpark} onClick={() => setShowSpark(v => !v)}>{showSpark ? 'Hide' : 'Show'} Codex Spark ({sparkCount})</Button>}</div>
        {!visibleWindows.length && <Card><CardContent className="telemetry-empty">{windows.length ? 'Spark allowances are hidden. Use the toggle to show them.' : <>Allowance readings will appear after a Codex log update or a Claude browser/statusline collection. <Link href="/usage/connections">Connect an account</Link></>}</CardContent></Card>}
        <div className="telemetry-quotas">{visibleWindows.map(({ account: a, pace: p }) => <AllowanceCard key={a.id + p.window_key} account={a} pace={p} now={now} />)}</div>
        {data.accounts.filter(a => (account === 'all' || a.id === account) && !windows.some(w => w.account.id === a.id)).map(a => <Card key={a.id}><CardHeader><CardDescription>{a.label}</CardDescription><CardTitle>Waiting for allowance history</CardTitle></CardHeader><CardContent>No allowance readings collected yet. Connect this account’s quota collector to see its remaining allowance and projection. <Link href="/usage/connections">Check connection</Link></CardContent></Card>)}
        <p className="telemetry-muted">Each account and allowance window is forecast independently. Open the full analysis in your <Link href="/usage">Monthly report</Link>.</p>
      </>}
    </div>
  </main>;
}
