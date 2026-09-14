import assert from 'node:assert/strict';
import test from 'node:test';
import { usageStatus } from '../lib/usage-status';
import { registryOutcome, registryPayload } from '../lib/registry-ui';

const now = Date.parse('2026-09-14T12:00:00Z');
const source = (minutesAgo: number | null, extra: Partial<{ disabled: boolean; cadence_minutes: number; coverage: { malformed_lines?: number; unavailable_roots?: number } | null }> = {}) => ({
  disabled: false, mode: 'companion', coverage: null, cadence_minutes: 60,
  last_seen_at: minutesAgo === null ? null : new Date(now - minutesAgo * 60_000).toISOString(), ...extra,
});

test('the status line judges contact per collector at its own cadence and never counts disabled ones', () => {
  assert.deepEqual(usageStatus([], now), { state: 'none', collectors: 0, label: 'no collectors connected' });
  assert.deepEqual(usageStatus([source(5, { disabled: true })], now).state, 'none');
  assert.deepEqual(usageStatus([source(30), source(100)], now), { state: 'fresh', collectors: 2, label: 'collectors current' });
  assert.deepEqual(usageStatus([source(30), source(136)], now), { state: 'stale', collectors: 2, label: '1 of 2 collectors quiet' }, 'two cadences plus fifteen minutes');
  assert.deepEqual(usageStatus([source(136), source(null)], now), { state: 'stale', collectors: 2, label: 'no recent collector contact' });
  assert.equal(usageStatus([source(50, { cadence_minutes: 15 })], now).state, 'stale', 'a fifteen-minute collector is quiet after forty-five');
  assert.equal(usageStatus([source(5, { coverage: { unavailable_roots: 1 } })], now).state, 'partial', 'unreadable logs outrank freshness');
});

test('registry payloads name the id field per kind and dedupe identities', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(registryPayload('project', { action: 'create', label: '  Kit board ' }), { action: 'create', label: 'Kit board' });
  assert.deepEqual(registryPayload('project', { action: 'rename', id: a, label: 'Board' }), { action: 'rename', project_id: a, label: 'Board' });
  assert.deepEqual(registryPayload('source', { action: 'map', id: a, identity_ids: [a, a] }), { action: 'map', source_id: a, identity_ids: [a] });
  assert.deepEqual(registryPayload('source', { action: 'unmap', identity_ids: [a] }), { action: 'unmap', identity_ids: [a] });
  assert.equal(registryOutcome('source', { action: 'map', id: a, identity_ids: [a] }, 'Vault'), 'Mapped 1 identity to “Vault”.');
  assert.equal(registryOutcome('project', { action: 'unmap', identity_ids: [a, '22222222-2222-4222-8222-222222222222'] }), 'Unmapped 2 identities; their requests resolve as unassigned again.');
});
