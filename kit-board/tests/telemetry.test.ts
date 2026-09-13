import test from 'node:test';
import assert from 'node:assert/strict';
import { isSparkWindow, quotaPace, tokenPace, telemetrySchema, connectionSchema } from '../lib/telemetry-contract';
import { calendarDays, matchesResetType, resetDay, resetEntryKey, resetMarker, shiftMonth } from '../lib/reset-calendar';
import type { ResetItem } from '../lib/reset-feeds';
import { normalizeFeed } from '../lib/reset-feeds';
import { resetFeedFailure, resetFeedFailureLabel } from '../lib/reset-feed-errors';
import { normalizeQuota } from '../browser/claude-quota/normalize.js';
const now = Date.parse('2026-09-09T18:00:00Z');
const q = (at: string, used: number, reset = '2026-09-10T18:00:00Z') => ({ window_key: 'weekly', label: 'Weekly', observed_at: at, used_percent: used, resets_at: reset, window_minutes: 10080 });
test('quota projection is anchored to observations and requires sufficient samples', () => {
  assert.equal(quotaPace([q('2026-09-09T18:00:00Z', 60)], now)?.pointsPerHour, null);
  const result = quotaPace([q('2026-09-09T16:00:00Z', 50), q('2026-09-09T18:00:00Z', 60)], now)!;
  assert.equal(result.pointsPerHour, 5); assert.equal(result.lastsUntilReset, false);
  assert.equal(result.exhaustionAt, '2026-09-10T02:00:00.000Z');
  assert.equal(result.sustainablePointsPerDay, 40);
  assert.equal(result.projectedUsedPercent, 180);
  const later = quotaPace([q('2026-09-09T16:00:00Z', 50), q('2026-09-09T18:00:00Z', 60)], now + 3_600_000)!;
  assert.equal(later.projectedUsedPercent, result.projectedUsedPercent);
  assert.equal(later.sustainablePointsPerDay, result.sustainablePointsPerDay);
});
test('allowance outlook handles idle, exact capacity, missing and expired readings', () => {
  assert.equal(quotaPace([], now), null);
  assert.equal(quotaPace([q('2026-09-09T18:00:00Z', 60)], now)?.projectedUsedPercent, null);
  const idle = quotaPace([q('2026-09-09T16:00:00Z', 60), q('2026-09-09T18:00:00Z', 60)], now)!;
  assert.equal(idle.projectedUsedPercent, 60);
  assert.equal(idle.lastsUntilReset, true);
  const exact = quotaPace([q('2026-09-09T16:00:00Z', 48), q('2026-09-09T18:00:00Z', 52)], now)!;
  assert.equal(exact.projectedUsedPercent, 100);
  assert.equal(exact.lastsUntilReset, true);
  assert.equal(quotaPace([q('2026-09-09T18:00:00Z', 60)], now + 121 * 60_000)?.projectedUsedPercent, null);
  assert.equal(quotaPace(idle.history, Date.parse(idle.resets_at))?.projectedUsedPercent, null);
});
test('Spark visibility recognizes provider keys and human labels', () => {
  assert.equal(isSparkWindow({ window_key: 'codex_spark:weekly', label: 'Weekly' }), true);
  assert.equal(isSparkWindow({ window_key: 'secondary', label: 'Codex Spark weekly' }), true);
  assert.equal(isSparkWindow({ window_key: 'codex:weekly', label: 'Weekly' }), false);
});
test('calendar aligns Monday weeks, leap days and year changes in UTC', () => {
  const september = calendarDays('2026-09');
  assert.equal(september[0], null); assert.equal(september[1], '2026-09-01');
  assert.equal(september.filter(Boolean).length, 30);
  assert.equal(september.length % 7, 0);
  assert.equal(calendarDays('2024-02').filter(Boolean).length, 29);
  assert.equal(calendarDays('2026-08').length, 42);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});
