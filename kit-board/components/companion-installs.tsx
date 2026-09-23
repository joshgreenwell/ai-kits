'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { CopyButton, EmptyState, Field, ListRow, ListRows, StatusBadge, type RunStatus } from '@/components/kit';
import { when } from '@/components/telemetry-shared';
import { fetchPrivateJson } from '@/lib/fetch-private-json';
import { readingFreshness } from '@/lib/allowance-freshness';
import type { AdapterCoverage } from '@/lib/usage-contract';
import type { InstallsSummary, InstallSummary } from '@/lib/usage-store';
import { claudeOauthFailureNotice } from '@/lib/claude-oauth-notice';
import type { CollectionSettings } from '@/lib/companion-settings';

// The store's own summary shape is the client type, so a field the Connections page renders cannot drift from what the API returns.
export type InstallsData = Pick<InstallsSummary, 'installs' | 'settings' | 'settings_version' | 'latest_companion_version'> & {
  ledgers?: Record<string, number>; as_of?: string;
};

export function useInstalls() {
  const [data, setData] = useState<InstallsData | null>(null), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    try { setData(await fetchPrivateJson<InstallsData>('/api/usage-v2', current.signal)); setError(''); }
    catch { if (!current.signal.aborted) setError('Companion status is temporarily unavailable.'); }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 60_000); return () => { clearInterval(timer); controller.current?.abort(); }; }, [refresh]);
  return { data, error, refresh };
}

const coverageStatus: Record<AdapterCoverage['state'], RunStatus> = {
  ok: 'validated', partial: 'incomplete', failed: 'failed', disabled_by_setting: 'disabled', denied_locally: 'disabled',
  prerequisite_missing: 'incomplete', credential_unavailable: 'incomplete', identity_changed: 'incomplete', rate_limited: 'incomplete',
};
type Capability = NonNullable<AdapterCoverage['capabilities']>[number];
const capabilityStatus: Record<Capability['state'], RunStatus> = {
  complete: 'validated', partial: 'incomplete', unsupported: 'incomplete', disabled_by_setting: 'disabled', unknown: 'incomplete',
};

function allowanceBadgeLabel(capability: { state: string; detail_code?: string | null }) {
  if (capability.detail_code === 'reader_fallback_statusline') return `allowance ${capability.state} · OAuth failed, using statusline`;
  if (capability.detail_code === 'credential_expired') return `allowance ${capability.state} · OAuth sign-in expired`;
  if (capability.detail_code === 'credential_missing') return `allowance ${capability.state} · OAuth sign-in missing`;
  return `allowance ${capability.state}${capability.detail_code ? ` (${capability.detail_code})` : ''}`;
}

function ClaudeOauthCallout({ install, global }: { install: InstallSummary; global: CollectionSettings }) {
  const notice = claudeOauthFailureNotice(install, global);
  if (!notice) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        {notice.body}{' '}
        <Link href="/settings/collection" className="underline underline-offset-4">Collection settings</Link>
        {' '}has Keep Claude Code signed in.
      </AlertDescription>
    </Alert>
  );
}

/** The allowance capability row the provider's adapter reported in the latest run, if any. */
function allowanceCapability(run: InstallSummary['latest_run'], provider: string) {
  for (const entry of run?.coverage ?? []) {
    if (!entry.adapter.startsWith(`${provider}_`)) continue;
    const capability = entry.capabilities?.find(c => c.dimension === 'allowance');
    if (capability) return { adapter: entry.adapter, ...capability };
  }
  return null;
}

/** Newest allowance reading per binding, judged by the shared freshness rule at the install's cadence. */
function allowanceReading(binding: InstallSummary['bindings'][number], cadenceMinutes: number, now: number) {
  const reading = binding.last_observation.allowance;
  if (!reading) return null;
  const freshness = readingFreshness({ observedAt: reading.observed_at, resetsAt: reading.resets_at, now, cadenceMinutes });
  return { ...reading, ...freshness };
}

