import test from 'node:test';
import assert from 'node:assert/strict';
import { readingFreshness, staleAfterMinutes } from '../lib/allowance-freshness';

const now = Date.parse('2026-09-09T18:00:00Z');
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const nextWeek = '2026-09-16T18:00:00Z';
const at = (ageMinutes: number, cadenceMinutes?: number) =>
  readingFreshness({ observedAt: minutesAgo(ageMinutes), resetsAt: nextWeek, now, cadenceMinutes });

test('the stale threshold is two cadences plus fifteen minutes with a two-hour floor', () => {
  assert.equal(staleAfterMinutes(60), 135);
  assert.equal(staleAfterMinutes(120), 255);
  assert.equal(staleAfterMinutes(30), 120, 'floor case: 75 minutes rounds up to the floor');
  assert.equal(staleAfterMinutes(15), 120, 'floor case: 45 minutes rounds up to the floor');
  assert.equal(staleAfterMinutes(), 135, 'the default cadence is sixty minutes');
});

test('cadence 60 flips at 135 minutes, plus or minus one', () => {
  assert.deepEqual([at(134, 60).stale, at(134, 60).reason], [false, null]);
  assert.deepEqual([at(135, 60).stale, at(135, 60).reason], [false, null], 'exactly the threshold is still fresh');
  assert.deepEqual([at(136, 60).stale, at(136, 60).reason], [true, 'age']);
  assert.equal(at(136, 60).ageMinutes, 136);
  assert.equal(at(136).stale, true, 'omitting the cadence uses sixty');
});

test('floor case: cadence 30 flips at 120 minutes, plus or minus one', () => {
  assert.equal(at(119, 30).stale, false);
  assert.equal(at(121, 30).stale, true);
  assert.equal(at(121, 30).staleAfterMinutes, 120);
});

test('floor case: cadence 15 flips at 120 minutes, plus or minus one', () => {
  assert.equal(at(119, 15).stale, false);
  assert.equal(at(121, 15).stale, true);
  assert.equal(at(121, 15).staleAfterMinutes, 120);
});

test('a reading whose window has reset is stale whatever its age', () => {
  const expired = readingFreshness({ observedAt: minutesAgo(10), resetsAt: new Date(now - 1000).toISOString(), now, cadenceMinutes: 60 });
  assert.deepEqual([expired.stale, expired.reason], [true, 'expired']);
  const boundary = readingFreshness({ observedAt: minutesAgo(10), resetsAt: now, now });
  assert.deepEqual([boundary.stale, boundary.reason], [true, 'expired'], 'a reset at this instant counts as reset');
  const pending = readingFreshness({ observedAt: minutesAgo(10), resetsAt: new Date(now + 60_000).toISOString(), now });
  assert.deepEqual([pending.stale, pending.reason], [false, null]);
  const both = readingFreshness({ observedAt: minutesAgo(400), resetsAt: minutesAgo(1), now });
  assert.equal(both.reason, 'expired', 'an expired window is the stronger reason');
  const noReset = readingFreshness({ observedAt: minutesAgo(10), now });
  assert.deepEqual([noReset.stale, noReset.reason], [false, null], 'a meter without a reset anchor is judged by age alone');
});

test('unreadable or future observation times never read as fresh by accident', () => {
  const unreadable = readingFreshness({ observedAt: 'not-a-date', resetsAt: nextWeek, now });
  assert.deepEqual([unreadable.stale, unreadable.reason, unreadable.ageMinutes], [true, 'age', Number.POSITIVE_INFINITY]);
  assert.equal(readingFreshness({ observedAt: now + 30_000, resetsAt: nextWeek, now }).ageMinutes, 0, 'clock skew clamps to zero');
});
