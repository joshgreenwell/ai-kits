import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailySelection } from '../lib/daily-tasks';
import type { StoredReport } from '../lib/contracts';

const report = (id: string, kind: 'tasks' | 'standup', period_key: string, status: 'complete' | 'partial' | 'failed' = 'complete') =>
  ({ id, kind, period_key, status, coverage: {} }) as StoredReport;

// Histories arrive newest first, the way reportHistory orders them.
const briefings = [report('b22', 'tasks', '2026-09-22'), report('b21-retry', 'tasks', '2026-09-21'), report('b21', 'tasks', '2026-09-21', 'partial'), report('b20', 'tasks', '2026-09-20')];
const standups = [report('s22-failed', 'standup', '2026-09-22', 'failed'), report('s22', 'standup', '2026-09-22'), report('s21', 'standup', '2026-09-21'), report('s19', 'standup', '2026-09-19')];

test('the newest day pairs its briefing with the standup for the same day', () => {
  const selection = dailySelection(briefings, standups);
  assert.equal(selection.day, '2026-09-22');
  assert.equal(selection.briefing?.id, 'b22');
  assert.equal(selection.standup?.id, 's22');
});

test('days list every day either report covers, newest first, with what each holds', () => {
  assert.deepEqual(dailySelection(briefings, standups).days, [
    { day: '2026-09-22', briefing: true, standup: true },
    { day: '2026-09-21', briefing: true, standup: true },
    { day: '2026-09-20', briefing: true, standup: false },
    { day: '2026-09-19', briefing: false, standup: true },
  ]);
});

test('a chosen day leaves the missing report absent rather than borrowing another day', () => {
  const weekend = dailySelection(briefings, standups, { day: '2026-09-20' });
  assert.equal(weekend.briefing?.id, 'b20');
  assert.equal(weekend.standup, undefined);
  const standupOnly = dailySelection(briefings, standups, { day: '2026-09-19' });
  assert.equal(standupOnly.briefing, undefined);
  assert.equal(standupOnly.standup?.id, 's19');
});

test('a requested revision pins its day and kind while the other kind follows that day', () => {
  const pinned = dailySelection(briefings, standups, { report: 'b21', day: '2026-09-22' });
  assert.equal(pinned.day, '2026-09-21');
  assert.equal(pinned.briefing?.id, 'b21');
  assert.equal(pinned.standup?.id, 's21');
  const oldStandupLink = dailySelection(briefings, standups, { report: 's22-failed' });
  assert.equal(oldStandupLink.standup?.id, 's22-failed');
  assert.equal(oldStandupLink.briefing?.id, 'b22');
});

test('an unknown revision falls back to the newest day and empty histories select nothing', () => {
  const unknown = dailySelection(briefings, standups, { report: 'missing' });
  assert.equal(unknown.day, '2026-09-22');
  assert.deepEqual(dailySelection([], []), { days: [], day: undefined, briefing: undefined, standup: undefined });
});
