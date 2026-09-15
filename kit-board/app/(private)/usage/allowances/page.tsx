'use client';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/kit';
import { AllowanceAccordion } from '@/components/allowance-accordion';
import { Choice, useLiveData, type LiveData } from '@/components/telemetry-shared';
import { UsageStatusLine } from '@/components/usage-status-line';
import { ModelUsageHistory } from '@/components/model-usage-history';
import { fetchPrivateJson } from '@/lib/fetch-private-json';
import { DISPLAY_TIMEZONE } from '@/lib/usage-periods';
import {
  DEFAULT_PREFERENCES, HISTORY_RANGES, PREFERENCE_KEY, accountViews, carriedAccounts, expandedAccounts, parsePreferences, rememberExpanded, type AllowancePreferences, type HistoryDays,
} from '@/lib/allowance-view';
import type { InstallsSummary } from '@/lib/usage-store';

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

const INSTALLS_TTL = 5 * 60_000;

/** Per-account identity alerts from the dashboard summary: a held reading is an absent one, and the header should say why. */
function identityAlerts(installs: InstallsSummary['installs'] | null) {
  const alerts: Record<string, string[]> = {};
  for (const install of installs ?? []) {
    for (const binding of install.bindings) {
      if (!binding.enabled) continue;
      const note = binding.duplicate_identity
        ? `Identity ambiguous on ${install.machine_label}: two enabled bindings share one sign-in, so its readings are held on the machine until one is re-confirmed under Settings.`
        : binding.identity_state === 'unconfirmed' ? `Identity unconfirmed on ${install.machine_label}: readings the collector cannot attribute are held on the machine, not shown here.`
        : binding.identity_state === 'reset' ? `Identity awaiting re-confirmation on ${install.machine_label}: new readings are refused until the companion posts the identity it observes.` : null;
      if (note && !(alerts[binding.account_id] ??= []).includes(note)) alerts[binding.account_id].push(note);
    }
  }
  return alerts;
}

function AllowancesInner() {
  const { data, error, now, retry } = useLiveData();
  const params = useSearchParams();
  const [preferences, setPreferences] = useState<AllowancePreferences | null>(null);
  const [installs, setInstalls] = useState<InstallsSummary['installs'] | null>(null);
  const installsAt = useRef(0);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(PREFERENCE_KEY); } catch { stored = null; }
    setPreferences(parsePreferences(stored));
  }, []);
  // Identity alerts follow the live refresh: a failed fetch is retried on the next refresh, a good one is kept for a while.
  useEffect(() => {
    if (!data || Date.now() - installsAt.current < INSTALLS_TTL) return;
    const controller = new AbortController();
    fetchPrivateJson<InstallsSummary>('/api/usage-v2', controller.signal)
      .then(summary => { if (!controller.signal.aborted) { installsAt.current = Date.now(); setInstalls(summary.installs); } })
      .catch(() => {});
    return () => controller.abort();
  }, [data]);
  const update = (patch: Partial<AllowancePreferences>) => setPreferences(current => {
    const next = { ...(current ?? DEFAULT_PREFERENCES), ...patch };
    try { window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });
  const active = preferences ?? DEFAULT_PREFERENCES;
  const carried = useMemo(() => (data ? carriedAccounts(new URLSearchParams(params.toString()), data.accounts) : []), [data, params]);
  const narrowed = !!data && carried.length < data.accounts.length;
  const views = useMemo(() => (data ? accountViews({ accounts: carried, sources: data.sources as LiveData['sources'], quotas: data.quotas, now, historyDays: active.historyDays, showSpark: active.showSpark, alerts: identityAlerts(installs) }) : []),
    [data, carried, now, active.historyDays, active.showSpark, installs]);
  const expanded = useMemo(() => expandedAccounts(active, carried), [active, carried]);
  const sparkTotal = views.reduce((n, v) => n + v.windows.filter(w => w.spark).length, 0);
  const modelWindows = views.flatMap(v => v.visible.filter(w => w.pace !== null).map(w => ({ account: v.account, pace: w.pace! })));

  return (
    <Workspace>
      <PageHeader
        eyebrow="Usage · allowances"
        title="Allowances"
        description="Each account's current windows and reset outlook, forecast independently from its own readings. Percentages are the provider's own meters; tokens never convert into allowance."
        actions={<Button variant="outline" size="sm" asChild><Link href="/usage/resets">Reset calendar</Link></Button>}
      />

      {error && (
        <Alert variant={data ? 'warning' : 'destructive'}>
          <AlertTitle>{data ? 'The latest refresh failed' : 'Allowances are temporarily unavailable'}</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={retry}>Retry loading</Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Choice label="History" value={String(active.historyDays)} onChange={value => update({ historyDays: Number(value) as HistoryDays })} options={HISTORY_RANGES.map(days => ({ value: String(days), label: `Last ${days} days` }))} />
          <Button type="button" variant="outline" size="sm" aria-pressed={active.showSpark} onClick={() => update({ showSpark: !active.showSpark })} disabled={!sparkTotal && !active.showSpark}>
            {active.showSpark ? 'Hide' : 'Show'} Codex Spark{sparkTotal ? ` (${sparkTotal})` : ''}
          </Button>
          {narrowed ? <Button variant="ghost" size="sm" asChild><Link href="/usage/allowances">Show all accounts</Link></Button> : null}
        </div>
        <UsageStatusLine data={data} now={now} error={error} />
      </div>

      {!data ? (
        !error && <p className="text-muted-foreground text-sm">Loading allowances…</p>
      ) : (
        <>
          <section className="grid gap-4" aria-labelledby="allowance-accounts-heading">
            <SectionHeading id="allowance-accounts-heading" number="01" title="Accounts" description={`Current capacity is the newest live reading per window in ${DISPLAY_TIMEZONE}; the history range changes the charts only.${narrowed ? ' Showing the accounts carried from Tokens.' : ''}`} />
            {views.length ? (
              <AllowanceAccordion views={views} expanded={expanded} onExpandedChange={ids => update({ expanded: rememberExpanded(active, data.accounts, carried, ids) })} now={now} timezone={DISPLAY_TIMEZONE} />
            ) : (
              <EmptyState
                title={narrowed ? 'No matching accounts' : 'No accounts connected'}
                description={narrowed ? 'The accounts carried from Tokens are not in this Observatory.' : 'Allowance readings will appear after a Codex log update or a Claude browser/statusline collection.'}
                actions={narrowed ? <Button size="sm" variant="outline" asChild><Link href="/usage/allowances">Show all accounts</Link></Button> : <Button size="sm" asChild><Link href="/settings">Connect an account</Link></Button>}
              />
            )}
          </section>

          <section className="grid gap-4" aria-labelledby="model-history-heading">
            <SectionHeading id="model-history-heading" number="02" title="Model history" description="How each model appeared during the allowance cycles in view, using call share and active hours instead of converting tokens into quota." />
            <ModelUsageHistory data={data} windows={modelWindows} now={now} />
          </section>
        </>
      )}
    </Workspace>
  );
}

/** The Allowances subtab: one expandable card per account (USG-023), then model history. */
export default function Allowances() {
  return <Suspense fallback={<Workspace><p className="text-muted-foreground text-sm">Loading allowances…</p></Workspace>}><AllowancesInner /></Suspense>;
}
