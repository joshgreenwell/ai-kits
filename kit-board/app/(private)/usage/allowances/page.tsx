'use client';
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/kit';
import { Choice, useLiveData, type LiveData } from '@/components/telemetry-shared';
import { UsageStatusLine } from '@/components/usage-status-line';
import { isSparkWindow, quotaOutlook } from '@/lib/telemetry-contract';
import { DEFAULT_CADENCE_MINUTES } from '@/lib/allowance-freshness';
import { AllowanceCard } from '@/components/allowance-card';
import { ModelUsageHistory } from '@/components/model-usage-history';

// /api/usage-live reports each source's effective collection cadence and each reading's source,
// so a card is judged stale at the cadence of the collector that produced its newest reading.
type LiveSource = LiveData['sources'][number];
type LiveQuota = LiveData['quotas'][number];

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

/** The Allowances subtab: per-account window pressure and model history; the per-account accordions are USG-023. */
export default function Allowances() {
  const { data, error, now, retry } = useLiveData();
  const [account, setAccount] = useState('all'), [showSpark, setShowSpark] = useState(false);
  const windows = useMemo(() => data?.accounts.filter(a => account === 'all' || a.id === account).flatMap(a => {
    const cadenceBySource = new Map((data.sources as LiveSource[]).map(s => [s.id, s.cadence_minutes ?? DEFAULT_CADENCE_MINUTES]));
    const samples = (data.quotas as LiveQuota[]).filter(q => q.account_id === a.id);
    return [...new Set(samples.map(q => q.window_key))].flatMap(key => {
      const rows = samples.filter(q => q.window_key === key);
      // The cadence belongs to the producer of the current reading; a disabled producer's rows are history only.
      const live = rows.filter(q => !q.history_only);
      const newest = (live.length ? live : rows).reduce((best, row) => (Date.parse(row.observed_at) > Date.parse(best.observed_at) ? row : best), rows[0]);
      const cadence = (newest.source_id && cadenceBySource.get(newest.source_id)) || DEFAULT_CADENCE_MINUTES;
      const pace = quotaOutlook(rows, now, cadence);
      return pace ? [{ account: a, pace }] : [];
    });
  }) ?? [], [account, data, now]);
  const sparkCount = windows.filter(w => isSparkWindow(w.pace)).length;
  const visibleWindows = windows.filter(w => showSpark || !isSparkWindow(w.pace));

  return (
    <Workspace>
      <PageHeader
        eyebrow="Usage · allowances"
        title="Allowances"
        description="Current-window pressure for each connected account, seeded by completed reset cycles and blended toward live evidence as it accumulates."
        actions={<Button variant="outline" size="sm" asChild><Link href="/usage/resets">Reset calendar</Link></Button>}
      />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Allowances are temporarily unavailable</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={retry}>Retry loading</Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <Choice
          label="Account"
          value={account}
          onChange={setAccount}
          options={[{ value: 'all', label: 'All connected accounts' }, ...(data?.accounts ?? []).map(a => ({ value: a.id, label: a.label }))]}
        />
        <UsageStatusLine data={data} now={now} error={error} />
      </div>

      {!data ? (
        !error && <p className="text-muted-foreground text-sm">Loading allowances…</p>
      ) : (
        <>
          <section className="grid gap-4" aria-labelledby="allowance-outlook-heading">
            <SectionHeading
              id="allowance-outlook-heading"
              number="01"
              title="Current allowances"
              description="Each account and allowance window is forecast independently from its own readings."
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
                actions={!windows.length && <Button size="sm" asChild><Link href="/settings">Connect an account</Link></Button>}
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
                  actions={<Button size="sm" variant="outline" asChild><Link href="/settings">Check connection</Link></Button>}
                />
              ))}
          </section>

          <section className="grid gap-4" aria-labelledby="model-history-heading">
            <SectionHeading
              id="model-history-heading"
              number="02"
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
