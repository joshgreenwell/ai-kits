'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, SparkBars, Stat, StatGroup } from '@/components/kit';
import { Choice, tokens, useLiveData } from '@/components/telemetry-shared';
import { UsageStatusLine } from '@/components/usage-status-line';
import { tokenPace } from '@/lib/telemetry-contract';

/**
 * Hourly token activity from the local collectors: the Tokens scaffold until USG-017 lands its
 * overview. Owns its own live poll so the monthly report below stays on the reports feed.
 */
export function TokenActivity() {
  const { data, error, now, retry } = useLiveData();
  const [account, setAccount] = useState('all'), [granularity, setGranularity] = useState('hour');
  const rows = data?.hourly.filter(r => account === 'all' || r.account_id === account) ?? [];
  const localSources = data?.sources.filter(s => !s.disabled && (s.mode === 'local' || s.mode === 'companion') && (account === 'all' || s.account_id === account)) ?? [];
  const recent = localSources.length > 0 && localSources.every(s => s.last_seen_at && now - Date.parse(s.last_seen_at) <= 2 * 3_600_000 && !s.coverage?.unavailable_roots && !s.coverage?.malformed_lines);
  const partialCoverage = localSources.some(s => s.coverage?.unavailable_roots || s.coverage?.malformed_lines);
  const pace = tokenPace(rows, now);
  const chart = new Map<string, number>();
  const size = granularity === 'hour' ? 3_600_000 : 86_400_000, count = granularity === 'hour' ? 48 : 30;
  const end = Math.floor(now / size) * size;
  for (let i = count - 1; i >= 0; i--) chart.set(new Date(end - i * size).toISOString(), 0);
  for (const row of rows) { const key = new Date(Math.floor(Date.parse(row.hour) / size) * size).toISOString(); if (chart.has(key)) chart.set(key, chart.get(key)! + row.total_tokens); }
  const bars = [...chart]; const max = Math.max(1, ...chart.values());
  const projected = pace.tokensPerHour * 24;

  return (
    <section className="grid gap-4" aria-labelledby="hourly-activity-heading">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h2 id="hourly-activity-heading" className="text-lg font-semibold tracking-tight">Hourly activity</h2>
          <p className="text-muted-foreground max-w-[72ch] text-sm">Aggregate work captured from local collectors. Token volume stays separate from provider allowance percentages.</p>
        </div>
        <UsageStatusLine data={data} now={now} error={error} />
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Hourly activity is temporarily unavailable</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={retry}>Retry loading</Button>
          </AlertDescription>
        </Alert>
      )}
      {partialCoverage && (
        <Alert variant="warning">
          <AlertTitle>Some local logs could not be read</AlertTitle>
          <AlertDescription>
            Collected totals remain visible; token pace estimates are paused until collection is complete.{' '}
            <Link href="/settings" className="underline underline-offset-4">Check collectors</Link>
          </AlertDescription>
        </Alert>
      )}

      {data && (
        <>
          <Card className="gap-0 overflow-hidden py-0">
            <StatGroup>
              <Stat label="Observed tokens" value={rows.length ? tokens(pace.tokensLast24Hours) : '—'} caption="last 24 complete hours · from connected local logs" />
              <Stat label="Recent burn" value={rows.length && recent ? `${tokens(pace.tokensPerHour)}/h` : '—'} caption={recent ? 'trailing 6 complete hours · idle hours included' : 'waiting for fresh local collection'} />
              <Stat label="Next 24 hours" value={rows.length && recent ? tokens(projected) : '—'} caption="scenario estimate at the recent pace" />
            </StatGroup>
          </Card>

          <Card className="gap-0 overflow-hidden py-0">
            <CardHeader className="p-4">
              <CardTitle className="text-base">Token activity</CardTitle>
              <CardDescription>UTC buckets · the current bucket is still accumulating</CardDescription>
              <CardAction>
                <div className="flex flex-wrap gap-3">
                  <Choice label="Account" value={account} onChange={setAccount} options={[{ value: 'all', label: 'All connected accounts' }, ...data.accounts.map(a => ({ value: a.id, label: a.label }))]} />
                  <Choice label="View" value={granularity} onChange={setGranularity} options={[{ value: 'hour', label: 'Hourly · 48 hours' }, { value: 'day', label: 'Daily · 30 days' }]} />
                </div>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4 p-4">
              {rows.length ? (
                <>
                  <SparkBars values={bars.map(([, n]) => n)} markIndex={bars.length - 1} axis={[bars[0]?.[0].slice(0, 16).replace('T', ' ') + ' UTC', `${tokens(max)} peak`, 'Now']} formatValue={tokens} />
                  <details>
                    <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[11px]">View activity values</summary>
                    <div className="border-border mt-3 max-h-72 overflow-auto rounded-lg border">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="bg-card uppercase">Bucket (UTC)</TableHead>
                            <TableHead className="bg-card text-right uppercase">Tokens</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {bars.map(([at, n]) => (
                            <TableRow key={at} className="even:bg-foreground/[0.03] border-b-0">
                              <TableCell className="font-mono text-xs">{at.slice(0, 16).replace('T', ' ')}</TableCell>
                              <TableCell className="text-right font-mono text-xs tabular-nums">{n.toLocaleString()}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </details>
                </>
              ) : (
                <EmptyState
                  title="No token logs for this selection"
                  description="Browser connections report allowance usage only. Connect a local collector to see token-level activity."
                  actions={<Button size="sm" variant="outline" asChild><Link href="/settings">Check connections</Link></Button>}
                />
              )}
              <p className="text-muted-foreground text-xs leading-relaxed">
                Empty buckets mean no recorded activity; they may include collection gaps. Local logs do not cover browser or cloud conversations. Monthly reports are excluded from this series.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </section>
  );
}
