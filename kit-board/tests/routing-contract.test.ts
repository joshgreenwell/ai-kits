import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestError } from '../lib/contracts';
import { assertProviderMatchesSource, parseRoutingEventBatch } from '../lib/routing-event-contract';
import { quotaWindowState } from '../lib/routing-quota';
import { requireLocalRoutingSource } from '../lib/routing-source';

const ids = { event: '4c814b2e-3187-4bb0-8ecf-20cd84c4b5c0', task: '5f665f22-338a-4c5a-a69c-855237a7e258', attempt: '8043eb29-244c-4c3f-9ab5-f6db4b5fbb75' };
const registered = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1, event_id: ids.event, task_id: ids.task, attempt_id: null, sequence: 1, event_type: 'task.registered',
  occurred_at: '2026-09-10T19:30:00Z', payload: { task_type: 'implementation', complexity: 'medium', risk: 'low', workload: 'work', parent_task_id: null, request_hash: 'a'.repeat(64) }, ...overrides,
});

test('routing wire events reject prompts and future timestamps', () => {
  assert.throws(() => parseRoutingEventBatch({ schema_version: 1, events: [registered({ prompt: 'never persist this' })] }, Date.parse('2026-09-10T19:31:00Z')), RequestError);
  assert.throws(() => parseRoutingEventBatch({ schema_version: 1, events: [registered({ occurred_at: '2026-09-10T19:37:00Z' })] }, Date.parse('2026-09-10T19:31:00Z')), RequestError);
  assert.throws(() => parseRoutingEventBatch({ schema_version: 1, events: [registered({ sequence: Number.POSITIVE_INFINITY })] }, Date.parse('2026-09-10T19:31:00Z')), RequestError);
  assert.throws(() => parseRoutingEventBatch({ schema_version: 1, events: [registered({ attempt_id: ids.attempt })] }, Date.parse('2026-09-10T19:31:00Z')), /cannot name an attempt/);
  assert.deepEqual(parseRoutingEventBatch({ schema_version: 1, events: [registered()] }, Date.parse('2026-09-10T19:31:00Z')).events[0].payload, registered().payload);
});

test('attempt events bind provider to the authenticated source', () => {
  const event = { ...registered({ event_id: '0b1ff01d-f20f-4b60-87c5-23f3f8b29180', attempt_id: ids.attempt, sequence: 2, event_type: 'attempt.started' }),
    payload: { candidate_id: 'codex-default', provider: 'codex', requested_model: 'gpt-6-astra', requested_effort: 'high', role: 'implementation-engineer', permission: 'workspace-write', configuration_hash: 'b'.repeat(64) } };
  const parsed = parseRoutingEventBatch({ schema_version: 1, events: [event] }, Date.parse('2026-09-10T19:31:00Z')).events[0];
  assert.doesNotThrow(() => assertProviderMatchesSource(parsed, 'codex'));
  assert.throws(() => assertProviderMatchesSource(parsed, 'claude'), RequestError);
});

test('runtime outcomes may report only unknown quality', () => {
  const outcome = registered({ event_id: '70e4093a-3dcb-46f6-b7d9-0ad1fa3af3d2', sequence: 3, event_type: 'outcome.recorded',
    payload: { source: 'runtime', result: 'unknown', evidence_hash: null, human_rework_minutes: null, first_attempt_success: null } });
  assert.doesNotThrow(() => parseRoutingEventBatch({ schema_version: 1, events: [outcome] }, Date.parse('2026-09-10T19:31:00Z')));
  assert.throws(() => parseRoutingEventBatch({ schema_version: 1, events: [{ ...outcome, payload: { ...outcome.payload, result: 'accepted' } }] }, Date.parse('2026-09-10T19:31:00Z')), /Runtime cannot assert a quality outcome/);
  assert.throws(() => parseRoutingEventBatch({ schema_version: 1, events: [{ ...outcome, payload: { ...outcome.payload, source: 'test', result: 'accepted' } }] }, Date.parse('2026-09-10T19:31:00Z')), /require evidence/);
});

test('routing endpoints reject browser telemetry sources', () => {
  assert.throws(() => requireLocalRoutingSource({ id: 'source', account_id: 'account', provider: 'codex', mode: 'browser' }), (error: unknown) => error instanceof RequestError && error.status === 403);
});

const quota = (observed_at: string, used_percent: number, resets_at = '2026-09-11T19:00:00Z') => ({
  id: `${observed_at}-${used_percent}`, source_id: 'source', window_key: 'weekly', label: 'Weekly', observed_at, used_percent, resets_at, window_minutes: 10080, source_last_seen_at: observed_at,
});
test('quota state preserves missing pace, resets, and stale source observations', () => {
  const now = Date.parse('2026-09-10T19:00:00Z');
  assert.equal(quotaWindowState([], now), undefined);
  const fresh = quotaWindowState([quota('2026-09-10T18:00:00Z', 40)], now);
  assert.equal(fresh?.state, 'usable');
  assert.equal(fresh?.pace, null);
  assert.equal(quotaWindowState([quota('2026-09-10T18:00:00Z', 50), quota('2026-09-10T17:00:00Z', 40)], now)?.state, 'usable');
  assert.equal(quotaWindowState([quota('2026-09-10T18:00:00Z', 5, '2026-09-12T19:00:00Z'), quota('2026-09-10T17:00:00Z', 90)], now)?.state, 'discontinuous');
  assert.equal(quotaWindowState([quota('2026-09-10T18:00:00Z', 50), quota('2026-09-10T18:00:00Z', 40)], now)?.state, 'discontinuous');
  assert.equal(quotaWindowState([quota('2026-09-10T15:00:00Z', 40)], now)?.state, 'stale');
  assert.equal(quotaWindowState([{ ...quota('not-a-date', 40) }], now)?.state, 'insufficient');
  assert.equal(quotaWindowState([{ ...quota('2026-09-10T18:00:00Z', Number.NaN) }], now)?.state, 'insufficient');
  assert.equal(quotaWindowState([{ ...quota('2026-09-10T18:00:00Z', 40), window_minutes: 0 }], now)?.state, 'insufficient');
  assert.equal(quotaWindowState([{ ...quota('2026-09-10T18:00:00Z', 40), source_last_seen_at: 'not-a-date' }], now)?.state, 'insufficient');
});