test('calendar dates distinguish effective reset time from announcement publication', () => {
  const item: ResetItem = { id: 'test', provider: 'codex', category: 'history', at: '2026-09-08T23:00:00-05:00', effective_at: '2026-09-10T01:00:00Z', url: 'https://example.com', title: 'Reset', status: 'reported', confidence: null, scope: null };
  assert.equal(resetDay(item), '2026-09-10');
  assert.equal(resetDay({ ...item, effective_at: null }), '2026-09-09');
  assert.equal(resetDay({ ...item, category: 'announcement' }), '2026-09-09');
  assert.equal(resetDay({ ...item, category: 'forecast' }), '2026-09-09');
});
test('quota decreases, anchor changes, stale readings and collection gaps do not fabricate burn', () => {
  assert.equal(quotaPace([q('2026-09-09T16:00:00Z', 50), q('2026-09-09T18:00:00Z', 10)], now)?.pointsPerHour, null);
  assert.equal(quotaPace([q('2026-09-09T16:00:00Z', 50), q('2026-09-09T18:00:00Z', 60, '2026-09-11T18:00:00Z')], now)?.pointsPerHour, null);
  assert.equal(quotaPace([q('2026-09-09T10:00:00Z', 50), q('2026-09-09T14:00:00Z', 60)], now)?.pointsPerHour, null);
  assert.equal(quotaPace([q('2026-09-09T13:00:00Z', 50), q('2026-09-09T18:00:00Z', 60)], now)?.pointsPerHour, null);
});
test('token velocity excludes partial current hour and includes idle hours', () => {
  const p = tokenPace([{ hour: '2026-09-09T17:00:00Z', total_tokens: 600 }, { hour: '2026-09-09T18:00:00Z', total_tokens: 9000 }], now + 1000);
  assert.equal(p.tokensPerHour, 100); assert.equal(p.tokensLast24Hours, 600);
});
test('ingest rejects hidden payload fields and invalid accounting', () => {
  const base = { schema_version: 1, observed_at: '2026-09-01T00:00:00Z', coverage: { collector_version: 'test' }, buckets: [], quotas: [] };
  assert.equal(telemetrySchema.safeParse(base).success, true);
  assert.equal(telemetrySchema.safeParse({ ...base, prompt: 'must not persist' }).success, false);
  const bucket = { session_hash: 'a'.repeat(64), hour: '2026-09-01T00:00:00Z', model: 'model', input_tokens: 1, cached_tokens: 2, cache_write_tokens: 3, output_tokens: 4, total_tokens: 11, calls: 1 };
  assert.equal(telemetrySchema.safeParse({ ...base, buckets: [bucket] }).success, false);
  assert.equal(connectionSchema.safeParse({ account_id: 'test', provider: 'codex', account_label: 'test', machine_label: 'test', mode: 'browser' }).success, false);
});
test('feeds retain classifications, reject unsafe links and exclude unrelated posts', () => {
  const feed = normalizeFeed('claude-radar', { items: [
    { id: '1', date_published: '2026-09-01', title: 'Upcoming reset', tags: ['counter-reset', 'upcoming'], url: 'https://example.com/1' },
    { id: '2', date_published: '2026-09-01', title: 'New model', url: 'https://example.com/2' },
    { id: '3', date_published: '2026-09-01', title: 'Bad reset link', url: 'javascript:alert(1)' },
  ] });
  assert.equal(feed.items.length, 1); assert.equal(feed.items[0].category, 'announcement'); assert.equal(feed.items[0].status, 'announced');
  assert.throws(() => normalizeFeed('claude-radar', { unexpected: [] }));
});
test('reset feed failures retain safe, actionable diagnostics', () => {
  assert.equal(resetFeedFailure(new Error('http_403')), 'http_403');
  assert.equal(resetFeedFailure(new DOMException('timed out', 'TimeoutError')), 'timeout');
  assert.equal(resetFeedFailure(new TypeError('fetch failed')), 'network_error');
  assert.equal(resetFeedFailure(new SyntaxError('private parser detail')), 'invalid_json');
  assert.equal(resetFeedFailure(new Error('Forecast schema changed')), 'schema_changed');
  assert.equal(resetFeedFailure(new Error('unexpected_content_type')), 'unexpected_content_type');
  assert.equal(resetFeedFailureLabel('v4:http_403'), 'source returned HTTP 403');
  assert.equal(resetFeedFailureLabel('v4:network_error'), 'source connection failed');
});
test('external projections preserve misses', () => {
  const radar = normalizeFeed('claude-radar', { items: [{ id: '1', title: 'Reset projection', content_text: 'Graded a miss on August 17.', tags: ['counter-reset', 'projected'], date_published: '2026-08-02', url: 'https://www.resetradar.com/#1' }] });
  assert.equal(radar.items[0].status, 'missed projection');
});
test('Claude counter events are allowance-window flushes, not global resets', () => {
  const radar = normalizeFeed('claude-radar', { items: [{
    id: 'flush', title: 'Unannounced flush of 5-hour limits', content_text: 'Reported by users.',
    tags: ['counter-reset', 'historic', 'global'], date_published: '2026-09-04T20:00:00Z', url: 'https://www.resetradar.com/#flush',
  }] });
  const flush = radar.items[0];
  assert.equal(flush.reset_kind, 'window_flush');
  assert.equal(flush.scope, 'broadly reported window flush');
  assert.equal(resetMarker(flush), 'window_flush');
  assert.equal(matchesResetType(flush, 'window_flush'), true);
  assert.equal(matchesResetType(flush, 'global'), false);
});
test('browser adapter exports only numeric quota windows, not account or conversation data', () => {
  const rows = normalizeQuota({ five_hour: { utilization: 23, resets_at: '2026-09-09T20:00:00Z' }, seven_day_sonnet: { utilization: 60, resets_at: '2026-09-12T00:00:00Z' }, account: { email: 'private' }, extra_usage: { monthly_limit: 100 } }, '2026-09-09T18:00:00Z');
  assert.equal(rows.length, 2); assert.ok(rows[1]); assert.equal(rows[1].label, 'Weekly · sonnet');
  assert.ok(!JSON.stringify(rows).includes('private'));
  assert.throws(() => normalizeQuota({ five_hour: { utilization: 101, resets_at: '2026-09-09T20:00:00Z' } }, '2026-09-09T18:00:00Z'));
});


