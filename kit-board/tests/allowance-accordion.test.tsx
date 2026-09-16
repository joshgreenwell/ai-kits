import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AllowanceAccordion } from '../components/allowance-accordion';
import { AllowanceBurnChart } from '../components/allowance-burn-chart';
import { accountViews, type LiveQuota } from '../lib/allowance-view';

const NOW = Date.parse('2026-09-10T14:05:00Z');
const TZ = 'America/Chicago';
const accounts = [{ id: 'claude-a', label: 'Claude personal', provider: 'claude' }, { id: 'codex-b', label: 'Codex primary', provider: 'codex' }];
const sources = [
  { id: 'src-live', account_id: 'claude-a', machine_label: 'desk', mode: 'companion', disabled: false, last_seen_at: '2026-09-10T14:00:00Z', cadence_minutes: 60 },
  { id: 'src-old', account_id: 'claude-a', machine_label: 'old', mode: 'local', disabled: true, last_seen_at: null },
  { id: 'src-codex', account_id: 'codex-b', machine_label: 'desk', mode: 'companion', disabled: false, last_seen_at: '2026-09-10T14:00:00Z', cadence_minutes: 30 },
];
let counter = 0;
const q = (account: string, key: string, label: string, observed: string, used: number, resets: string, minutes: number, extra: Partial<LiveQuota> = {}): LiveQuota =>
  ({ id: `q${counter++}`, account_id: account, window_key: key, label, observed_at: observed, used_percent: used, resets_at: resets, window_minutes: minutes, source_id: 'src-live', reader: 'statusline', ...extra });
const quotas: LiveQuota[] = [
  q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T08:00:00Z', 10, '2026-09-10T12:00:00Z', 300),
  q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T10:00:00Z', 30, '2026-09-10T12:00:00Z', 300),
  q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T13:00:00Z', 5, '2026-09-10T17:00:00Z', 300),
  q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T13:40:00Z', 12, '2026-09-10T17:00:00Z', 300),
  q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T14:00:00Z', 60, '2026-09-10T17:00:00Z', 300, { source_id: 'src-old', reader: 'v1', history_only: true }),
  q('claude-a', 'seven_day', 'Claude · weekly', '2026-09-09T10:00:00Z', 40, '2026-09-14T10:00:00Z', 10080, { source_id: 'src-old', reader: 'v1', history_only: true }),
  q('codex-b', 'codex:10080', 'Codex · weekly', '2026-09-10T12:00:00Z', 55, '2026-09-13T00:00:00Z', 10080, { source_id: 'src-codex', reader: 'embedded' }),
  q('codex-b', 'codex_spark:10080', 'Codex Spark · weekly', '2026-09-08T12:00:00Z', 70, '2026-09-10T12:00:00Z', 10080, { source_id: 'src-codex', reader: 'embedded' }),
];

const render = (showSpark: boolean, expanded: string[], alerts: Record<string, string[]> = {}) => renderToStaticMarkup(createElement(AllowanceAccordion, {
  views: accountViews({ accounts, sources, quotas, now: NOW, showSpark, alerts }), expanded, onExpandedChange: () => {}, now: NOW, timezone: TZ,
}));

