import type postgres from 'postgres';
import { appProjectId } from './usage-app-projects';
import type { NameLabel, ProjectCatalog, ProjectMembership, SideRecord, SideRecordType } from './usage-contract';

/**
 * Applying side records (`name.label`, `project.catalog`, `project.membership`) inside the ingest
 * transaction, after the ledger inserts (spec section 5).
 *
 * THE RULE: a side record can never cost the envelope. Names and app projects are display data; the
 * ledger records beside them are the facts. So every statement here runs inside a savepoint, each table
 * in its own, and a table whose batch fails is retried row by row, each row in its own savepoint. A row
 * that still fails is recorded in usage_side_record_deferrals and its record ids are returned as
 * deferred, never rejected: the companion keeps them and its resync retries them. The caller wraps the
 * whole call in one more savepoint and a try/catch, so not even a bug here can abort the transaction.
 *
 * Rows are deduplicated on each target table's conflict key before any SQL runs, keeping the newest
 * `observed_at` and, on a tie, the lexicographically smallest label or name, so the outcome does not
 * depend on the order records arrived in. Two catalog names that differ only in case or trimming
 * derive one usage_projects id and merge here, which is what keeps a multi-row INSERT from hitting
 * SQLSTATE 21000 ("cannot affect row a second time"). Rows are written sorted by primary key so two
 * machines' ingests take row locks in the same order.
 *
 * Every upsert moves a row only forward: `WHERE EXCLUDED.observed_at >= t.observed_at` and only when the
 * row would actually change, so a replay or a weekly resync of unchanged records writes nothing.
 */
/** A transaction handle that can open a savepoint. postgres.js types TransactionSql without its call signature. */
export type Tx = ReturnType<typeof postgres> & { savepoint<T>(fn: (sp: Tx) => T | Promise<T>): Promise<T> };
type Row = Record<string, unknown>;
type Group = { row: Row; winner: SideRecord; records: SideRecord[]; type: SideRecordType; target: string };
export type SideTally = (type: string, outcome: string, n: number) => void;
export type SideOutcome = { deferred: string[]; changed: boolean };

const newer = (a: string, b: string) => Date.parse(a) - Date.parse(b);
/** Newest observation wins; a tie goes to the smaller text so the choice is deterministic. */
function collect<R extends SideRecord>(groups: Map<string, Group>, key: string, record: R, type: SideRecordType, target: string,
  row: () => Row, text: (record: R) => string) {
  const existing = groups.get(key);
  if (!existing) { groups.set(key, { row: row(), winner: record, records: [record], type, target }); return; }
  existing.records.push(record);
  const order = newer(record.observed_at, existing.winner.observed_at);
  if (order > 0 || (order === 0 && text(record) < text(existing.winner as R))) { existing.row = row(); existing.winner = record; }
}

