'use client';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Choice, useLiveData, when } from '@/components/telemetry-shared';
export default function Connections() {
  const { data, error } = useLiveData();
  const [provider, setProvider] = useState('claude'), [mode, setMode] = useState('browser'), [accountId, setAccountId] = useState('claude-personal'), [accountLabel, setAccountLabel] = useState('Claude · personal'), [machineLabel, setMachineLabel] = useState('Personal browser'), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  async function connect(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/usage-connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: accountId, account_label: accountLabel, provider, mode, machine_label: machineLabel }) });
      const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Could not create connection');
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `observatory-${accountId}-${mode}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(mode === 'browser' ? 'Import the downloaded JSON in the browser collector popup. Then choose Find my Claude account and pin the correct organization.' : 'Save the downloaded JSON beside the local collector scripts. On Windows, use %LOCALAPPDATA%\\PersonalObservatory. Follow Windows setup below.');
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Connection failed'); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    const r = await fetch('/api/usage-connections', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    setMessage(r.ok ? 'Connection disabled. The list refreshes within a minute.' : 'Could not disable the connection.');
  }
  return <main className="telemetry-workspace"><PageHeader eyebrow="Private collection · no inference" title="Usage connections" actions={<Badge variant="outline">Hourly by default</Badge>} /><div className="telemetry-body">
    {(error || message) && <p className="telemetry-notice" role="status">{message || error}</p>}
    <div className="telemetry-two-column"><Card><CardHeader><CardTitle>Connect an account or machine</CardTitle><CardDescription>Each connection can upload only to the account you select here. Browser connections can upload quota readings only.</CardDescription></CardHeader><CardContent>
      <form className="telemetry-form" onSubmit={connect}>
        <Choice label="Provider" value={provider} onChange={v => { setProvider(v); const existing = data?.accounts.find(a => a.provider === v); setAccountId(existing?.id ?? `${v}-primary`); setAccountLabel(existing?.label ?? `${v === 'codex' ? 'Codex' : 'Claude'} · primary`); if (v === 'codex') setMode('local'); }} options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]} />
        <Choice label="Collection method" value={mode} onChange={setMode} options={provider === 'claude' ? [{ value: 'browser', label: 'Browser · allowance readings' }, { value: 'local', label: 'Local script · token logs' }] : [{ value: 'local', label: 'Local script · token logs & allowances' }]} />
        <label className="telemetry-choice"><span>Account ID · reuse across machines</span><Input required pattern="[a-z0-9][a-z0-9-]{1,79}" value={accountId} onChange={e => setAccountId(e.target.value)} /></label>
        <label className="telemetry-choice"><span>Account label</span><Input required maxLength={80} value={accountLabel} onChange={e => setAccountLabel(e.target.value)} /></label>
        <label className="telemetry-choice"><span>Machine or browser label</span><Input required maxLength={100} value={machineLabel} onChange={e => setMachineLabel(e.target.value)} /></label>
        <Button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Download connection file'}</Button>
      </form></CardContent></Card>
      <Card><CardHeader><CardTitle>Choose how to collect</CardTitle></CardHeader><CardContent className="telemetry-instructions"><h3>Codex & Claude Code</h3><p>The Python script reads new log entries, remembers its position, and uploads hourly counters. Prompts and responses stay on your machine. An hourly run can catch up after sleep.</p>
        <pre>python3 collect.py --config connection.json</pre><p>Use LaunchAgent on macOS or Task Scheduler on Windows. An optional Claude statusline hook captures allowance readings during Claude Code sessions.</p>
        <details className="telemetry-details" open><summary>Windows setup · where the connection file goes</summary>
          <ol><li>Choose <strong>Local script</strong> above and download a connection for the correct provider and account. Reuse the account ID for the same account on another computer.</li>
            <li>Install Python 3.10 or newer. Download the local collector below and extract its files into <code>%LOCALAPPDATA%\PersonalObservatory</code>. Paste that path into File Explorer; create the folder if needed.</li>
            <li>Move the downloaded local JSON into that folder and name it <code>connection.json</code>. Keep it private; it contains an upload key. Keep this folder in place so the hourly task can find it.</li>
            <li>Open PowerShell and run:</li></ol>
          <pre>{'Set-Location "$env:LOCALAPPDATA\\PersonalObservatory"\npy -3 .\\collect.py --config .\\connection.json --dry-run\npy -3 .\\collect.py --config .\\connection.json\npy -3 .\\install_schedule.py --config .\\connection.json'}</pre>
          <p>The first command checks local logs, the next uploads them, and the last installs an hourly Windows task. Check for a successful upload and a new “Last check” below. Keep a different JSON filename for each provider/account and substitute it in the commands; do not overwrite a scheduled connection.</p>
        </details>
        <h3>Claude in your browser</h3><p>A <strong>Browser</strong> connection JSON goes into the extension popup using <strong>Import connection</strong>; it is not used by the Python script. Load the browser collector in Chrome or Edge, import the file, and pin your Claude account and organization. Keep a signed-in Claude tab open. It reads allowance percentages and reset times once an hour while the browser is running.</p><p>Claude stays signed in within that browser. Its cookies and account credentials are never uploaded. Browser chats do not supply token-level history through the subscription usage page.</p>
        <Button variant="outline" asChild><a href="/api/collector-download?kind=browser">Download browser collector</a></Button>{' '}<Button variant="outline" asChild><a href="/api/collector-download?kind=local">Download local collector</a></Button>
      </CardContent></Card></div>
    <Card><CardHeader><CardTitle>Reporting connections</CardTitle><CardDescription>A fresh collector heartbeat and a fresh provider reading are different. Allowance cards show the age of the actual provider observation.</CardDescription></CardHeader><CardContent>
      <div className="telemetry-source-list">{data?.sources.map(s => <div key={s.id}><div><strong>{s.machine_label}</strong><small>{data.accounts.find(a => a.id === s.account_id)?.label} · {s.account_id} · {s.mode} · {s.disabled ? 'Disabled' : `Last check ${when(s.last_seen_at)}`}</small>{s.coverage && <small>{s.coverage.files ?? 0} files · {s.coverage.bytes_read?.toLocaleString() ?? 0} bytes read last run · {s.coverage.duration_ms ?? 0}ms{(s.coverage.malformed_lines ?? 0) + (s.coverage.unavailable_roots ?? 0) > 0 ? ' · partial coverage; inspect collector' : ''}</small>}</div>{!s.disabled && <Button variant="outline" onClick={() => void revoke(s.id)}>Disable</Button>}</div>)}</div>
    </CardContent></Card>
  </div></main>;
}
