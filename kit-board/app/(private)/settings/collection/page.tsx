'use client';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Workspace } from '@/components/workspace';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useInstalls } from '@/components/companion-installs';
import { getSetting, optionSupport, setSetting, settingsMatrix, type CapabilityReport, type CollectionSettings, type InstallOverride, type SettingRow } from '@/lib/companion-settings';

type Doc = Record<string, unknown>;

/** What the connected companions say about a value: never disables the control, only labels it. */
function SupportChip({ row, value, reports }: { row: SettingRow; value: unknown; reports: CapabilityReport[] }) {
  const support = optionSupport(row, value, reports);
  if (support.state === 'always') return null;
  const variant = support.state === 'supported' ? 'soft' : support.state === 'unsupported' ? 'soft-warning' : 'outline';
  return <Badge variant={variant} className="text-[10px]" title={support.label}>{support.state === 'unverified' ? 'unverified' : support.state === 'unsupported' ? 'unsupported' : `supported ${support.supported}/${support.reporting}`}</Badge>;
}

function Control({ row, value, onChange, id, disabled }: { row: SettingRow; value: unknown; onChange: (v: unknown) => void; id: string; disabled?: boolean }) {
  if (row.kind === 'switch') return <Switch id={id} aria-label={row.label} checked={value === true} disabled={disabled} onCheckedChange={v => onChange(v)} />;
  if (row.kind === 'number') return <Input id={id} aria-label={row.label} type="number" min={row.min} max={row.max} className="w-24" disabled={disabled} value={String(value ?? '')} onChange={e => onChange(Number(e.target.value))} />;
  return (
    <Select value={String(value)} disabled={disabled} onValueChange={v => onChange(typeof row.options[0] === 'number' ? Number(v) : v)}>
      <SelectTrigger id={id} aria-label={row.label} className="w-44"><SelectValue /></SelectTrigger>
      <SelectContent position="popper">{row.options.map(option => <SelectItem key={String(option)} value={String(option)}>{String(option)}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export default function SettingsPage() {
  const { data, error, refresh } = useInstalls();
  const [global, setGlobal] = useState<CollectionSettings | null>(null);
  const [overrides, setOverrides] = useState<Record<string, InstallOverride>>({});
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    setGlobal(current => current ?? data.settings);
    setOverrides(current => Object.keys(current).length ? current : Object.fromEntries(data.installs.filter(i => !i.disabled).map(i => [i.id, (i as unknown as { settings?: InstallOverride }).settings ?? {}])));
  }, [data]);

  async function save(url: string, method: string, body: unknown, done: string) {
    setBusy(true); setFailed(false); setMessage('');
    try {
      const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as { error?: string; settings_version?: number };
      if (!response.ok) throw new Error(result.error || 'Save failed');
      setMessage(`${done} Settings version is now ${result.settings_version ?? '…'}; each install applies it on its next run.`);
      await refresh();
    } catch (e) { setFailed(true); setMessage(e instanceof Error ? e.message : 'Save failed'); }
    finally { setBusy(false); }
  }
  const installs = data?.installs.filter(i => !i.disabled) ?? [];
  const reports: CapabilityReport[] = installs.map(i => ({ machine_label: i.machine_label, current: i.capabilities.current, document: i.capabilities.document }));

  return (
    <Workspace>
      <PageHeader
        eyebrow="Settings · collection modes, stored in the Observatory"
        title="Collection settings"
        description="Global defaults, and a per-install override where a machine should differ. A setting can only turn a mode on or off; it never names a path, an endpoint, or a command. A local deny list on the machine can further remove modes."
        actions={data ? <Badge variant="outline">settings v{data.settings_version}</Badge> : undefined}
      />
      {(error || message) && (
        <Alert variant={failed || error ? 'destructive' : 'success'} role="status">
          <AlertTitle>{failed || error ? 'Settings problem' : 'Saved'}</AlertTitle>
          <AlertDescription>{message || error}</AlertDescription>
        </Alert>
      )}
      {!global ? (
        !error && <p className="text-muted-foreground text-sm">Loading settings…</p>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <CardHeader className="p-4">
            <CardTitle className="text-base">Mode matrix</CardTitle>
            <CardDescription>
              Private-interface readers use the application’s existing sign-in on that machine; the companion never refreshes, copies, or uploads a credential.
              {installs.length ? ` Installs: ${installs.map(i => `${i.machine_label} (applied v${i.applied_settings_version ?? '—'})`).join(', ')}.` : ' No installs yet; overrides appear once a companion pairs.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <div className="border-border overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="bg-card uppercase">Setting</TableHead>
                    <TableHead className="bg-card uppercase">Global default</TableHead>
                    {installs.map(i => <TableHead key={i.id} className="bg-card uppercase">{i.machine_label}<span className="text-muted-foreground block text-[10px] normal-case">{i.kind} · override</span></TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settingsMatrix.map(group => (
                    <>
                      <TableRow key={group.group} className="bg-muted/40 hover:bg-muted/40"><TableCell colSpan={2 + installs.length} className="text-[10px] font-semibold tracking-wider uppercase">{group.group}</TableCell></TableRow>
                      {group.rows.map(row => (
                        <TableRow key={row.path} className="even:bg-foreground/[0.03] border-b-0">
                          <TableCell className="align-top">
                            <div className="text-sm">{row.label}</div>
                            <div className="text-muted-foreground font-mono text-[10px]">{row.path}</div>
                            {row.note && <div className="text-muted-foreground mt-0.5 max-w-[36ch] text-[11px] leading-snug">{row.note}</div>}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex flex-wrap items-center gap-2">
                              <Control id={`global-${row.path}`} row={row} value={getSetting(global as unknown as Doc, row.path)} onChange={v => setGlobal(g => setSetting(g as unknown as Doc, row.path, v) as unknown as CollectionSettings)} />
                              <SupportChip row={row} value={getSetting(global as unknown as Doc, row.path)} reports={reports} />
                            </div>
                          </TableCell>
                          {installs.map(i => {
                            const override = overrides[i.id] ?? {};
                            const own = getSetting(override as Doc, row.path);
                            const inherited = own === undefined;
                            return (
                              <TableCell key={i.id} className="align-top">
                                <div className="flex items-center gap-2">
                                  <Control id={`${i.id}-${row.path}`} row={row} value={inherited ? getSetting(global as unknown as Doc, row.path) : own}
                                    onChange={v => setOverrides(o => ({ ...o, [i.id]: setSetting((o[i.id] ?? {}) as Doc, row.path, v, global as unknown as Doc) as InstallOverride }))} />
                                  {inherited
                                    ? <span className="text-muted-foreground font-mono text-[10px]">inherits</span>
                                    : <Button variant="ghost" size="xs" onClick={() => setOverrides(o => { const next = { ...(o[i.id] ?? {}) } as Doc; const [g] = row.path.split('.'); delete next[g]; return { ...o, [i.id]: next as InstallOverride }; })}>clear group</Button>}
                                </div>
                              </TableCell>
                            );
                          })}
                        </TableRow>
                      ))}
                    </>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void save('/api/collection-settings', 'PUT', global, 'Global settings saved.')}>Save global settings</Button>
              {installs.map(i => (
                <Button key={i.id} variant="outline" disabled={busy} onClick={() => void save('/api/companion-installs', 'PATCH', { id: i.id, action: 'override', settings: overrides[i.id] ?? {} }, `Override saved for ${i.machine_label}.`)}>
                  Save override · {i.machine_label}
                </Button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              An override replaces a whole group (for example all of <span className="font-mono">allowance</span>) for that install. Clearing the group returns it to the global default. Support chips come from each companion’s own capability report and never block a save; a value no connected build implements is stored and reported as unsupported on its next run.
            </p>
            {installs.length > 0 && (
              <div className="border-border overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="bg-card uppercase">Install</TableHead>
                      <TableHead className="bg-card uppercase">Applied</TableHead>
                      <TableHead className="bg-card uppercase">Effective on the machine</TableHead>
                      <TableHead className="bg-card uppercase">Local deny list</TableHead>
                      <TableHead className="bg-card uppercase">Schedule</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {installs.map(i => {
                      const effective = i.capabilities.current ? i.capabilities.document?.effective ?? null : null;
                      return (
                        <TableRow key={i.id} className="even:bg-foreground/[0.03] border-b-0 font-mono text-[11px]">
                          <TableCell className="align-top">{i.machine_label}<span className="text-muted-foreground block">{i.capabilities.current ? `reported by ${i.capabilities.document?.companion_version}` : i.capabilities.reason === 'never_reported' ? 'no capability report yet' : `report not current (${i.capabilities.reason})`}</span></TableCell>
                          <TableCell className="align-top">v{i.applied_settings_version ?? '—'}{data && data.settings_version !== i.applied_settings_version ? ' (pending)' : ''}{effective && effective.settings_version_applied !== i.applied_settings_version ? ` · report says v${effective.settings_version_applied}` : ''}</TableCell>
                          <TableCell className="align-top">{effective ? `${effective.detail_level} · tools ${effective.tool_detail} · project ${effective.project_attribution} · resources ${effective.resource_attribution} (${effective.resources_configured}) · readers ${effective.readers.claude}/${effective.readers.codex}/${effective.readers.cursor} · settings ${effective.config_source}${effective.paused ? ' · paused' : ''}` : '—'}</TableCell>
                          <TableCell className="align-top">{effective ? (i.capabilities.document?.deny.length ? i.capabilities.document.deny.join(', ') : 'none') + (i.capabilities.document?.deny_unrecognized ? ` · ${i.capabilities.document.deny_unrecognized} unrecognized` : '') : '—'}</TableCell>
                          <TableCell className="align-top">{i.schedule.state === 'unknown' ? '—' : `${i.schedule.state}${i.schedule.installed_interval_minutes !== null ? ` · installed ${i.schedule.installed_interval_minutes} min` : ''} · desired ${i.schedule.desired_interval_minutes} min${i.schedule.pending ? ' · pending: run `observatory service install` with this install’s --config-dir' : ''}`}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </Workspace>
  );
}
