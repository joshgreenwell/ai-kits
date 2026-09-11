'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EmptyState, Field, ListRow, ListRows, StatusBadge } from '@/components/kit';
import { Choice, useLiveData, when } from '@/components/telemetry-shared';

export default function Connections() {
  const { data, error } = useLiveData();
  const [provider, setProvider] = useState('claude'), [mode, setMode] = useState('browser'), [accountId, setAccountId] = useState('claude-personal'), [accountLabel, setAccountLabel] = useState('Claude · personal'), [machineLabel, setMachineLabel] = useState('Personal browser'), [message, setMessage] = useState(''), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);

  async function connect(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(''); setFailed(false);
    try {
      const r = await fetch('/api/usage-connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: accountId, account_label: accountLabel, provider, mode, machine_label: machineLabel }) });
      const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Could not create connection');
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `observatory-${accountId}-${mode}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(mode === 'browser' ? 'Import the downloaded JSON in the browser collector popup. Then choose Find my Claude account and pin the correct organization.' : 'Save the downloaded JSON beside the local collector scripts. On Windows, use %LOCALAPPDATA%\\PersonalObservatory. Follow Windows setup below.');
    } catch (e) { setFailed(true); setMessage(e instanceof Error ? e.message : 'Connection failed'); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    const r = await fetch('/api/usage-connections', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    setFailed(!r.ok);
    setMessage(r.ok ? 'Connection disabled. The list refreshes within a minute.' : 'Could not disable the connection.');
  }

  return (
    <Workspace>
      <PageHeader
        eyebrow="Private collection · no inference"
        title="Usage connections"
        actions={<Badge variant="outline">Hourly by default</Badge>}
      />

      {(error || message) && (
        <Alert variant={failed || error ? 'destructive' : 'success'} role="status">
          <AlertTitle>{failed || error ? 'Connection problem' : 'Connection file downloaded'}</AlertTitle>
          <AlertDescription>{message || error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connect an account or machine</CardTitle>
            <CardDescription>
              Each connection can upload only to the account you select here. Browser connections can
              upload quota readings only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={connect}>
              <Choice
                label="Provider"
                value={provider}
                onChange={v => {
                  setProvider(v);
                  const existing = data?.accounts.find(a => a.provider === v);
                  setAccountId(existing?.id ?? `${v}-primary`);
                  setAccountLabel(existing?.label ?? `${v === 'codex' ? 'Codex' : 'Claude'} · primary`);
                  if (v === 'codex') setMode('local');
                }}
                options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]}
              />
              <Choice
                label="Collection method"
                value={mode}
                onChange={setMode}
                options={provider === 'claude'
                  ? [{ value: 'browser', label: 'Browser · allowance readings' }, { value: 'local', label: 'Local script · token logs' }]
                  : [{ value: 'local', label: 'Local script · token logs & allowances' }]}
              />
              <Field htmlFor="conn-account-id" label="Account ID" help="Reuse the same ID for this account across machines.">
                <Input required pattern="[a-z0-9][a-z0-9-]{1,79}" value={accountId} onChange={e => setAccountId(e.target.value)} />
              </Field>
              <Field htmlFor="conn-account-label" label="Account label">
                <Input required maxLength={80} value={accountLabel} onChange={e => setAccountLabel(e.target.value)} />
              </Field>
              <Field htmlFor="conn-machine-label" label="Machine or browser label">
                <Input required maxLength={100} value={machineLabel} onChange={e => setMachineLabel(e.target.value)} />
              </Field>
              <div>
                <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Download connection file'}</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Choose how to collect</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm">
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Codex &amp; Claude Code</h3>
              <p className="text-muted-foreground leading-relaxed">
                The Python script reads new log entries, remembers its position, and uploads hourly
                counters. Prompts and responses stay on your machine. An hourly run can catch up
                after sleep.
              </p>
              <pre className="bg-muted border-border text-muted-foreground overflow-x-auto rounded-lg border p-3 font-mono text-xs">python3 collect.py --config connection.json</pre>
              <p className="text-muted-foreground leading-relaxed">
                Use LaunchAgent on macOS or Task Scheduler on Windows. An optional Claude statusline
                hook captures allowance readings during Claude Code sessions.
              </p>
            </section>

            <details open className="border-border rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-semibold">Windows setup · where the connection file goes</summary>
              <ol className="text-muted-foreground mt-3 grid list-decimal gap-2 pl-5 leading-relaxed">
                <li>Choose <strong className="text-foreground">Local script</strong> above and download a connection for the correct provider and account. Reuse the account ID for the same account on another computer.</li>
                <li>Install Python 3.10 or newer. Download the local collector below and extract its files into <code className="font-mono text-xs">%LOCALAPPDATA%\PersonalObservatory</code>. Paste that path into File Explorer; create the folder if needed.</li>
                <li>Move the downloaded local JSON into that folder and name it <code className="font-mono text-xs">connection.json</code>. Keep it private; it contains an upload key.</li>
                <li>Open PowerShell and run:</li>
              </ol>
              <pre className="bg-muted border-border text-muted-foreground mt-3 overflow-x-auto rounded-lg border p-3 font-mono text-xs">{'Set-Location "$env:LOCALAPPDATA\\PersonalObservatory"\npy -3 .\\collect.py --config .\\connection.json --dry-run\npy -3 .\\collect.py --config .\\connection.json\npy -3 .\\install_schedule.py --config .\\connection.json'}</pre>
              <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                The first command checks local logs, the next uploads them, and the last installs an
                hourly Windows task. Check for a successful upload and a new “Last check” below. Keep
                a different JSON filename for each provider/account and substitute it in the
                commands; do not overwrite a scheduled connection.
              </p>
            </details>

            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Claude in your browser</h3>
              <p className="text-muted-foreground leading-relaxed">
                A <strong className="text-foreground">Browser</strong> connection JSON goes into the
                extension popup using <strong className="text-foreground">Import connection</strong>;
                it is not used by the Python script. Load the browser collector in Chrome or Edge,
                import the file, and pin your Claude account and organization. Keep a signed-in
                Claude tab open. It reads allowance percentages and reset times once an hour while
                the browser is running.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                Claude stays signed in within that browser. Its cookies and account credentials are
                never uploaded. Browser chats do not supply token-level history through the
                subscription usage page.
              </p>
            </section>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild><a href="/api/collector-download?kind=browser">Download browser collector</a></Button>
              <Button variant="outline" size="sm" asChild><a href="/api/collector-download?kind=local">Download local collector</a></Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Reporting connections</CardTitle>
          <CardDescription>
            A fresh collector heartbeat and a fresh provider reading are different. Allowance cards
            show the age of the actual provider observation.
          </CardDescription>
        </CardHeader>
        {data?.sources.length ? (
          <ListRows className="rounded-none border-x-0 border-b-0">
            {data.sources.map(s => (
              <ListRow
                key={s.id}
                tone={s.disabled ? 'default' : undefined}
                title={s.machine_label}
                detail={
                  <>
                    {data.accounts.find(a => a.id === s.account_id)?.label} · {s.account_id} · {s.mode}
                    {s.coverage && (
                      <span className="mt-0.5 block">
                        {s.coverage.files ?? 0} files · {s.coverage.bytes_read?.toLocaleString() ?? 0} bytes read last run · {s.coverage.duration_ms ?? 0}ms
                        {(s.coverage.malformed_lines ?? 0) + (s.coverage.unavailable_roots ?? 0) > 0 ? ' · partial coverage; inspect collector' : ''}
                      </span>
                    )}
                  </>
                }
                aside={
                  <>
                    {s.disabled
                      ? <StatusBadge status="disabled" />
                      : <StatusBadge status="validated">{`Last check ${when(s.last_seen_at)}`}</StatusBadge>}
                    {!s.disabled && <Button variant="outline" size="sm" onClick={() => void revoke(s.id)}>Disable</Button>}
                  </>
                }
              />
            ))}
          </ListRows>
        ) : (
          <div className="p-4">
            <EmptyState
              title="No collectors connected yet"
              description="Create a connection above and run it once. Reporting machines appear here after their first upload."
            />
          </div>
        )}
      </Card>
    </Workspace>
  );
}
