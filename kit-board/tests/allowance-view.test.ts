import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, accountViews, carriedAccounts, countdownLabel, expandedAccounts, outlookState, parsePreferences, rememberExpanded, type LiveQuota } from '../lib/allowance-view';

const NOW = Date.parse('2026-09-10T14:05:00Z');
const accounts = [{ id: 'claude-a', label: 'Claude personal', provider: 'claude' }, { id: 'codex-b', label: 'Codex primary', provider: 'codex' }];
const sources = [
  { id: 'src-live', account_id: 'claude-a', machine_label: 'desk', mode: 'companion', disabled: false, last_seen_at: '2026-09-10T14:00:00Z', cadence_minutes: 60 },
  { id: 'src-old', account_id: 'claude-a', machine_label: 'old', mode: 'local', disabled: true, last_seen_at: null },
  { id: 'src-codex', account_id: 'codex-b', machine_label: 'desk', mode: 'companion', disabled: false, last_seen_at: '2026-09-10T14:00:00Z', cadence_minutes: 30 },
];
let counter = 0;
const q = (account: string, key: string, observed: string, used: number, resets: string, minutes: number, extra: Partial<LiveQuota> = {}): LiveQuota =>
  ({ id: `q${counter++}`, account_id: account, window_key: key, label: key === 'five_hour' ? 'Claude · 5h' : key === 'seven_day' ? 'Claude · weekly' : key.includes('spark') ? 'Codex Spark · weekly' : 'Codex · weekly', observed_at: observed, used_percent: used, resets_at: resets, window_minutes: minutes, source_id: 'src-live', reader: 'statusline', ...extra });

const quotas: LiveQuota[] = [
  // Claude five-hour: a completed cycle, then the current one with two live readings, plus a later history-only reading from the disabled source.
  q('claude-a', 'five_hour', '2026-09-10T08:00:00Z', 10, '2026-09-10T12:00:00Z', 300),
  q('claude-a', 'five_hour', '2026-09-10T10:00:00Z', 30, '2026-09-10T12:00:00Z', 300),
  q('claude-a', 'five_hour', '2026-09-10T13:00:00Z', 5, '2026-09-10T17:00:00Z', 300),
  q('claude-a', 'five_hour', '2026-09-10T13:40:00Z', 12, '2026-09-10T17:00:00Z', 300),
  q('claude-a', 'five_hour', '2026-09-10T14:00:00Z', 60, '2026-09-10T17:00:00Z', 300, { source_id: 'src-old', reader: 'v1', history_only: true }),
  // Claude weekly: only a history-only reading.
  q('claude-a', 'seven_day', '2026-09-09T10:00:00Z', 40, '2026-09-14T10:00:00Z', 10080, { source_id: 'src-old', reader: 'v1', history_only: true }),
  // Claude model-scoped weekly: a fresh reading, insufficient live evidence, no prior cycles.
  q('claude-a', 'seven_day_claude_opus_5', '2026-09-10T14:00:00Z', 22, '2026-09-14T10:00:00Z', 10080, { label: 'Claude · weekly · Opus 5' }),
  // Codex weekly: one stale reading (two hours old at a 30-minute cadence) and a Spark window that is expired.
  q('codex-b', 'codex:10080', '2026-09-10T12:00:00Z', 55, '2026-09-13T00:00:00Z', 10080, { source_id: 'src-codex', reader: 'embedded' }),
  q('codex-b', 'codex_spark:10080', '2026-09-08T12:00:00Z', 70, '2026-09-10T12:00:00Z', 10080, { source_id: 'src-codex', reader: 'embedded' }),
];