test('saved banked lifecycle, global scope and announcements retain independent markers', () => {
  // Synthetic normalized records also cover historical snapshots from retired sources.
  const banked: ResetItem = { id: 'bank', provider: 'codex', title: 'Banked credit update', reset_kind: 'banked',
    banked_state: 'arriving', scope: 'global', at: '2026-09-05T00:00:00Z', url: 'https://example.com/bank',
    verification_status: 'pending', status: 'arriving', category: 'announcement', confidence: null, effective_at: null };
  assert.equal(resetMarker(banked), 'banked');
  assert.ok(matchesResetType(banked, 'banked')); assert.ok(matchesResetType(banked, 'announcement'));
  assert.equal(matchesResetType(banked, 'global'), false);
  const global: ResetItem = { ...banked, id: 'reset', reset_kind: 'global', banked_state: null, category: 'history' };
  assert.equal(resetMarker(global), 'global');
  const announced: ResetItem = { ...global, category: 'announcement' };
  assert.equal(resetMarker(announced), 'announcement');
  assert.ok(matchesResetType(announced, 'global'));
  assert.notEqual(resetEntryKey(global), resetEntryKey(announced));
  for (const kind of ['watch', 'signal'] as const) {
    const signal = { ...banked, reset_kind: kind };
    assert.equal(resetMarker(signal), 'signal'); assert.ok(matchesResetType(signal, 'signal'));
  }
  assert.equal(resetMarker({ ...banked, reset_kind: 'credits' }), 'credits');
});
