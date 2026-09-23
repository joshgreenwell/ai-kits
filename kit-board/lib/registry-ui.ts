/**
 * The naming registry client shape (knowledge sources). Projects used to share it; they now come from
 * the apps and Settings > Projects is read-only. Payloads are built here so the page cannot drift from
 * the schema.
 */
export type RegistryKind = 'source';

export type RegistryEdit =
  | { action: 'create'; label: string }
  | { action: 'rename'; id: string; label: string }
  | { action: 'map'; id: string; identity_ids: string[] }
  | { action: 'unmap'; identity_ids: string[] };

export function registryPayload(kind: RegistryKind, edit: RegistryEdit): Record<string, unknown> {
  const idField = `${kind}_id`;
  switch (edit.action) {
    case 'create': return { action: 'create', label: edit.label.trim() };
    case 'rename': return { action: 'rename', [idField]: edit.id, label: edit.label.trim() };
    case 'map': return { action: 'map', [idField]: edit.id, identity_ids: [...new Set(edit.identity_ids)] };
    case 'unmap': return { action: 'unmap', identity_ids: [...new Set(edit.identity_ids)] };
  }
}

/** What a saved edit reads like in the status line. */
export function registryOutcome(kind: RegistryKind, edit: RegistryEdit, label?: string | null): string {
  const noun = kind === 'source' ? 'knowledge source' : 'entry';
  const count = 'identity_ids' in edit ? new Set(edit.identity_ids).size : 0;
  const identities = `${count} ${count === 1 ? 'identity' : 'identities'}`;
  switch (edit.action) {
    case 'create': return `Created the ${noun} “${edit.label.trim()}”.`;
    case 'rename': return `Renamed the ${noun} to “${edit.label.trim()}”.`;
    case 'map': return `Mapped ${identities} to “${label ?? edit.id}”.`;
    case 'unmap': return `Unmapped ${identities}; their requests resolve as unassigned again.`;
  }
}