test('account views forecast each window from its own live readings and keep history-only rows as history', () => {
  const views = accountViews({ accounts, sources, quotas, now: NOW, showSpark: false });
  assert.deepEqual(views.map(v => [v.account.id, v.windows.map(w => w.key), v.visible.map(w => w.key), v.hiddenSpark]),
    [['claude-a', ['five_hour', 'seven_day', 'seven_day_claude_opus_5'], ['five_hour', 'seven_day', 'seven_day_claude_opus_5'], 0], ['codex-b', ['codex:10080', 'codex_spark:10080'], ['codex:10080'], 1]],
    'shorter windows first, model-scoped after, Spark last and hidden by default');
  const five = views[0].windows[0];
  assert.deepEqual([five.state, five.pace?.used_percent, five.pace?.observed_at, five.historyOnlyRows, five.history.length, five.cycles.length, five.cadenceMinutes],
    ['blended', 12, '2026-09-10T13:40:00Z', 1, 5, 2, 60], 'the later history-only reading never becomes current; the chart keeps it and both cycles');
  const weekly = views[0].windows[1];
  assert.deepEqual([weekly.state, weekly.pace, weekly.latestObservation, weekly.historyOnlyRows], ['history_only', null, '2026-09-09T10:00:00Z', 1]);
  const scoped = views[0].windows[2];
  assert.deepEqual([scoped.state, scoped.scoped, scoped.title, scoped.pace?.projectedUsedPercent], ['learning', true, 'Claude · weekly · Claude Opus 5', null]);
  assert.equal(views[0].latestObservation, '2026-09-10T14:00:00Z', 'the newest observation of any window, history-only included');
  const codex = views[1].windows[0];
  assert.deepEqual([codex.state, codex.pace?.stale, codex.pace?.staleReason, codex.cadenceMinutes], ['stale', true, 'age', 30], 'two hours old at a thirty-minute cadence is stale');
  const spark = accountViews({ accounts, sources, quotas, now: NOW, showSpark: true })[1].windows[1];
  assert.deepEqual([spark.spark, spark.state, spark.pace?.staleReason], [true, 'expired', 'expired']);
  const week = accountViews({ accounts, sources, quotas, now: NOW, showSpark: false, historyDays: 7, alerts: { 'codex-b': ['Identity unconfirmed on desk'] } });
  assert.deepEqual(week[1].alerts, ['Identity unconfirmed on desk']);
  assert.equal(week[0].windows[0].history.length, 5, 'a seven-day range still holds this week’s readings');
});

test('the newest live reading stays current when readers disagree on the reset and when the range is short', () => {
  // A browser reading estimates the reset three minutes later than the statusline: two cycle groups, one window.
  const rows: LiveQuota[] = [
    q('claude-a', 'five_hour', '2026-09-10T12:30:00Z', 4, '2026-09-10T17:03:00Z', 300, { reader: 'browser' }),
    q('claude-a', 'five_hour', '2026-09-10T13:30:00Z', 9, '2026-09-10T17:03:00Z', 300, { reader: 'browser' }),
    q('claude-a', 'five_hour', '2026-09-10T14:00:00Z', 12, '2026-09-10T17:00:00Z', 300),
  ];
  const five = accountViews({ accounts: accounts.slice(0, 1), sources, quotas: rows, now: NOW, showSpark: false, historyDays: 7 })[0].windows[0];
  assert.deepEqual([five.pace?.observed_at, five.pace?.used_percent, five.latestReader, five.latestObservation], ['2026-09-10T14:00:00Z', 12, 'statusline', '2026-09-10T14:00:00Z']);
  assert.equal(five.history.length, 3, 'every reading of the window stays on the chart');
  // Once the statusline's boundary passes, the older browser reading must not become a fresh-looking current reading.
  const later = accountViews({ accounts: accounts.slice(0, 1), sources, quotas: rows, now: Date.parse('2026-09-10T17:01:00Z'), showSpark: false })[0].windows[0];
  assert.deepEqual([later.state, later.pace?.observed_at, later.pace?.staleReason], ['expired', '2026-09-10T14:00:00Z', 'expired']);
  // A short range keeps the whole active cycle even when it began before the range.
  const old: LiveQuota[] = [
    q('claude-a', 'seven_day', '2026-09-02T08:00:00Z', 3, '2026-09-08T09:00:00Z', 10080),
    q('claude-a', 'seven_day', '2026-09-02T10:00:00Z', 20, '2026-09-08T09:00:00Z', 10080),
    q('claude-a', 'seven_day', '2026-09-10T13:30:00Z', 2, '2026-09-15T09:00:00Z', 10080),
  ];
  const weekly = accountViews({ accounts: accounts.slice(0, 1), sources, quotas: old, now: NOW, showSpark: false, historyDays: 7 })[0].windows[0];
  assert.deepEqual([weekly.history.map(r => r.observed_at), weekly.cycles.length, weekly.state], [['2026-09-10T13:30:00Z'], 1, 'historical'], 'the completed cycle outside the range leaves the chart but still seeds the forecast');
  const wide = accountViews({ accounts: accounts.slice(0, 1), sources, quotas: old, now: NOW, showSpark: false, historyDays: 14 })[0].windows[0];
  assert.deepEqual([wide.history.length, wide.cycles.length, wide.pace?.forecastSource, wide.state], [3, 2, 'historical', 'historical'], 'a wider range only adds chart history; the state comes from the same readings');
});

