import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaCycles, quotaOutlook, type QuotaSample } from '../lib/telemetry-contract';

const sample = (observed_at: string, used_percent: number, resets_at: string): QuotaSample => ({
  window_key: 'five_hour',
  label: '5-hour',
  observed_at,
  used_percent,
  resets_at,
  window_minutes: 300,
});

test('quota history preserves completed reset cycles and tolerates small anchor drift', () => {
  const rows = [
    sample('2026-09-10T08:00:00Z', 10, '2026-09-10T12:00:00Z'),
    sample('2026-09-10T10:00:00Z', 30, '2026-09-10T12:01:00Z'),
    sample('2026-09-10T13:00:00Z', 5, '2026-09-10T17:00:00Z'),
  ];
  const cycles = quotaCycles(rows, Date.parse('2026-09-10T14:00:00Z'));
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].completed, true);
  assert.equal(cycles[0].pointsPerHour, 10);
  assert.equal(cycles[1].completed, false);
});

test('a new reset window is seeded by completed-cycle burn history', () => {
  const rows = [
    sample('2026-09-10T08:00:00Z', 10, '2026-09-10T12:00:00Z'),
    sample('2026-09-10T10:00:00Z', 30, '2026-09-10T12:00:00Z'),
    sample('2026-09-10T13:00:00Z', 5, '2026-09-10T17:00:00Z'),
  ];
  const outlook = quotaOutlook(rows, Date.parse('2026-09-10T13:05:00Z'))!;
  assert.equal(outlook.forecastSource, 'historical');
  assert.equal(outlook.currentPointsPerHour, null);
  assert.equal(outlook.historicalPointsPerHour, 10);
  assert.equal(outlook.projectedUsedPercent, 45);
  assert.equal(outlook.comparableCycles, 1);
});

test('live evidence blends with history and discontinuous cycles are excluded', () => {
  const rows = [
    sample('2026-09-10T08:00:00Z', 10, '2026-09-10T12:00:00Z'),
    sample('2026-09-10T10:00:00Z', 30, '2026-09-10T12:00:00Z'),
    sample('2026-09-10T13:00:00Z', 5, '2026-09-10T17:00:00Z'),
    sample('2026-09-10T13:30:00Z', 7, '2026-09-10T17:00:00Z'),
  ];
  const outlook = quotaOutlook(rows, Date.parse('2026-09-10T13:30:00Z'))!;
  assert.equal(outlook.forecastSource, 'blended');
  assert.equal(outlook.liveWeight, 0.5);
  assert.equal(outlook.currentPointsPerHour, 4);
  assert.equal(outlook.pointsPerHour, 7);

  const broken = quotaCycles([
    sample('2026-09-09T08:00:00Z', 30, '2026-09-09T12:00:00Z'),
    sample('2026-09-09T10:00:00Z', 20, '2026-09-09T12:00:00Z'),
  ], Date.parse('2026-09-10T00:00:00Z'))[0];
  assert.equal(broken.discontinuous, true);
  assert.equal(broken.pointsPerHour, null);
});

test('history-only samples shape cycles but never become the current reading', () => {
  const live = [
    sample('2026-09-10T08:00:00Z', 10, '2026-09-10T12:00:00Z'),
    sample('2026-09-10T10:00:00Z', 30, '2026-09-10T12:00:00Z'),
    sample('2026-09-10T13:00:00Z', 5, '2026-09-10T17:00:00Z'),
  ];
  // A disabled source observed this window later and higher; it stays history and cannot revive capacity.
  const disabled = { ...sample('2026-09-10T14:00:00Z', 60, '2026-09-10T17:00:00Z'), history_only: true };
  const outlook = quotaOutlook([...live, disabled], Date.parse('2026-09-10T14:05:00Z'))!;
  assert.equal(outlook.observed_at, '2026-09-10T13:00:00Z');
  assert.equal(outlook.used_percent, 5);
  assert.equal(outlook.cycles.length, 2, 'the cycle history keeps every observation');
  assert.equal(outlook.cycles[1].samples.length, 2);
  assert.equal(outlook.samples, 1, 'pace uses live samples only');
  // With only history, an earlier completed live cycle is the current one and reads as expired, never the disabled window.
  const expired = quotaOutlook([live[0], live[1], { ...live[2], history_only: true }, disabled], Date.parse('2026-09-10T14:05:00Z'))!;
  assert.equal(expired.resets_at, '2026-09-10T12:00:00.000Z');
  assert.equal(expired.stale, true);
  assert.equal(expired.staleReason, 'expired');
  assert.equal(quotaOutlook([{ ...live[0], history_only: true }, disabled], Date.parse('2026-09-10T14:05:00Z')), null, 'history alone has no outlook');
});
