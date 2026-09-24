'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Field } from '@/components/kit';
import { when } from '@/components/telemetry-shared';
import { fetchPrivateJson } from '@/lib/fetch-private-json';
import { registryOutcome, registryPayload, type RegistryEdit, type RegistryKind } from '@/lib/registry-ui';

/** One registry read, polled like the other private views. */
export function useRegistry<T>(url: string, unavailable: string) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    try { setData(await fetchPrivateJson<T>(url, current.signal)); setError(''); }
    catch { if (!current.signal.aborted) setError(unavailable); }
  }, [url, unavailable]);
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 60_000); return () => { clearInterval(timer); controller.current?.abort(); }; }, [refresh]);
  return { data, error, refresh };
}

export type RegistryEntry = { id: string; label: string; identities: number; detail?: ReactNode };
export type RegistryIdentity = {
  id: string;
  /** The evidence key: a hash or a resource key, never a path. */
  key: string;
  /** Where the identity was seen: a machine label or an account and provider. */
  where: string;
  basis?: string;
  mapped_id: string | null;
  mapped_label: string | null;
  first_seen: string | null;
  last_seen: string | null;
  note?: string;
};

/**
 * Naming and mapping for one registry: create and rename entries, map or unmap the identities the
 * collectors reported. Every edit appends a revision on the server; nothing here deletes evidence.
 */