test('outlook states, countdowns, carried accounts, and preferences', () => {
  assert.equal(outlookState(null, true), 'history_only');
  assert.equal(countdownLabel('2026-09-10T17:00:00Z', NOW), '2h 55m');
  assert.equal(countdownLabel('2026-09-10T14:05:10Z', NOW), '0h 1m', 'seconds away is still ahead of the reset');
  assert.equal(countdownLabel('2026-09-13T00:00:00Z', NOW), '2d 9h');
  assert.equal(countdownLabel('2026-09-10T12:00:00Z', NOW), 'awaiting new window');
  assert.deepEqual(carriedAccounts(new URLSearchParams('accounts=codex-b&projects=p1&efforts=high'), accounts).map(a => a.id), ['codex-b'], 'only accounts and providers carry over');
  assert.deepEqual(carriedAccounts(new URLSearchParams('providers=claude'), accounts).map(a => a.id), ['claude-a']);
  assert.deepEqual(carriedAccounts(new URLSearchParams(''), accounts).map(a => a.id), ['claude-a', 'codex-b']);
  assert.deepEqual(parsePreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences('{"expanded":["codex-b",3],"showSpark":true,"historyDays":14}'), { expanded: ['codex-b'], showSpark: true, historyDays: 14 });
  assert.deepEqual(parsePreferences('{"historyDays":9,"showSpark":"yes"}'), { expanded: null, showSpark: false, historyDays: 30 });
  assert.deepEqual(parsePreferences('not json'), DEFAULT_PREFERENCES);
  assert.deepEqual(expandedAccounts(DEFAULT_PREFERENCES, accounts), ['claude-a'], 'the first account starts open');
  assert.deepEqual(expandedAccounts({ ...DEFAULT_PREFERENCES, expanded: ['codex-b', 'gone'] }, accounts), ['codex-b'], 'a remembered account that no longer exists is dropped');
  assert.deepEqual(expandedAccounts({ ...DEFAULT_PREFERENCES, expanded: [] }, accounts), [], 'closing every account is remembered too');
  assert.deepEqual(rememberExpanded(DEFAULT_PREFERENCES, accounts, accounts.slice(1), []), ['claude-a'], 'closing the only shown account keeps the hidden default open');
  assert.deepEqual(rememberExpanded({ ...DEFAULT_PREFERENCES, expanded: ['claude-a', 'codex-b'] }, accounts, accounts.slice(1), []), ['claude-a'], 'a narrowed view never forgets the accounts it does not show');
  assert.deepEqual(rememberExpanded({ ...DEFAULT_PREFERENCES, expanded: [] }, accounts, accounts, ['codex-b']), ['codex-b']);
});