test('the header shows every window side by side with remaining, countdown, and outlook', () => {
  const html = render(false, []);
  assert.match(html, /data-testid="account-claude-a"[\s\S]*data-testid="account-codex-b"/, 'one card per account in order');
  assert.match(html, /Claude personal[\s\S]*?>claude</);
  const five = html.slice(html.indexOf('data-testid="window-five_hour"'), html.indexOf('data-testid="window-seven_day"'));
  assert.match(five, />blended forecast</);
  assert.match(five, />88\.0%</, 'remaining from the newest live reading, never the later history-only one');
  assert.match(five, /12\.0% used · resets in 2h 55m/);
  assert.match(five, /46% by reset · observed Sep 10, 8:40 AM/, 'each window carries its own observation time');
  assert.match(html, /last observation Sep 10, 8:40 AM/, 'the account time is the newest reading behind a current figure, not the later history-only one');
  assert.match(five, /role="meter"[^>]*aria-valuenow="12"/);
  assert.match(five, /% by reset/);
  const weekly = html.slice(html.indexOf('data-testid="window-seven_day"'), html.indexOf('data-testid="account-codex-b"'));
  assert.match(weekly, />history only</);
  assert.match(weekly, />—</);
  assert.match(weekly, /no current reading/);
  assert.doesNotMatch(weekly, /role="meter"/);
  const codex = html.slice(html.indexOf('data-testid="account-codex-b"'));
  assert.match(codex, />stale reading</);
  assert.match(codex, /45\.0%/);
  assert.match(codex, /projection paused/);
  assert.doesNotMatch(html, /NaN/);
  assert.match(codex, /1 Spark window hidden/);
  assert.doesNotMatch(codex, /window-codex_spark/, 'Spark stays hidden until the owner turns it on');
  assert.doesNotMatch(html, /data-testid="detail-/, 'nothing is expanded');
  assert.match(html, /aria-expanded="false"/);
});

test('expanding an account reveals each window’s burn chart, forecast stats, and history-only wording', () => {
  const html = render(true, ['claude-a', 'codex-b'], { 'codex-b': ['Identity unconfirmed on desk: readings the collector cannot attribute are held on the machine, not shown here.'] });
  assert.match(html, /data-state="open"[^>]*data-testid="account-claude-a"/);
  const five = html.slice(html.indexOf('data-testid="detail-five_hour"'), html.indexOf('data-testid="detail-seven_day"'));
  assert.match(five, /role="group"[^>]*aria-label="12\.0% used at the last reading, projected [\d.]+% by reset; 1 other cycle shown faint"/);
  // Recharts draws nothing until it has measured a container, so the chart's own figures are read from its DOM mirror.
  assert.match(five, /Cycle start Sep 10, 7:00 AM, reset Sep 10, 12:00 PM\./);
  assert.match(five, /role="img"[^>]*aria-label="[^"]*60\.0% used via v1, history only"/, 'the history-only reading stays on the chart and says so');
  assert.match(five, /via statusline · 5-hour window · 1 history-only readings/);
  assert.match(five, /Forecast burn \/ hour/);
  assert.match(five, /67% current evidence · pts/, 'the blend weight is carried by the stat, not by a paragraph');
  assert.match(five, /Above 100% is demand beyond the allowance/);
  const weekly = html.slice(html.indexOf('data-testid="detail-seven_day"'), html.indexOf('data-testid="account-codex-b"'));
  assert.match(weekly, /Every reading of this window comes from a disabled source, so it is history only/);
  assert.match(weekly, /1 readings in the last cycle; no current reading/);
  assert.doesNotMatch(weekly, /How this projection works/);
  const codex = html.slice(html.indexOf('data-testid="account-codex-b"'));
  assert.match(codex, /Identity unconfirmed on desk/);
  assert.match(codex, /data-testid="window-codex_spark:10080"/);
  assert.match(codex, />awaiting new window</);
  assert.match(codex, /Forecast burn \/ day/);
  assert.match(codex, /The last reading is 125 minutes old \(stale after 120\)/);
  assert.match(codex, /This window has reset; a reading from the new window is needed/);
  assert.match(codex, /70\.0% used · window has reset/);
  assert.match(codex, /· Spark</);
});

test('the burn chart keeps a newer history-only cycle faint and pauses the seed while stale', () => {
  const rows: LiveQuota[] = [
    q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-09T08:00:00Z', 10, '2026-09-09T12:00:00Z', 300),
    q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-09T10:00:00Z', 30, '2026-09-09T12:00:00Z', 300),
    q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T08:00:00Z', 6, '2026-09-10T12:00:00Z', 300),
    q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T09:00:00Z', 15, '2026-09-10T12:00:00Z', 300),
    q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T13:00:00Z', 8, '2026-09-10T17:00:00Z', 300, { source_id: 'src-old', reader: 'v1', history_only: true }),
    q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T13:45:00Z', 21, '2026-09-10T17:00:00Z', 300, { source_id: 'src-old', reader: 'v1', history_only: true }),
  ];
  const view = accountViews({ accounts: accounts.slice(0, 1), sources, quotas: rows, now: NOW, showSpark: false })[0].windows[0];
  assert.deepEqual([view.state, view.pace?.observed_at, view.historyOnlyRows, view.cycles.length], ['expired', '2026-09-10T09:00:00Z', 2, 3]);
  const html = renderToStaticMarkup(createElement(AllowanceBurnChart, { pace: view.pace, cycles: view.cycles, history: view.history, timezone: TZ }));
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /forecast unavailable; 2 other cycles shown faint/);
  assert.match(html, />Open cycle, reset Sep 10, 12:00 PM: 13\.0 points over 0\.8h</, 'the newer history-only cycle is drawn, not dropped');
  assert.match(html, />Completed cycle, reset Sep 9, 7:00 AM/);
  assert.doesNotMatch(html, /Recent cycles seed/, 'a stale reading pauses the forecast, so no seed line or band is drawn');
  assert.doesNotMatch(html, /Recent cycles spread/);
  assert.match(html, /aria-label="Sep 10, 4:00 AM: 15\.0% used via statusline"/);
  assert.match(html, /Cycle start Sep 10, 2:00 AM, reset Sep 10, 7:00 AM\./, 'the mirror names the cycle the chart plots between');
});
