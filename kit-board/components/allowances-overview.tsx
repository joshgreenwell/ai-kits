'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Workspace } from '@/components/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/kit';
import { AllowanceAccordion, allowanceAnchor } from '@/components/allowance-accordion';
import { AllowanceOutlook } from '@/components/allowance-outlook';
import { SectionNav } from '@/components/kit/section-nav';
import { Choice, type LiveData } from '@/components/telemetry-shared';
import { UsageStatusLine } from '@/components/usage-status-line';
import { ModelUsageHistory } from '@/components/model-usage-history';
import { ResetRecord } from '@/components/reset-record';
import { DISPLAY_TIMEZONE } from '@/lib/usage-periods';
import {
  DEFAULT_PREFERENCES, HISTORY_RANGES, PREFERENCE_KEY, accountViews, carriedAccounts, expandedAccounts, parsePreferences, rememberExpanded, type AllowancePreferences, type HistoryDays,
} from '@/lib/allowance-view';
import type { InstallsSummary } from '@/lib/usage-store';
import { oauthFailureAlerts, oauthFailureInstallNotices } from '@/lib/claude-oauth-notice';
import type { CollectionSettings } from '@/lib/companion-settings';

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

/** The page's jumps: the cross-account outlook, then per-account detail, model activity, and the public reset record. */
const JUMPS = [
  { anchor: 'allowances-outlook', label: 'Outlook' }, { anchor: 'allowances-accounts', label: 'Accounts' },
  { anchor: 'allowances-models', label: 'Model activity' }, { anchor: 'reset-calendar', label: 'Reset calendar' },
] as const;

function mergeAlerts(identity: Record<string, string[]>, oauth: Record<string, string[]>) {
  const alerts: Record<string, string[]> = {};
  for (const id of new Set([...Object.keys(oauth), ...Object.keys(identity)])) {
    alerts[id] = [...(oauth[id] ?? []), ...(identity[id] ?? [])];
  }
  return alerts;
}

/**
 * The Allowances subtab as a view of what the page has already read: live readings, the dashboard's
 * installs for identity and OAuth alerts, and the collection settings. Fetching stays in the route, so
 * this renders the same from a fixture as from the live feed.
 */
export function AllowancesOverview({ data, error, now, onRetry, installs, settings }: {
  data: LiveData | null; error: string; now: number; onRetry: () => void; installs: InstallsSummary['installs'] | null; settings: CollectionSettings;
}) {
  const params = useSearchParams();
  const [preferences, setPreferences] = useState<AllowancePreferences | null>(null);
  useEffect(() => {
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(PREFERENCE_KEY); } catch { stored = null; }
    setPreferences(parsePreferences(stored));
  }, []);
  const update = (patch: Partial<AllowancePreferences>) => setPreferences(current => {
    const next = { ...(current ?? DEFAULT_PREFERENCES), ...patch };
    try { window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
    return next;
  });
  const active = preferences ?? DEFAULT_PREFERENCES;
  const carried = useMemo(() => (data ? carriedAccounts(new URLSearchParams(params.toString()), data.accounts) : []), [data, params]);
  const narrowed = !!data && carried.length < data.accounts.length;
  const oauthNotices = useMemo(() => oauthFailureInstallNotices(installs, settings), [installs, settings]);
  const views = useMemo(() => (data ? accountViews({ accounts: carried, sources: data.sources as LiveData['sources'], quotas: data.quotas, now, historyDays: active.historyDays, showSpark: active.showSpark, alerts: mergeAlerts(identityAlerts(installs), oauthFailureAlerts(installs, settings)) }) : []),
    [data, carried, now, active.historyDays, active.showSpark, installs, settings]);
  const expanded = useMemo(() => expandedAccounts(active, carried), [active, carried]);
  const sparkTotal = views.reduce((n, v) => n + v.windows.filter(w => w.spark).length, 0);
  const modelWindows = views.flatMap(v => v.visible.filter(w => w.pace !== null).map(w => ({ account: v.account, pace: w.pace! })));
  const [target, setTarget] = useState<string | null>(null);
  // An outlook row opens its account, then scrolls once the window's detail has rendered inside it. The
  // charts above it size themselves after mounting and push it down, so the scroll is corrected once more.
  useEffect(() => {
    if (!target) return;
    const go = () => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const frame = requestAnimationFrame(go);
    const settle = window.setTimeout(() => { go(); setTarget(null); }, 450);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); };
  }, [target]);
  const openWindow = (accountId: string, windowKey: string) => {
    if (!expanded.includes(accountId)) update({ expanded: rememberExpanded(active, data?.accounts ?? [], carried, [...expanded, accountId]) });
    setTarget(allowanceAnchor(accountId, windowKey));
  };

  return (
    <Workspace>
      {oauthNotices.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Claude OAuth usage failed</AlertTitle>
          <AlertDescription>
            <p>Observatory could not collect Claude allowance through the signed-in Claude Code OAuth interface. Statusline is the fallback while Claude Code is running. Tokens, model, and effort metadata are collected; conversation text is never uploaded.</p>
            <ul className="mt-2 grid gap-2">
              {oauthNotices.map(row => (
                <li key={row.machine_label}><span className="font-medium">{row.machine_label}.</span> {row.notice.body}</li>
              ))}
            </ul>
            <p className="mt-2"><Link href="/settings/collection" className="underline underline-offset-4">Collection settings</Link> has Keep Claude Code signed in.</p>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant={data ? 'warning' : 'destructive'}>
          <AlertTitle>{data ? 'The latest refresh failed' : 'Allowances are temporarily unavailable'}</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>Retry loading</Button>
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
          {views.length ? <SectionNav label="Allowances sections" jumps={JUMPS} /> : null}
          <section id="allowances-outlook" className="grid min-w-0 scroll-mt-28 gap-4" aria-label="Outlook">
            <AllowanceOutlook views={views} now={now} timezone={DISPLAY_TIMEZONE} onSelect={openWindow} />
          </section>

          <section id="allowances-accounts" className="grid min-w-0 scroll-mt-28 gap-4" aria-label="Accounts">
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

          <section id="allowances-models" className="grid min-w-0 scroll-mt-28 gap-4" aria-label="Model history">
            <ModelUsageHistory data={data} windows={modelWindows} now={now} />
          </section>
        </>
      )}

      {/*
        The calendar reads the public feeds, not this Observatory's own readings, so it does not wait
        on live allowance data; /usage/resets now redirects to this anchor.
      */}
      <section id="reset-calendar" className="grid min-w-0 scroll-mt-28 gap-4" aria-label="Reset calendar">
        <ResetRecord />
      </section>
    </Workspace>
  );
}