function acceptedByTypeText(counts: InstallSummary['accepted_by_type']) {
  return Object.entries(counts).map(([type, c]) => {
    const reasons = Object.entries(c).filter(([key, n]) => key.startsWith('rejected:') && n > 0).map(([key, n]) => `${n} ${key.slice('rejected:'.length)}`);
    return `${type} ${c.accepted} accepted${c.duplicate ? `, ${c.duplicate} duplicate` : ''}${c.rejected ? `, ${c.rejected} rejected${reasons.length ? ` (${reasons.join(', ')})` : ''}` : ''}`;
  }).join(' · ');
}

const healthStatus: Record<string, RunStatus> = {
  paired: 'validated', complete: 'validated', confirmed: 'validated', ok: 'validated', fresh: 'validated', observed: 'validated',
  partial: 'incomplete', mixed: 'incomplete', unconfirmed: 'incomplete', reset: 'incomplete', changed: 'incomplete', stale: 'incomplete', unknown: 'incomplete', blocked: 'incomplete',
  none: 'never-run', never: 'never-run', off: 'disabled', failed: 'failed',
};

/** The ladder: one labelled rung per fact the server holds, so "off" never reads as "broken". */
function HealthLadder({ install }: { install: InstallSummary }) {
  const { health, schedule, capabilities } = install;
  const rungs: [string, string, string][] = [
    ['paired', health.pairing, 'the install holds a key'],
    ['bindings', health.binding, 'against the providers enabled for this install'],
    ['identity', health.identity, 'from the server state and the companion’s last report'],
    ['execution', health.execution, 'over the adapters this build implements with their mode on'],
    ['records', health.records, `newest ledger evidence; allowance judged at the ${schedule.cadence_basis} cadence (${schedule.effective_cadence_minutes} min)`],
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {rungs.map(([name, value, title]) => (
        <StatusBadge key={name} status={healthStatus[value] ?? 'incomplete'} title={title}>{name} {value}</StatusBadge>
      ))}
      {health.coverage_only && <Badge variant="outline" title="the last run uploaded coverage only">last run accepted no records</Badge>}
      {health.overdue && <Badge variant="soft-warning" title={`no contact since ${when(health.last_contact_at)}`}>overdue · expected every {schedule.effective_cadence_minutes} min</Badge>}
      {schedule.pending && <Badge variant="soft-warning" title={`installed ${schedule.installed_interval_minutes ?? '?'} min, desired ${schedule.desired_interval_minutes} min`}>cadence pending</Badge>}
      {capabilities.current && capabilities.previous_digest && <Badge variant="soft-info" title={`previous build ${capabilities.previous_digest.slice(0, 12)}; changed ${when(capabilities.changed_at)}`}>build changed {when(capabilities.changed_at)}</Badge>}
      {install.names.labels === 'sent' && <Badge variant="soft-info" title="readable tool, agent and project names arrive beside their hashes">Names: sent</Badge>}
      {install.names.labels === 'needs_update' && <Badge variant="outline" title="this build sends hashes only; names and app projects need companion 2.2.0">Needs companion 2.2.0</Badge>}
      {install.names.labels !== 'not_applicable' && (
        <Badge variant={install.names.deferrals_8d > 0 ? 'soft-warning' : 'outline'} title="names or project records the server could not apply in the last eight days; the companion retries them">
          {install.names.deferrals_8d} deferred · 8 days
        </Badge>
      )}
    </div>
  );
}

async function mutate(url: string, method: string, body: unknown) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((result as { error?: string }).error || 'The request failed');
  return result as Record<string, unknown>;
}

