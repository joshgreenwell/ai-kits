import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AllowanceOutlook, windowName } from '../components/allowance-outlook';
import { accountViews, urgencyRows, urgencyTier, type LiveQuota } from '../lib/allowance-view';

const NOW = Date.parse('2026-09-10T14:05:00Z');
const TZ = 'America/Chicago';
const accounts = [
  { id: 'claude-a', label: 'Claude · personal', provider: 'claude' },
  { id: 'codex-b', label: 'Codex · primary', provider: 'codex' },
  { id: 'cursor-c', label: 'Cursor', provider: 'cursor' },
];
const sources = [{ id: 'src', account_id: 'claude-a', machine_label: 'desk', mode: 'companion', disabled: false, last_seen_at: '2026-09-10T14:00:00Z', cadence_minutes: 60 }];
let counter = 0;
const q = (account: string, key: string, label: string, observed: string, used: number, resets: string, minutes: number): LiveQuota =>
  ({ id: `q${counter++}`, account_id: account, window_key: key, label, observed_at: observed, used_percent: used, resets_at: resets, window_minutes: minutes, source_id: 'src', reader: 'statusline' });

const quotas: LiveQuota[] = [
  // Steady: a point in six hours against four days to go.
  q('claude-a', 'seven_day', 'Claude · weekly', '2026-09-10T08:00:00Z', 10, '2026-09-14T10:00:00Z', 10080),
  q('claude-a', 'seven_day', 'Claude · weekly', '2026-09-10T14:00:00Z', 11, '2026-09-14T10:00:00Z', 10080),
  // Short: 40 points in 40 minutes with 3h20m to go, so it runs out about 55 minutes after the last reading.
  q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T13:00:00Z', 5, '2026-09-10T17:00:00Z', 300),
  q('claude-a', 'five_hour', 'Claude · 5h', '2026-09-10T13:40:00Z', 45, '2026-09-10T17:00:00Z', 300),
  // Exhausted: nothing left, whatever the forecast would add.
  q('codex-b', 'codex:300', 'Codex · 5h', '2026-09-10T13:00:00Z', 80, '2026-09-10T17:00:00Z', 300),
  q('codex-b', 'codex:300', 'Codex · 5h', '2026-09-10T13:40:00Z', 100, '2026-09-10T17:00:00Z', 300),
  // Tight: flat for two hours at 85% used, so 15% is left at the reset.
  q('codex-b', 'codex:10080', 'Codex · weekly', '2026-09-10T12:00:00Z', 85, '2026-09-13T00:00:00Z', 10080),
  q('codex-b', 'codex:10080', 'Codex · weekly', '2026-09-10T14:00:00Z', 85, '2026-09-13T00:00:00Z', 10080),
  // Paused: one reading three days old keeps its level and says the forecast is waiting on a fresh one.
  q('cursor-c', 'premium_requests', 'Cursor · included', '2026-09-07T14:00:00Z', 40, '2026-10-01T00:00:00Z', 43200),
];
const views = accountViews({ accounts, sources, quotas, now: NOW, showSpark: false });
const render = () => renderToStaticMarkup(createElement(AllowanceOutlook, { views, now: NOW, timezone: TZ, onSelect: () => {} }));

test('the outlook lists every window across accounts, the ones that run out first', () => {
  const order = urgencyRows(views).map(row => `${row.account.id}/${row.window.key}:${row.tier}`);
  assert.deepEqual(order, [
    'claude-a/five_hour:short', 'codex-b/codex:300:exhausted', 'codex-b/codex:10080:tight', 'cursor-c/premium_requests:steady', 'claude-a/seven_day:steady',
  ], 'a shortfall, then a spent allowance, then little left, then the rest by what is left');
  const html = render();
  const testids = [...html.matchAll(/data-testid="outlook-([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(testids, ['claude-a-five_hour', 'codex-b-codex:300', 'codex-b-codex:10080', 'cursor-c-premium_requests', 'claude-a-seven_day'], 'the rendered rows keep that order');
});

test('each row says what is left and what the forecast means, in the account cards\' words', () => {
  const html = render();
  assert.match(html, /5 windows across 3 accounts, most urgent first/);
  assert.match(html, /runs out Sep 10, 9:35 AM · 145% short/, 'the shortfall names when it runs out, never a bare negative');
  assert.match(html, /fully used · waiting on the reset/);
  assert.match(html, /~15% left by reset/);
  assert.match(html, /paused · reading 3d old/, 'a stale reading keeps its level and says why no projection is drawn');
  assert.doesNotMatch(html, /-\d+(\.\d+)?%/, 'no figure is a bare negative percentage');
  assert.doesNotMatch(html, /NaN/);
  // The bars are what is LEFT, drawn and announced the same way as the account cards'.
  assert.match(html, /role="meter"[^>]*aria-label="Claude · personal Claude · 5h allowance remaining"[^>]*aria-valuenow="55"/);
  assert.match(html, /role="meter"[^>]*aria-valuenow="0"[^>]*aria-valuetext="0\.0% left, fully used · waiting on the reset"[\s\S]{0,200}?bg-destructive\/20/);
  assert.match(html, /aria-valuenow="15"[\s\S]{0,400}?bg-primary[^>]*style="width:15%"/);
  assert.doesNotMatch(html, /width:-/);
});

test('the summary counts what needs attention and names the window behind each figure', () => {
  const html = render();
  assert.match(html, />Runs out before reset<\/span><span[^>]*text-destructive[^>]*>1<\/span><span[^>]*>Claude · personal · 5h · Sep 10, 9:35 AM</);
  assert.match(html, />Lowest left<\/span><span[^>]*text-destructive[^>]*>0\.0%<\/span><span[^>]*>Codex · primary · 5h</);
  assert.match(html, />Next reset<\/span><span[^>]*>2h 55m<\/span>/);
  assert.match(html, />Paused forecasts<\/span><span[^>]*text-warning[^>]*>1<\/span>/);
});

test('a window name drops the provider its account already names, and keeps any other title whole', () => {
  const [claude] = views;
  assert.equal(windowName({ account: claude.account, window: { ...claude.windows[0], title: 'Claude · weekly · Fable' } }), 'Weekly · Fable');
  assert.equal(windowName({ account: { id: 'x', label: 'Cursor', provider: 'cursor' }, window: { ...claude.windows[0], title: 'Cursor · API' } }), 'API');
  assert.equal(windowName({ account: { id: 'x', label: 'Work', provider: 'claude' }, window: { ...claude.windows[0], title: 'Claude · 5h' } }), 'Claude · 5h');
  assert.equal(urgencyTier(null), 'history');
  assert.equal(renderToStaticMarkup(createElement(AllowanceOutlook, { views: [], now: NOW, timezone: TZ, onSelect: () => {} })), '', 'nothing to rank renders nothing');
});