export function Registry({ kind, url, nouns, entries, identities, refresh, empty, keyHeading, whereHeading }: {
  kind: RegistryKind; url: string; nouns: { singular: string; plural: string };
  entries: RegistryEntry[]; identities: RegistryIdentity[]; refresh: () => Promise<void>;
  empty: ReactNode; keyHeading: string; whereHeading: string;
}) {
  const [label, setLabel] = useState(''), [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [target, setTarget] = useState('');
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false), [busy, setBusy] = useState(false);
  const targetEntry = entries.find(entry => entry.id === target) ?? entries[0];
  const chosen = new Set(selected.filter(id => identities.some(identity => identity.id === id)));

  async function submit(edit: RegistryEdit) {
    setBusy(true); setFailed(false); setMessage('');
    try {
      const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registryPayload(kind, edit)) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || 'Save failed');
      setMessage(registryOutcome(kind, edit, edit.action === 'map' ? targetEntry?.label : null));
      if (edit.action === 'create') setLabel('');
      if (edit.action === 'rename') setRenaming(null);
      if ('identity_ids' in edit) setSelected([]);
      await refresh();
    } catch (e) { setFailed(true); setMessage(e instanceof Error ? e.message : 'Save failed'); }
    finally { setBusy(false); }
  }

  const toggle = (id: string, on: boolean) => setSelected(current => on ? [...new Set([...current, id])] : current.filter(item => item !== id));

  return (
    <div className="grid gap-4">
      {message && (
        <Alert variant={failed ? 'destructive' : 'success'} role="status">
          <AlertTitle>{failed ? `${nouns.singular[0].toUpperCase()}${nouns.singular.slice(1)} problem` : 'Saved'}</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">{nouns.plural[0].toUpperCase()}{nouns.plural.slice(1)}</CardTitle>
          <CardDescription>Labels live only here; the Observatory never learns a folder, a path, or an account credential from a name.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); if (label.trim()) void submit({ action: 'create', label }); }}>
            <Field htmlFor={`${kind}-label`} label={`New ${nouns.singular}`} help="Up to 80 characters; shown wherever this identity appears.">
              <Input maxLength={80} value={label} onChange={event => setLabel(event.target.value)} className="w-64" />
            </Field>
            <Button type="submit" size="sm" disabled={busy || !label.trim()}>Create</Button>
          </form>
          {entries.length ? (
            <ul className="grid gap-2">
              {entries.map(entry => (
                <li key={entry.id} className="border-border flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
                  {renaming?.id === entry.id ? (
                    <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (renaming.label.trim()) void submit({ action: 'rename', id: entry.id, label: renaming.label }); }}>
                      <Input aria-label={`New name for ${entry.label}`} maxLength={80} value={renaming.label} onChange={event => setRenaming({ id: entry.id, label: event.target.value })} className="w-56" autoFocus />
                      <Button type="submit" size="xs" disabled={busy || !renaming.label.trim()}>Save</Button>
                      <Button type="button" size="xs" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                    </form>
                  ) : (
                    <>
                      <span className="text-sm font-semibold">{entry.label}</span>
                      <span className="text-muted-foreground font-mono text-[11px]">{entry.identities} {entry.identities === 1 ? 'identity' : 'identities'}{entry.detail ? <> · {entry.detail}</> : null}</span>
                      <Button type="button" size="xs" variant="outline" className="ml-auto" onClick={() => setRenaming({ id: entry.id, label: entry.label })} disabled={busy}>Rename</Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-xs leading-relaxed">No {nouns.plural} yet. Create one, then map the identities below to it.</p>
          )}
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="p-4">
          <CardTitle className="text-base">Identities</CardTitle>
          <CardDescription>What the collectors reported. Select rows and map them to a {nouns.singular}; unmapping returns them to unassigned without touching the evidence.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 p-4">
          {identities.length ? (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1.5">
                  <span className="text-muted-foreground text-xs font-semibold">Map selected to</span>
                  <Select value={targetEntry?.id ?? ''} onValueChange={setTarget} disabled={!entries.length}>
                    <SelectTrigger aria-label={`Target ${nouns.singular}`} className="w-56"><SelectValue placeholder={`Create a ${nouns.singular} first`} /></SelectTrigger>
                    <SelectContent position="popper">{entries.map(entry => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}</SelectContent>
                  </Select>
                </label>
                <Button type="button" size="sm" disabled={busy || !chosen.size || !targetEntry} onClick={() => targetEntry && void submit({ action: 'map', id: targetEntry.id, identity_ids: [...chosen] })}>Map {chosen.size || ''}</Button>
                <Button type="button" size="sm" variant="outline" disabled={busy || !chosen.size} onClick={() => void submit({ action: 'unmap', identity_ids: [...chosen] })}>Unmap {chosen.size || ''}</Button>
                <span className="text-muted-foreground font-mono text-[11px]">{chosen.size} selected</span>
              </div>
              <div className="border-border overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="bg-card w-8"><span className="sr-only">Select</span></TableHead>
                      <TableHead className="bg-card uppercase">{keyHeading}</TableHead>
                      <TableHead className="bg-card uppercase">{whereHeading}</TableHead>
                      <TableHead className="bg-card uppercase">Seen</TableHead>
                      <TableHead className="bg-card uppercase">{nouns.singular}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {identities.map(identity => (
                      <TableRow key={identity.id} className="even:bg-foreground/[0.03] border-b-0">
                        <TableCell className="align-top">
                          <input type="checkbox" className="accent-primary size-4" aria-label={`Select ${identity.key}`} checked={chosen.has(identity.id)} onChange={event => toggle(identity.id, event.target.checked)} />
                        </TableCell>
                        <TableCell className="align-top font-mono text-[11px]">
                          {identity.key}
                          {identity.basis && <Badge variant="outline" className="ml-2">{identity.basis.replaceAll('_', ' ')}</Badge>}
                          {identity.note && <span className="text-muted-foreground block">{identity.note}</span>}
                        </TableCell>
                        <TableCell className="align-top text-xs">{identity.where}</TableCell>
                        <TableCell className="align-top font-mono text-[11px]">{when(identity.first_seen)} → {when(identity.last_seen)}</TableCell>
                        <TableCell className="align-top text-xs">{identity.mapped_label ?? <span className="text-muted-foreground">unassigned</span>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : empty}
        </CardContent>
      </Card>
    </div>
  );
}