const byKey = (groups: Map<string, Group>) => [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, group]) => group);
const reasonOf = (error: unknown) => {
  const code = (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (`${code ? `${code}: ` : ''}${message}`.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'unknown error').slice(0, 200);
};

export async function applySideRecords(tx: Tx, installId: string, records: SideRecord[], tally: SideTally): Promise<SideOutcome> {
  const deferred = new Set<string>();
  let changed = false;
  const projects = new Map<string, Group>(), appProjects = new Map<string, Group>(), memberships = new Map<string, Group>(), labels = new Map<string, Group>();

  for (const record of records) {
    if (record.record_type === 'project.catalog') {
      const catalog = record as ProjectCatalog;
      const projectId = appProjectId(catalog.name);
      collect(projects, projectId, catalog, 'project.catalog', catalog.project_key, () => ({ id: projectId, label: catalog.name }), r => r.name);
      collect(appProjects, catalog.project_key, catalog, 'project.catalog', catalog.project_key, () => ({
        install_id: installId, project_key: catalog.project_key, app: catalog.app, name: catalog.name, position: catalog.position,
        state: catalog.state, project_id: projectId, observed_at: catalog.observed_at,
      }), r => r.name);
    } else if (record.record_type === 'project.membership') {
      const membership = record as ProjectMembership;
      const key = `${membership.member_kind}:${membership.member_key}`;
      collect(memberships, key, membership, 'project.membership', key, () => ({
        install_id: installId, member_kind: membership.member_kind, member_key: membership.member_key,
        project_key: membership.project_key, resolution: membership.resolution, observed_at: membership.observed_at,
      }), r => `${r.resolution}:${r.project_key ?? ''}`);
    } else {
      const label = record as NameLabel;
      const key = `${label.kind}:${label.key}`;
      collect(labels, key, label, 'name.label', key, () => ({
        install_id: installId, kind: label.kind, key: label.key, label: label.label, role: label.role,
        parent_key: label.parent_key, observed_at: label.observed_at,
      }), r => r.label);
    }
  }

  const defer = async (group: Group, error: unknown) => {
    for (const record of group.records) deferred.add(record.record_id);
    try {
      await tx.savepoint(sp => sp`INSERT INTO personal_hub.usage_side_record_deferrals AS d (install_id, record_type, target_key, reason)
        VALUES (${installId}, ${group.type}, ${group.target.slice(0, 200)}, ${reasonOf(error)})
        ON CONFLICT (install_id, record_type, target_key) DO UPDATE SET
          reason = EXCLUDED.reason, occurrences = d.occurrences + 1, last_at = now()`);
    } catch (deferralError) {
      console.warn('Side record deferral could not be stored', { reason: reasonOf(deferralError) });
    }
  };

  /**
   * One table: the whole batch in one savepoint, then row by row if it fails. `write` returns the
   * conflict keys of the rows it inserted or changed, which decide accepted versus duplicate.
   */
  const apply = async (groups: Map<string, Group>, keyOf: (row: Row) => string, write: (sp: Tx, rows: Row[]) => Promise<Row[]>, counted: boolean) => {
    const ordered = byKey(groups);
    if (!ordered.length) return new Set<string>();
    const written = new Set<string>(), failed = new Set<Group>();
    try {
      for (const row of await tx.savepoint(sp => write(sp, ordered.map(group => group.row)))) written.add(keyOf(row));
    } catch {
      for (const group of ordered) {
        try {
          for (const row of await tx.savepoint(sp => write(sp, [group.row]))) written.add(keyOf(row));
        } catch (error) {
          failed.add(group);
          await defer(group, error);
        }
      }
    }
    if (written.size) changed = true;
    if (counted) {
      for (const group of ordered) {
        if (failed.has(group)) { tally(group.type, 'deferred', group.records.length); continue; }
        const winnerWritten = written.has(keyOf(group.row));
        tally(group.type, winnerWritten ? 'accepted' : 'duplicate', 1);
        tally(group.type, 'duplicate', group.records.length - 1);
      }
    }
    return new Set([...failed].map(group => keyOf(group.row)));
  };

  // 1. usage_projects: insert-only. The display label is derived in the read, so it is never contested.
  //    A catalog whose project row failed is deferred there, and its app-project row then fails its FK.
  await apply(projects, row => String(row.id),
    (sp, rows) => sp`INSERT INTO personal_hub.usage_projects ${sp(rows, 'id', 'label')} ON CONFLICT (id) DO NOTHING RETURNING id`, false);
  // 2. usage_app_projects
  await apply(appProjects, row => String(row.project_key),
    (sp, rows) => sp`INSERT INTO personal_hub.usage_app_projects
        ${sp(rows, 'install_id', 'project_key', 'app', 'name', 'position', 'state', 'project_id', 'observed_at')}
      ON CONFLICT (install_id, project_key) DO UPDATE SET
        app = EXCLUDED.app, name = EXCLUDED.name, position = EXCLUDED.position, state = EXCLUDED.state,
        project_id = EXCLUDED.project_id, observed_at = EXCLUDED.observed_at, updated_at = now()
      WHERE EXCLUDED.observed_at >= usage_app_projects.observed_at
        AND (usage_app_projects.app, usage_app_projects.name, usage_app_projects.position, usage_app_projects.state, usage_app_projects.project_id, usage_app_projects.observed_at)
          IS DISTINCT FROM (EXCLUDED.app, EXCLUDED.name, EXCLUDED.position, EXCLUDED.state, EXCLUDED.project_id, EXCLUDED.observed_at)
      RETURNING project_key`, true);
  // 3. usage_project_memberships
  await apply(memberships, row => `${row.member_kind}:${row.member_key}`,
    (sp, rows) => sp`INSERT INTO personal_hub.usage_project_memberships
        ${sp(rows, 'install_id', 'member_kind', 'member_key', 'project_key', 'resolution', 'observed_at')}
      ON CONFLICT (install_id, member_kind, member_key) DO UPDATE SET
        project_key = EXCLUDED.project_key, resolution = EXCLUDED.resolution, observed_at = EXCLUDED.observed_at, updated_at = now()
      WHERE EXCLUDED.observed_at >= usage_project_memberships.observed_at
        AND (usage_project_memberships.project_key, usage_project_memberships.resolution, usage_project_memberships.observed_at) IS DISTINCT FROM (EXCLUDED.project_key, EXCLUDED.resolution, EXCLUDED.observed_at)
      RETURNING member_kind, member_key`, true);
  // 4. usage_name_labels
  await apply(labels, row => `${row.kind}:${row.key}`,
    (sp, rows) => sp`INSERT INTO personal_hub.usage_name_labels
        ${sp(rows, 'install_id', 'kind', 'key', 'label', 'role', 'parent_key', 'observed_at')}
      ON CONFLICT (install_id, kind, key) DO UPDATE SET
        label = EXCLUDED.label, role = EXCLUDED.role, parent_key = EXCLUDED.parent_key, observed_at = EXCLUDED.observed_at, updated_at = now()
      WHERE EXCLUDED.observed_at >= usage_name_labels.observed_at
        AND (usage_name_labels.label, usage_name_labels.role, usage_name_labels.parent_key, usage_name_labels.observed_at) IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.role, EXCLUDED.parent_key, EXCLUDED.observed_at)
      RETURNING kind, key`, true);
  // 5. The install has reported project data: its requests without a membership are Unknown from now on,
  //    not "companion update needed".
  if (projects.size || memberships.size) {
    try {
      await tx.savepoint(sp => sp`INSERT INTO personal_hub.usage_project_reports AS r (install_id) VALUES (${installId})
        ON CONFLICT (install_id) DO UPDATE SET last_reported_at = now()`);
    } catch (error) {
      console.warn('Project report marker could not be stored', { reason: reasonOf(error) });
    }
  }
  return { deferred: [...deferred], changed };
}
