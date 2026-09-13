'use client';
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, SparkBars, Stat, StatGroup } from '@/components/kit';
import { Choice, tokens, useLiveData, when } from '@/components/telemetry-shared';
import { isSparkWindow, quotaOutlook, tokenPace } from '@/lib/telemetry-contract';
import { AllowanceCard } from '@/components/allowance-card';
import { ModelUsageHistory } from '@/components/model-usage-history';

function SectionHeading({ id, number, title, description, action }: { id: string; number: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-start gap-3">
        <span className="border-border text-muted-foreground mt-0.5 rounded-md border px-2 py-1 font-mono text-[10px]">{number}</span>
        <div className="grid gap-1">
          <h2 id={id} className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-muted-foreground max-w-[72ch] text-sm">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

export default function LiveUsage() {
  const { data, error, now, retry } = useLiveData();
  const [account, setAccount] = useState('all'), [granularity, setGranularity] = useState('hour'), [showSpark, setShowSpark] = useState(false);
  const rows = data?.hourly.filter(r => account === 'all' || r.account_id === account) ?? [];
  const localSources = data?.sources.filter(s => !s.disabled && (s.mode === 'local' || s.mode === 'companion') && (account === 'all' || s.account_id === account)) ?? [];
  const recent = localSources.length > 0 && localSources.every(s => s.last_seen_at && now - Date.parse(s.last_seen_at) <= 2 * 3_600_000 && !s.coverage?.unavailable_roots && !s.coverage?.malformed_lines);
  const pace = tokenPace(rows, now);
  const chart = new Map<string, number>();
  const size = granularity === 'hour' ? 3_600_000 : 86_400_000, count = granularity === 'hour' ? 48 : 30;
  const end = Math.floor(now / size) * size;
  for (let i = count - 1; i >= 0; i--) chart.set(new Date(end - i * size).toISOString(), 0);
  for (const row of rows) { const key = new Date(Math.floor(Date.parse(row.hour) / size) * size).toISOString(); if (chart.has(key)) chart.set(key, chart.get(key)! + row.total_tokens); }
  const bars = [...chart]; const max = Math.max(1, ...chart.values());
  const projected = pace.tokensPerHour * 24;
  const windows = useMemo(() => data?.accounts.filter(a => account === 'all' || a.id === account).flatMap(a => {
    const samples = data.quotas.filter(q => q.account_id === a.id);
    return [...new Set(samples.map(q => q.window_key))].flatMap(key => {
      const pace = quotaOutlook(samples.filter(q => q.window_key === key), now);
      return pace ? [{ account: a, pace }] : [];
    });
  }) ?? [], [account, data, now]);
  const sparkCount = windows.filter(w => isSparkWindow(w.pace)).length;
  const visibleWindows = windows.filter(w => showSpark || !isSparkWindow(w.pace));
  const partialCoverage = localSources.some(s => s.coverage?.unavailable_roots || s.coverage?.malformed_lines);

  return (
    <Workspace>
      <PageHeader
        eyebrow="Token Observatory · hourly collection"
        title="Usage & pace"
        description="Activity, current allowance pressure, and model behavior across the reset cycles already captured by your collectors."
        actions={<Badge variant="outline">0 AI calls to collect</Badge>}
      />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Usage is temporarily unavailable</AlertTitle>
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
            <Link href="/usage/connections" className="underline underline-offset-4">Check collectors</Link>
          </AlertDescription>
        </Alert>
      )}

      {!data ? (
        !error && <p className="text-muted-foreground text-sm">Loading usage…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <Choice
              label="Account"
              value={account}
              onChange={setAccount}
              options={[{ value: 'all', label: 'All connected accounts' }, ...data.accounts.map(a => ({ value: a.id, label: a.label }))]}
            />
            <p className="text-muted-foreground font-mono text-[11px]">
              Updated {when(data.as_of)} ·{' '}
              <Link href="/usage/connections" className="underline underline-offset-4">
                {data.sources.filter(s => !s.disabled).length} collectors
              </Link>
            </p>
          </div>

          <section className="grid gap-4" aria-labelledby="hourly-activity-heading">
            <SectionHeading
              id="hourly-activity-heading"
              number="01"
              title="Hourly activity"
              description="Aggregate work captured from local collectors. Token volume stays separate from provider allowance percentages."
            />

            <Card className="gap-0 overflow-hidden py-0">
              <StatGroup>
                <Stat
                  label="Observed tokens"
                  value={rows.length ? tokens(pace.tokensLast24Hours) : '—'}
                  caption="last 24 complete hours · from connected local logs"
                />
                <Stat
                  label="Recent burn"
                  value={rows.length && recent ? `${tokens(pace.tokensPerHour)}/h` : '—'}
                  caption={recent ? 'trailing 6 complete hours · idle hours included' : 'waiting for fresh local collection'}
                />
                <Stat
                  label="Next 24 hours"
                  value={rows.length && recent ? tokens(projected) : '—'}
                  caption="scenario estimate at the recent pace"
                />
              </StatGroup>
            </Card>

            <Card className="gap-0 overflow-hidden py-0">
              <CardHeader className="p-4">
                <CardTitle className="text-base">Token activity</CardTitle>
                <CardDescription>UTC buckets · the current bucket is still accumulating</CardDescription>
                <CardAction>
                  <Choice
                    label="View"
                    value={granularity}
                    onChange={setGranularity}
                    options={[{ value: 'hour', label: 'Hourly · 48 hours' }, { value: 'day', label: 'Daily · 30 days' }]}
                  />
                </CardAction>
              </CardHeader>

              <CardContent className="grid gap-4 p-4">
                {rows.length ? (
                  <>
                    <SparkBars
                      values={bars.map(([, n]) => n)}
                      markIndex={bars.length - 1}
                      axis={[bars[0]?.[0].slice(0, 16).replace('T', ' ') + ' UTC', `${tokens(max)} peak`, 'Now']}
                      formatValue={tokens}
                    />
                    <details>
                      <summary className="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[11px]">
                        View activity values
                      </summary>
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
                    actions={<Button size="sm" variant="outline" asChild><Link href="/usage/connections">Check connections</Link></Button>}
                  />
                )}
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Empty buckets mean no recorded activity; they may include collection gaps. Local logs
                  do not cover browser or cloud conversations. Monthly reports are excluded from this series.
                </p>
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4" aria-labelledby="allowance-outlook-heading">
            <SectionHeading
              id="allowance-outlook-heading"
              number="02"
              title="Current allowances"
              description="Current-window pressure seeded by completed reset cycles, then blended toward live evidence as it accumulates."
              action={sparkCount > 0 ? (
                <Button variant="outline" size="sm" aria-pressed={showSpark} onClick={() => setShowSpark(v => !v)}>
                  {showSpark ? 'Hide' : 'Show'} Codex Spark ({sparkCount})
                </Button>
              ) : undefined}
            />

            {!visibleWindows.length && (
              <EmptyState
                title={windows.length ? 'Spark allowances are hidden' : 'No allowance readings yet'}
                description={
                  windows.length
                    ? 'Use the toggle above to show them.'
                    : 'Allowance readings will appear after a Codex log update or a Claude browser/statusline collection.'
                }
                actions={!windows.length && <Button size="sm" asChild><Link href="/usage/connections">Connect an account</Link></Button>}
              />
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              {visibleWindows.map(({ account: a, pace: p }) => (
                <AllowanceCard key={a.id + p.window_key} account={a} pace={p} now={now} />
              ))}
            </div>

            {data.accounts
              .filter(a => (account === 'all' || a.id === account) && !windows.some(w => w.account.id === a.id))
              .map(a => (
                <EmptyState
                  key={a.id}
                  title={`${a.label} — waiting for allowance history`}
                  description="No allowance readings collected yet. Connect this account’s quota collector to see its remaining allowance and projection."
                  actions={<Button size="sm" variant="outline" asChild><Link href="/usage/connections">Check connection</Link></Button>}
                />
              ))}

            <p className="text-muted-foreground text-sm">
              Each account and allowance window is forecast independently. Open the full analysis in your{' '}
              <Link href="/usage" className="underline underline-offset-4">Monthly report</Link>.
            </p>
          </section>

          <section className="grid gap-4" aria-labelledby="model-history-heading">
            <SectionHeading
              id="model-history-heading"
              number="03"
              title="Model history"
              description="How each model appeared during the allowance cycles in view, using call share and active hours instead of converting tokens into quota."
            />
            <ModelUsageHistory data={data} windows={visibleWindows} now={now} />
          </section>
        </>
      )}
    </Workspace>
  );
}
