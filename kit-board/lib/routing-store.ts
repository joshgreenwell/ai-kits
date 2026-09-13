import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { RequestError, stableJson } from './contracts';
import { assertProviderMatchesSource, type RoutingEvent, type RoutingEventBatch } from './routing-event-contract';
import { quotaWindowState, type QuotaRow, type QuotaWindowState } from './routing-quota';
import { requireLocalRoutingSource, type RoutingSource } from './routing-source';

export type { RoutingSource } from './routing-source';
export type { QuotaWindowState } from './routing-quota';
type Sql = ReturnType<typeof postgres>;
type DatabaseProvider = () => Sql;
const hash = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

/** Injectable database provider keeps route behavior separately testable from Postgres. */
export function createRoutingStore(getDatabase?: DatabaseProvider) {
  // Tests provide an isolated client. Routes load the server-only connector only
  // when a database operation actually runs, keeping the ledger functions
  // independently executable without a Next server module.
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();
  async function append(source: RoutingSource, input: RoutingEventBatch) {
    requireLocalRoutingSource(source);
    const unique = new Map<string, { event: RoutingEvent; content_hash: string }>();
    for (const event of input.events) {
      assertProviderMatchesSource(event, source.provider);
      const content_hash = hash(event);
      const eventKey = `event:${event.event_id}`;
      const sequenceKey = `sequence:${event.task_id}:${event.sequence}`;
      for (const key of [eventKey, sequenceKey]) {
        const present = unique.get(key);
        if (present && present.content_hash !== content_hash) throw new RequestError('A source event ID or task sequence names different content', 409);
        unique.set(key, { event, content_hash });
      }
    }
    const rows = [...unique.entries()].filter(([key]) => key.startsWith('event:')).map(([, value]) => value);
    const db = await sql();
    return db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      const acceptedEventIds = new Set<string>();
      const inserts: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const event = row.event;
        const existing = await tx`SELECT event_id, task_id, sequence, content_hash FROM personal_hub.agent_routing_events
          WHERE source_id = ${source.id} AND (event_id = ${event.event_id} OR (task_id = ${event.task_id} AND sequence = ${event.sequence}))`;
        if (existing.length) {
          if (existing.some(value => value.content_hash !== row.content_hash)) throw new RequestError('A source event ID or task sequence names different content', 409);
          continue;
        }
        inserts.push({ id: randomUUID(), source_id: source.id, account_id: source.account_id, provider: source.provider,
          event_id: event.event_id, task_id: event.task_id, attempt_id: event.attempt_id, sequence: event.sequence,
          event_type: event.event_type, occurred_at: event.occurred_at, payload: tx.json(event.payload as postgres.JSONValue), content_hash: row.content_hash });
      }
      if (inserts.length) {
        const inserted = await tx`INSERT INTO personal_hub.agent_routing_events ${tx(inserts)} ON CONFLICT DO NOTHING RETURNING event_id`;
        for (const row of inserted) acceptedEventIds.add(row.event_id as string);
        if (inserted.length !== inserts.length) {
          // A racing replay is safe only when every claimed unique key has the same stable hash.
          for (const row of rows) {
            const event = row.event;
            const existing = await tx`SELECT content_hash FROM personal_hub.agent_routing_events
              WHERE source_id = ${source.id} AND (event_id = ${event.event_id} OR (task_id = ${event.task_id} AND sequence = ${event.sequence}))`;
            if (!existing.length || existing.some(value => value.content_hash !== row.content_hash)) throw new RequestError('A source event ID or task sequence names different content', 409);
          }
        }
      }
      const seenInBatch = new Set<string>();
      const receipts = input.events.map(event => {
        const first = !seenInBatch.has(event.event_id); seenInBatch.add(event.event_id);
        return { event_id: event.event_id, duplicate: !first || !acceptedEventIds.has(event.event_id) };
      });
      return { ok: true, schema_version: 1, receipts };
    });
  }

  async function eventsForTask(source: RoutingSource, taskId: string) {
    requireLocalRoutingSource(source);
    const db = await sql();
    const rows = await db`SELECT event_id, task_id, attempt_id, sequence, event_type, occurred_at, payload
      FROM personal_hub.agent_routing_events WHERE source_id = ${source.id} AND account_id = ${source.account_id} AND task_id = ${taskId}
      ORDER BY sequence, received_at, id LIMIT 500`;
    return rows.map(row => ({ schema_version: 1, event_id: row.event_id, task_id: row.task_id, attempt_id: row.attempt_id,
      sequence: Number(row.sequence), event_type: row.event_type, occurred_at: row.occurred_at, payload: row.payload })) as RoutingEvent[];
  }

  async function quotaState(source: RoutingSource, now = Date.now()) {
    requireLocalRoutingSource(source);
    const db = await sql();
    const rows = JSON.parse(JSON.stringify(await db`WITH ranked AS (
      SELECT q.id, q.source_id, q.window_key, q.label, q.observed_at, q.used_percent, q.resets_at, q.window_minutes,
        s.last_seen_at AS source_last_seen_at,
        row_number() OVER (PARTITION BY q.window_key ORDER BY q.observed_at DESC, q.received_at DESC) AS sample_rank
      FROM personal_hub.allowance_percent_view q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id
      WHERE q.account_id = ${source.account_id}
    ) SELECT id, source_id, window_key, label, observed_at, used_percent, resets_at, window_minutes, source_last_seen_at
      FROM ranked WHERE sample_rank <= 2 ORDER BY window_key, observed_at DESC`)) as QuotaRow[];
    const grouped = new Map<string, QuotaRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.window_key) ?? [];
      group.push(row);
      grouped.set(row.window_key, group);
    }
    const windows = Object.fromEntries([...grouped].map(([key, samples]) => [key, quotaWindowState(samples, now)]));
    return { schema_version: 1, account_id: source.account_id, provider: source.provider, as_of: new Date(now).toISOString(), windows };
  }
  return { append, eventsForTask, quotaState };
}

export const routingStore = createRoutingStore();
