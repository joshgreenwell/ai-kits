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
import type { AdapterCoverage } from '@/lib/usage-contract';
import type { CollectionSettings } from '@/lib/companion-settings';

export type InstallsData = {
  installs: {
    id: string; machine_label: string; kind: 'companion' | 'browser'; platform: string; arch: string;
    paused: boolean; disabled: boolean; companion_version: string | null; created_at: string; last_seen_at: string | null;
    applied_settings_version: number | null; update_available: boolean;
    latest_run: { run_id: string; finished_at: string; companion_version: string; settings_version: number; coverage: AdapterCoverage[];
      accepted_buckets: number; accepted_records: number; rejected_records: number } | null;
    bindings: { id: string; account_id: string; account_label: string; provider: string; enabled: boolean; identity_state: 'confirmed' | 'unconfirmed' | 'reset';
      last_seen_at: string | null; v1_active: { id: string; machine_label: string; last_seen_at: string | null }[] }[];
  }[];
  settings: CollectionSettings; settings_version: number; latest_companion_version: string | null;
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
          <Link href="/usage/settings" className="underline underline-offset-4">Settings</Link>; every install applies them on its next run.
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
                  <p className="text-muted-foreground text-xs leading-relaxed">Open the browser collector’s options page and paste the code. Then confirm each site you want collected.</p>
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
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild><a href="/api/collector-download?kind=browser">Download browser collector</a></Button>
            </div>
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
        {data?.installs.length ? (
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
                      {install.companion_version ?? 'version unknown'} · {install.platform}/{install.arch} · last run {run ? when(run.finished_at) : 'never'} · applied settings v{install.applied_settings_version ?? '—'}{data.settings_version !== install.applied_settings_version ? ' (pending)' : ''}
                      {run && <span className="mt-0.5 block">{run.accepted_buckets} buckets · {run.accepted_records} records accepted · {run.rejected_records} rejected</span>}
                    </>}
                    aside={<>
                      <StatusBadge status={status}>{install.disabled ? 'disabled' : run ? `last seen ${when(install.last_seen_at)}` : 'never run'}</StatusBadge>
                      {!install.disabled && (install.paused
                        ? <Button variant="outline" size="sm" onClick={() => void act({ id: install.id, action: 'resume' }, 'Install resumed; it applies on the next run.')}>Resume</Button>
                        : <Button variant="outline" size="sm" onClick={() => void act({ id: install.id, action: 'pause' }, 'Install paused; it stops on the next run.')}>Pause</Button>)}
                      {!install.disabled && <Button variant="outline" size="sm" onClick={() => { if (confirm('Disable this install? Its key stops working and its bindings leave the dashboards.')) void act({ id: install.id, action: 'disable' }, 'Install disabled.'); }}>Disable</Button>}
                    </>}
                  />
                  <div className="grid gap-2 px-4 pb-3">
                    {install.bindings.map(binding => (
                      <div key={binding.id} className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                        <span className="text-foreground">{binding.account_label}</span>
                        <span className="text-muted-foreground">{binding.account_id} · {binding.provider}</span>
                        <Badge variant={binding.identity_state === 'confirmed' ? 'soft' : binding.identity_state === 'reset' ? 'soft-warning' : 'outline'}>identity {binding.identity_state}</Badge>
                        {!binding.enabled && <Badge variant="outline">binding disabled</Badge>}
                        {binding.v1_active.length > 0 && <Badge variant="soft-warning" title={binding.v1_active.map(v => v.machine_label).join(', ')}>v1 schedule still reporting for this account</Badge>}
                        {!install.disabled && (
                          <span className="flex gap-1">
                            <Button variant="ghost" size="xs" onClick={() => void act({ id: install.id, action: binding.enabled ? 'binding_disable' : 'binding_enable', binding_id: binding.id }, binding.enabled ? 'Binding disabled.' : 'Binding enabled.')}>{binding.enabled ? 'Disable' : 'Enable'}</Button>
                            {binding.identity_state !== 'reset' && <Button variant="ghost" size="xs" onClick={() => void act({ id: install.id, action: 'approve_identity', binding_id: binding.id }, 'Re-confirmation approved; the install posts the new identity on its next run.')}>Approve re-confirmation</Button>}
                          </span>
                        )}
                      </div>
                    ))}
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
            <EmptyState title="No companion installs yet" description="Issue a pairing code above, then run `observatory connect` and `observatory setup` on the machine. Installs appear here after their first publish." />
          </div>
        )}
      </Card>
    </section>
  );
}