/** Companion and browser installs: pairing, bindings, coverage, and actions (section 4.6). */
export function CompanionInstalls() {
  const { data, error, refresh } = useInstalls();
  const [kind, setKind] = useState<'companion' | 'browser'>('companion'), [label, setLabel] = useState(''), [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; expires_at: string; kind: string } | null>(null), [now, setNow] = useState(() => Date.now());
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  async function issue(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFailed(false); setMessage('');
    try {
      const result = await mutate('/api/companion-installs', 'POST', { kind, machine_label: label.trim() || (kind === 'browser' ? 'Browser profile' : 'Machine') });
      setCode(result as { code: string; expires_at: string; kind: string });
    } catch (e) { setFailed(true); setMessage(e instanceof Error ? e.message : 'Could not issue a pairing code'); }
    finally { setBusy(false); }
  }
  async function act(body: Record<string, unknown>, done: string) {
    setFailed(false); setMessage('');
    try { await mutate('/api/companion-installs', 'PATCH', body); setMessage(done); await refresh(); }
    catch (e) { setFailed(true); setMessage(e instanceof Error ? e.message : 'The action failed'); }
  }
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const remaining = code ? Math.max(0, Math.floor((Date.parse(code.expires_at) - now) / 1000)) : 0;

  return (
    <section className="grid gap-4" aria-labelledby="companion-heading">
      <div className="grid gap-1">
        <h2 id="companion-heading" className="text-lg font-semibold tracking-tight">Companion installs</h2>
        <p className="text-muted-foreground max-w-[72ch] text-sm">
          One companion per machine and one browser collector per browser profile, paired with a one-time code. Collection modes live in{' '}
          <Link href="/settings/collection" className="underline underline-offset-4">Settings → Collection</Link>; every install applies them on its next run.
        </p>
      </div>

      {(error || message) && (
        <Alert variant={failed || error ? 'destructive' : 'success'} role="status">
          <AlertTitle>{failed || error ? 'Companion problem' : 'Done'}</AlertTitle>
          <AlertDescription>{message || error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a companion or browser collector</CardTitle>
            <CardDescription>The code works once and expires in ten minutes. The install key is written only on the paired device.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form className="grid gap-4" onSubmit={issue}>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant={kind === 'companion' ? 'default' : 'outline'} aria-pressed={kind === 'companion'} onClick={() => setKind('companion')}>Add companion</Button>
                <Button type="button" size="sm" variant={kind === 'browser' ? 'default' : 'outline'} aria-pressed={kind === 'browser'} onClick={() => setKind('browser')}>Add browser</Button>
              </div>
              <Field htmlFor="install-label" label={kind === 'browser' ? 'Browser profile label' : 'Machine label'} help="Shown in this list; the device may report its own name when it pairs.">
                <Input maxLength={100} value={label} onChange={e => setLabel(e.target.value)} placeholder={kind === 'browser' ? 'Chrome · personal' : 'mac-workstation'} />
              </Field>
              <div><Button type="submit" disabled={busy}>{busy ? 'Issuing…' : 'Issue pairing code'}</Button></div>
            </form>
            {code && (
              <div className="border-border grid gap-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-2xl tracking-widest tabular-nums">{remaining > 0 ? code.code : '········'}</span>
                  <Badge variant={remaining > 0 ? 'soft' : 'outline'}>{remaining > 0 ? `expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'expired'}</Badge>
                </div>
                {remaining > 0 && (code.kind === 'browser' ? (
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    In the browser profile that is signed into claude.ai, open the options page of the <em>Personal Observatory · Claude quota</em> extension
                    (version 2.0.0, loaded unpacked from <code>browser/claude-quota</code>), paste this code under <em>Pair</em>, then find the signed-in Claude account and
                    bind one organization to an Observatory account id. The install appears below after its first upload. Setup and per-profile cutover: <code>browser/claude-quota/README.md</code>.
                  </p>
                ) : (
                  <>
                    <pre className="bg-muted border-border text-muted-foreground overflow-x-auto rounded-lg border p-3 font-mono text-xs">{`observatory connect --url ${origin} --code ${code.code}\nobservatory setup`}</pre>
                    <div><CopyButton value={`observatory connect --url ${origin} --code ${code.code}`} label="Copy the connect command" /></div>
                  </>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What an install does</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground grid gap-3 text-sm leading-relaxed">
            <p>The companion reads Claude Code and Codex history on the machine, derives the same hourly buckets the local script published, and adds allowance readings, provider aggregates, and money as separate ledgers. Prompts, paths, and credentials never leave the machine.</p>
            <p>The browser collector reads allowance readings from the sites you are already signed into. It never collects tokens for browser chats.</p>
            <p>Every adapter reports its state on each run, so “off” is always distinguishable from “broken”.</p>
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Installs</CardTitle>
          <CardDescription>
            Settings version {data?.settings_version ?? '…'}{data?.latest_companion_version ? ` · latest companion ${data.latest_companion_version}` : ' · latest companion release not known yet'}
          </CardDescription>
        </CardHeader>
        {data === null ? (
          <div className="p-4">
            {error ? (
              <Button variant="outline" size="sm" onClick={() => void refresh()}>Retry loading installs</Button>
            ) : (
              <p className="text-muted-foreground text-sm" role="status">Loading companion installs…</p>
            )}
          </div>
        ) : data.installs.length ? (
          <ListRows className="rounded-none border-x-0 border-b-0">
            {data.installs.map(install => {
              const run = install.latest_run;
              const status: RunStatus = install.disabled ? 'disabled' : !run ? 'never-run' : run.rejected_records > 0 || run.coverage.some(c => c.state === 'failed') ? 'incomplete' : 'validated';
              return (
                <div key={install.id} className="border-border border-b last:border-b-0">
                  <ListRow
                    className="border-b-0"
                    title={<span className="flex flex-wrap items-center gap-2">{install.machine_label} <Badge variant="outline">{install.kind}</Badge>{install.paused && !install.disabled && <Badge variant="soft-warning">paused</Badge>}{install.update_available && <Badge variant="soft-info">update available</Badge>}</span>}
                    detail={<>
                      {install.companion_version ?? 'version unknown'} · {install.platform}/{install.arch} · last run {install.last_run_at ? when(install.last_run_at) : 'never'} · applied settings v{install.applied_settings_version ?? '—'}{data.settings_version !== install.applied_settings_version ? ' (pending)' : ''}
                      {run && <span className="mt-0.5 block">{run.accepted_buckets} buckets · {run.accepted_records} records accepted · {run.rejected_records} rejected</span>}
                      {run && Object.keys(install.accepted_by_type).length > 0 && <span className="mt-0.5 block">{acceptedByTypeText(install.accepted_by_type)}</span>}
                      <span className="mt-0.5 block">
                        {install.kind === 'browser'
                          ? `browser collector · reads allowance windows from the signed-in claude.ai tab at the ${install.cadence_minutes} min cadence while the profile is open · no capability document (health comes from each run's coverage and the readings ledger)`
                          : install.capabilities.current
                          ? `capabilities reported ${when(install.capabilities.reported_at)} by ${install.capabilities.document?.companion_version} · build ${install.capabilities.digest?.slice(0, 12)} · schedule ${install.schedule.state}${install.schedule.installed_interval_minutes !== null ? ` every ${install.schedule.installed_interval_minutes} min` : ''}${install.schedule.config_dir_pinned === false ? ' · config dir not pinned' : ''} · queue ${install.capabilities.document?.queue.records_pending ?? 0} pending, ${install.capabilities.document?.queue.outbox_envelopes ?? 0} envelopes · backfill since ${install.capabilities.document?.backfill.since ?? '—'}${install.capabilities.document?.backfill.complete ? '' : ' (in progress)'}`
                          : install.capabilities.reason === 'never_reported' ? 'no capability report yet: update the companion and run it once' : `capability report not current (${install.capabilities.reason}${install.capabilities.document ? `, from ${install.capabilities.document.companion_version} ${when(install.capabilities.reported_at)}` : ''})`}
                      </span>
                      {install.schedule.pending && <span className="text-warning mt-0.5 block">cadence {install.schedule.desired_interval_minutes} min pending — run `observatory service install` with the same --config-dir this install was set up with (`observatory doctor` prints it)</span>}
                      {install.capabilities.current && (install.capabilities.document?.detailed_report ?? []).map(report => (
                        <span key={report.binding_id} className="mt-0.5 block">detailed monthly report · {report.configured ? `configured (machine ${report.machine_id ?? '—'})` : 'not configured'}{report.last_status ? ` · last ${report.last_status}${report.last_error_code ? ` (${report.last_error_code})` : ''}` : ' · not run yet'}</span>
                      ))}
                    </>}
                    aside={<>
                      <StatusBadge status={status} title="Last contact is any accepted upload, readings or not; each binding lists its newest reading below.">{install.disabled ? 'disabled' : run ? `last contact ${when(install.last_seen_at)}` : 'never run'}</StatusBadge>
                      {!install.disabled && (install.paused
                        ? <Button variant="outline" size="sm" onClick={() => void act({ id: install.id, action: 'resume' }, 'Install resumed; it applies on the next run.')}>Resume</Button>
                        : <Button variant="outline" size="sm" onClick={() => void act({ id: install.id, action: 'pause' }, 'Install paused; it stops on the next run.')}>Pause</Button>)}
                      {!install.disabled && <Button variant="outline" size="sm" onClick={() => { if (confirm('Disable this install? Its key stops working and its bindings leave the dashboards.')) void act({ id: install.id, action: 'disable' }, 'Install disabled.'); }}>Disable</Button>}
                    </>}
                  />
                  <div className="grid gap-2 px-4 pb-3">
                    <HealthLadder install={install} />
                    {data && <ClaudeOauthCallout install={install} global={data.settings} />}
                    {install.bindings.map(binding => {
                      const reading = allowanceReading(binding, install.cadence_minutes, now);
                      const capability = allowanceCapability(run, binding.provider);
                      return (
                      <div key={binding.id} className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                        <span className="text-foreground">{binding.account_label}</span>
                        <span className="text-muted-foreground">{binding.account_id} · {binding.provider}</span>
                        <Badge variant={binding.identity_state === 'confirmed' ? 'soft' : binding.identity_state === 'reset' ? 'soft-warning' : 'outline'}>identity {binding.identity_state}</Badge>
                        {binding.duplicate_identity && <span className="text-warning">shares an identity with another binding — approve re-confirmation on one of them, then sign into that account and run</span>}
                        {!binding.enabled && <Badge variant="outline">binding disabled</Badge>}
                        <span className="text-muted-foreground" title={reading ? `received ${when(binding.last_received.allowance)} · stale after ${reading.staleAfterMinutes} min at cadence ${install.cadence_minutes}` : undefined}>
                          {reading ? `last allowance reading ${when(reading.observed_at)} (${reading.reader} · ${reading.stale ? 'stale' : 'fresh'})` : 'no readings yet'}
                        </span>
                        {capability && (
                          <StatusBadge status={capabilityStatus[capability.state]} title={`${capability.adapter} · ${allowanceBadgeLabel(capability)}`}>
                            {allowanceBadgeLabel(capability)}
                          </StatusBadge>
                        )}
                        {binding.v1_active.length > 0 && <Badge variant="soft-warning" title={binding.v1_active.map(v => v.machine_label).join(', ')}>v1 schedule still reporting for this account</Badge>}
                        {!install.disabled && (
                          <span className="flex gap-1">
                            <Button variant="ghost" size="xs" onClick={() => void act({ id: install.id, action: binding.enabled ? 'binding_disable' : 'binding_enable', binding_id: binding.id }, binding.enabled ? 'Binding disabled.' : 'Binding enabled.')}>{binding.enabled ? 'Disable' : 'Enable'}</Button>
                            {binding.identity_state !== 'reset' && <Button variant="ghost" size="xs" onClick={() => void act({ id: install.id, action: 'approve_identity', binding_id: binding.id }, 'Re-confirmation approved; the install posts the new identity on its next run.')}>Approve re-confirmation</Button>}
                          </span>
                        )}
                      </div>
                      );
                    })}
                    {run && run.coverage.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {run.coverage.map(entry => (
                          <StatusBadge key={entry.adapter} status={coverageStatus[entry.state]} title={`${entry.state}${entry.detail_code ? ` · ${entry.detail_code}` : ''} · ${entry.records_emitted} records · ${entry.duration_ms}ms`}>
                            {entry.adapter}: {entry.state}{entry.detail_code ? ` (${entry.detail_code})` : ''}
                          </StatusBadge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </ListRows>
        ) : (
          <div className="p-4">
            <EmptyState title="No companion installs yet" description="Issue a pairing code above, then run `observatory connect` and `observatory setup` on the machine, or pair the browser collector from its options page. Installs appear here after their first publish." />
          </div>
        )}
      </Card>
    </section>
  );
}
