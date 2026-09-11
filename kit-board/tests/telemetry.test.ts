import test from 'node:test';
import assert from 'node:assert/strict';
import { isSparkWindow, quotaPace, tokenPace, telemetrySchema, connectionSchema } from '../lib/telemetry-contract';
import { calendarDays, matchesResetType, resetDay, resetEntryKey, resetMarker, shiftMonth } from '../lib/reset-calendar';
import type { ResetItem } from '../lib/reset-feeds';
import { normalizeFeed } from '../lib/reset-feeds';
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
  const feed = normalizeFeed('codex-announcements', { tweets: [
    { id: '1', at: '2026-09-01', text: 'Potential reset', kind: 'signal', url: 'https://x.com/test/status/1' },
    { id: '2', at: '2026-09-01', text: 'New model', kind: 'codex', url: 'https://x.com/test/status/2' },
    { id: '3', at: '2026-09-01', text: 'Bad link', kind: 'reset', url: 'javascript:alert(1)' },
  ] });
  assert.equal(feed.items.length, 1); assert.equal(feed.items[0].category, 'announcement'); assert.equal(feed.items[0].status, 'signal');
  assert.throws(() => normalizeFeed('codex-timeline', { unexpected: [] }));
});
test('external probability is not an official promise and projections preserve misses', () => {
  const doc = normalizeFeed('codex-forecast', { updated_at: '2026-09-09', probabilities: { rounded_24h: 25, rounded_48h: 45 }, confidence: 'low', confidence_note: 'Experimental', official_signal: null });
  assert.equal(doc.forecast?.probability24, 25); assert.equal(doc.forecast?.official, null);
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


test('banked lifecycle, global scope and announcements remain independent classifications', () => {
  const base = { id: 'bank', summary: 'Banked credit update', type: 'credits', reset_kind: 'banked', banked_state: 'arriving', scope: 'global', date: '2026-09-05', url: 'https://x.com/test/status/bank', reset_verification_status: 'pending' };
  const banked = normalizeFeed('codex-timeline', { events: [base] }).items[0];
  assert.equal(banked.reset_kind, 'banked'); assert.equal(banked.banked_state, 'arriving');
  assert.equal(banked.status, 'arriving'); assert.equal(banked.verification_status, 'pending');
  assert.equal(banked.category, 'announcement'); assert.equal(resetMarker(banked), 'banked');
  assert.ok(matchesResetType(banked, 'banked')); assert.ok(matchesResetType(banked, 'announcement'));
  assert.equal(matchesResetType(banked, 'global'), false);
  const global = normalizeFeed('codex-timeline', { events: [{ ...base, id: 'reset', type: 'reset', reset_kind: 'hard', banked_state: null }] }).items[0];
  assert.equal(global.reset_kind, 'global'); assert.equal(resetMarker(global), 'global');
  const preview = normalizeFeed('codex-timeline', { events: [{ ...base, type: 'reset', reset_kind: 'hard', banked_state: null, preview: true }] }).items[0];
  assert.equal(preview.category, 'announcement'); assert.equal(resetMarker(preview), 'announcement');
  assert.ok(matchesResetType(preview, 'global')); assert.notEqual(resetEntryKey(global), resetEntryKey(preview));
  const explicit = normalizeFeed('codex-announcements', { tweets: [{ id: 'announced', text: 'All paid accounts will reset tonight', kind: 'candidate', explicit_reset_claim: true, tibo_lane: 'reset_announcement', at: '2026-09-05', url: base.url }] }).items[0];
  assert.equal(explicit.reset_kind, 'global'); assert.equal(resetMarker(explicit), 'announcement');
  const feedBanked = normalizeFeed('codex-announcements', { tweets: [{ id: 'bank', text: 'Banked', kind: 'banked', banked_state: 'arriving', at: '2026-09-05', url: base.url }] }).items[0];
  assert.equal(resetEntryKey(feedBanked), resetEntryKey(banked));
  for (const kind of ['watch', 'signal']) {
    const signal = normalizeFeed('codex-announcements', { tweets: [{ id: kind, text: kind, kind, at: '2026-09-05', url: base.url }] }).items[0];
    assert.equal(resetMarker(signal), 'signal'); assert.ok(matchesResetType(signal, 'signal'));
  }
  const credits = normalizeFeed('codex-timeline', { events: [{ ...base, reset_kind: null }] }).items[0];
  assert.equal(resetMarker(credits), 'credits');
});
