import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import type { RoutingSource } from '../lib/routing-source';
import { parseRoutingEventBatch } from '../lib/routing-event-contract';

const url = process.env.ROUTING_TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const base = (event_id: string, task_id: string, sequence: number) => ({ schema_version: 1, event_id, task_id, attempt_id: null, sequence, event_type: 'task.registered', occurred_at: '2026-09-10T19:30:00Z', payload: { task_type: 'implementation', complexity: 'medium', risk: 'low', workload: 'work', parent_task_id: null, request_hash: 'a'.repeat(64) } });

maybe('routing events are atomic, idempotent, source-scoped, and allow delayed sequence delivery', async () => {
  const { createRoutingStore } = await import('../lib/routing-store');
  const sql = postgres(url!, { prepare: false, ...(process.env.ROUTING_TEST_DATABASE_HOST ? {
    host: process.env.ROUTING_TEST_DATABASE_HOST,
    port: Number(process.env.ROUTING_TEST_DATABASE_PORT),
  } : {}) });
  const store = createRoutingStore(() => sql);
  const account = `routing-${crypto.randomUUID().slice(0, 12)}`;
  const sourceA: RoutingSource = { id: crypto.randomUUID(), account_id: account, provider: 'codex', mode: 'local' };
  const sourceB: RoutingSource = { ...sourceA, id: crypto.randomUUID() };
  const task = crypto.randomUUID();
  try {
    await sql`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${account}, 'codex', 'Routing test')`;
    for (const source of [sourceA, sourceB]) await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash) VALUES (${source.id}, ${account}, 'test', 'local', ${crypto.randomUUID().replaceAll('-', '')})`;
    const delayed = parseRoutingEventBatch({ schema_version: 1, events: [base(crypto.randomUUID(), task, 2)] }, Date.parse('2026-09-10T19:31:00Z'));
    assert.deepEqual(await store.append(sourceA, delayed), { ok: true, schema_version: 1, receipts: [{ event_id: delayed.events[0].event_id, duplicate: false }] });
    assert.deepEqual(await store.append(sourceA, delayed), { ok: true, schema_version: 1, receipts: [{ event_id: delayed.events[0].event_id, duplicate: true }] });
    const rejectedBatch = parseRoutingEventBatch({ schema_version: 1, events: [
      base(crypto.randomUUID(), task, 3),
      { ...base(crypto.randomUUID(), task, 2), payload: { ...base('x', task, 2).payload, complexity: 'high' } },
    ] }, Date.parse('2026-09-10T19:31:00Z'));
    await assert.rejects(store.append(sourceA, rejectedBatch), /different content/);
    assert.equal((await store.eventsForTask(sourceA, task)).length, 1, 'a conflict rolls back the whole batch');
    const other = parseRoutingEventBatch({ schema_version: 1, events: [base(crypto.randomUUID(), task, 1)] }, Date.parse('2026-09-10T19:31:00Z'));
    await store.append(sourceB, other);
    assert.equal((await store.eventsForTask(sourceA, task)).length, 1);
    assert.equal((await store.eventsForTask(sourceB, task)).length, 1);
    assert.equal((await store.eventsForTask({ ...sourceA, account_id: 'another-account' }, task)).length, 0, 'a source cannot read across account scope');
  } finally { await sql.end({ timeout: 1 }); }
});
