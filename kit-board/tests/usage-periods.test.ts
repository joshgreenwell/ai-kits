import test from 'node:test';
import assert from 'node:assert/strict';
import { addLocalDays, localDayStart, localMonthStart, monthBounds, monthsWithin, periodsWithin, resolveRange, wallClock, zonedInstant } from '../lib/usage-periods';

const TZ = 'America/Chicago';
const at = (value: string) => Date.parse(value);

test('local boundaries follow the zone wall clock across daylight-saving changes', () => {
  // Spring forward: March 8, 2026 has 23 hours in Chicago.
  assert.equal(zonedInstant(2026, 3, 8, TZ), at('2026-03-08T06:00:00Z'));
  assert.equal(zonedInstant(2026, 3, 9, TZ), at('2026-03-09T05:00:00Z'));
  assert.equal(addLocalDays(zonedInstant(2026, 3, 8, TZ), 1, TZ) - zonedInstant(2026, 3, 8, TZ), 23 * 3_600_000);
  // Fall back: November 1, 2026 has 25 hours.
  assert.equal(addLocalDays(zonedInstant(2026, 11, 1, TZ), 1, TZ) - zonedInstant(2026, 11, 1, TZ), 25 * 3_600_000);
  assert.deepEqual(wallClock(at('2026-09-14T04:59:59Z'), TZ), { year: 2026, month: 9, day: 13, hour: 23, minute: 59, second: 59 });
  assert.equal(localDayStart(at('2026-09-14T04:59:59Z'), TZ), at('2026-09-13T05:00:00Z'));
  assert.equal(localMonthStart(at('2026-09-14T04:59:59Z'), TZ, -1), at('2026-08-01T05:00:00Z'));
});

test('presets are half-open ranges at local boundaries and bounded', () => {
  const now = at('2026-09-14T20:30:00Z');   // 15:30 Chicago
  assert.deepEqual([resolveRange({ preset: 'today', now }).start, resolveRange({ preset: 'today', now }).end], [at('2026-09-14T05:00:00Z'), now]);
  assert.equal(resolveRange({ preset: 'last_7_days', now }).start, at('2026-09-08T05:00:00Z'));
  assert.equal(resolveRange({ preset: 'last_30_days', now }).start, at('2026-08-16T05:00:00Z'));
  const mtd = resolveRange({ preset: 'month_to_date', now });
  assert.deepEqual([mtd.start, mtd.end, mtd.anchored_to_now], [at('2026-09-01T05:00:00Z'), now, true]);
  const previous = resolveRange({ preset: 'previous_month', now });
  assert.deepEqual([previous.start, previous.end, previous.anchored_to_now], [at('2026-08-01T05:00:00Z'), at('2026-09-01T05:00:00Z'), false]);
  const custom = resolveRange({ preset: 'custom', start: '2026-09-01T00:00:00Z', end: '2026-12-01T00:00:00Z', now });
  assert.equal(custom.end, now, 'a custom end in the future is clamped to now');
  assert.throws(() => resolveRange({ preset: 'custom', start: '2026-09-02T00:00:00Z', end: '2026-09-01T00:00:00Z', now }), /after its start/);
  assert.throws(() => resolveRange({ preset: 'custom', start: '2025-01-01T00:00:00Z', end: '2026-09-01T00:00:00Z', now }), /at most 400 days/);
  assert.throws(() => resolveRange({ preset: 'today', now, timezone: 'Mars/Olympus' }), /Unsupported time zone/);
});

test('periods align to the zone, clip to the range, and stay bounded', () => {
  const range = { start: at('2026-03-07T12:00:00Z'), end: at('2026-03-10T03:30:00Z') };
  const days = periodsWithin(range, 'day', TZ);
  assert.deepEqual(days.map(d => [new Date(d.aligned).toISOString(), d.clipped, (d.end - d.start) / 3_600_000]), [
    ['2026-03-07T06:00:00.000Z', true, 18], ['2026-03-08T06:00:00.000Z', false, 23], ['2026-03-09T05:00:00.000Z', true, 22.5],
  ], 'the first and last days are clipped and the spring-forward day is 23 hours');
  assert.equal(periodsWithin({ start: at('2026-09-01T05:00:00Z'), end: at('2026-09-01T07:10:00Z') }, 'hour', TZ).length, 3);
  assert.throws(() => periodsWithin({ start: at('2026-08-01T05:00:00Z'), end: at('2026-09-01T05:00:00Z') }, 'hour', TZ), /up to 14 days/);
  assert.deepEqual(monthsWithin({ start: at('2026-07-31T12:00:00Z'), end: at('2026-09-01T05:00:00Z') }, TZ), ['2026-07', '2026-08']);
  assert.deepEqual(monthBounds('2026-08', TZ), { start: at('2026-08-01T05:00:00Z'), end: at('2026-09-01T05:00:00Z') });
});
