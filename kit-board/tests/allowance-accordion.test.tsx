import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AllowanceAccordion } from '../components/allowance-accordion';
import { AllowanceBurnChart, BurnTooltip, burnSeries, type Row } from '../components/allowance-burn-chart';
import { accountViews, type LiveQuota } from '../lib/allowance-view';
import type { QuotaCycle } from '../lib/telemetry-contract';

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
/** The Claude account alone, expanded, from a purpose-built set of readings. */
const renderOne = (rows: LiveQuota[]) => renderToStaticMarkup(createElement(AllowanceAccordion, {
  views: accountViews({ accounts: accounts.slice(0, 1), sources, quotas: rows, now: NOW, showSpark: false }),
  expanded: ['claude-a'], onExpandedChange: () => {}, now: NOW, timezone: TZ,
}));
const fiveHour = (observed: string, used: number, resets = '2026-09-10T17:00:00Z') => q('claude-a', 'five_hour', 'Claude · 5h', observed, used, resets, 300);
/** The window a set of readings describes, for the derivations the chart plots but never renders. */
const windowOf = (rows: LiveQuota[]) => accountViews({ accounts: accounts.slice(0, 1), sources, quotas: rows, now: NOW, showSpark: false })[0].windows[0];
/**
 * A bar width is only evidence when it is the meter's own. The expanded card also carries Recharts'
 * container, which emits `width:100%` of its own, so every width here is anchored to `role="meter"`.
 */
const fill = (width: string, tone = 'bg-primary') => new RegExp(`role="meter"[\\s\\S]{0,400}?${tone}[^>]*style="width:${width}%"`);

test('the header shows every window side by side with remaining, countdown, and outlook', () => {
  const html = render(false, []);
  assert.match(html, /data-testid="account-claude-a"[\s\S]*data-testid="account-codex-b"/, 'one card per account in order');
  assert.match(html, /Claude personal[\s\S]*?>claude</);
  const five = html.slice(html.indexOf('data-testid="window-five_hour"'), html.indexOf('data-testid="window-seven_day"'));
  assert.match(five, />blended forecast</);
  assert.match(five, />88\.0%<span[^>]*>left</, 'the anchor figure names its own unit, beside a line that says "used"');
  assert.match(five, /12\.0% used · resets in 2h 55m/, 'the one consumed figure on the card says so in words');
  assert.match(five, /54% left by reset · observed Sep 10, 8:40 AM/, 'each window carries its own observation time');
  assert.match(html, /last observation Sep 10, 8:40 AM/, 'the account time is the newest reading behind a current figure, not the later history-only one');
  // The meter is a depleting gauge: 12% used is an 88% bar, and the width is the only direct proof of it in static markup.
  assert.match(five, /role="meter"[^>]*aria-label="Claude · 5h allowance remaining"/);
  assert.match(five, /role="meter"[^>]*aria-valuenow="88"/);
  assert.match(five, /role="meter"[^>]*aria-valuetext="88\.0% left, 12\.0% used, projected 54% left by reset"/, 'the widget carries the forecast, not only the sibling caption');
  assert.match(five, fill('88'), 'the fill is what is left, not what was used');
  assert.match(five, /% left by reset/);
  const weekly = html.slice(html.indexOf('data-testid="window-seven_day"'), html.indexOf('data-testid="account-codex-b"'));
  assert.match(weekly, />history only</);
  assert.match(weekly, />—</);
  assert.match(weekly, /no current reading/);
  assert.doesNotMatch(weekly, /role="meter"/);
  const codex = html.slice(html.indexOf('data-testid="account-codex-b"'));
  assert.match(codex, />stale reading</);
  assert.match(codex, />45\.0%<span[^>]*>left</);
  assert.match(codex, fill('45'), 'a stale window still draws what is left');
  assert.match(codex, /role="meter"[^>]*aria-valuetext="45\.0% left, 55\.0% used"/, 'a paused projection adds nothing to the widget');
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
  // The projected figure is pinned, not matched loosely: this label is the only place the chart's own
  // projection end point is observable in static markup, and it has to agree with the stat below it.
  assert.match(five, /role="group"[^>]*aria-label="88\.0% left at the last reading, projected 53\.6% left by reset; 1 other cycle shown faint"/);
  // Recharts draws nothing until it has measured a container, so the chart's own figures are read from its DOM mirror.
  assert.match(five, /Cycle start Sep 10, 7:00 AM, reset Sep 10, 12:00 PM\./);
  assert.match(five, /role="img"[^>]*aria-label="[^"]*40\.0% left via v1, history only"/, 'the history-only reading stays on the chart and says so');
  assert.match(five, /via statusline · 5-hour window · 1 history-only readings/);
  assert.match(five, /Forecast burn \/ hour/);
  assert.match(five, /67% current evidence · pts/, 'the blend weight is carried by the stat, not by a paragraph');
  assert.match(five, /Every level is allowance left[^<]*Below 0% is demand beyond the allowance/, 'the scale states its direction before the readings, not after them');
  assert.match(five, /Projected left at reset<\/span><span[^>]*>53\.6%</, 'the stat is the remaining figure its label promises, and the one the chart draws');
  assert.match(five, /46\.4% of the allowance used/, 'the caption keeps the consumed side of the same fact');
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
  assert.match(codex, /70\.0% used · window has reset/, 'the consumed caption is explicit and does not invert');
  assert.match(codex.slice(codex.indexOf('data-testid="window-codex_spark:10080"')), fill('30'), 'an expired window still draws what was left of it');
  assert.match(codex, /· Spark</);
});

test('an OAuth fallback alert is labelled OAuth failed, not identity', () => {
  const html = render(false, [], { 'claude-a': ['Claude OAuth usage failed on desk: Observatory fell back to the statusline hook.'] });
  const card = html.slice(html.indexOf('data-testid="account-claude-a"'), html.indexOf('data-testid="account-codex-b"'));
  assert.match(card, />OAuth failed</);
  assert.doesNotMatch(card, />identity</);
  assert.match(card, /fell back to the statusline hook/);
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
  const view = windowOf(rows);
  assert.deepEqual([view.state, view.pace?.observed_at, view.historyOnlyRows, view.cycles.length], ['expired', '2026-09-10T09:00:00Z', 2, 3]);
  const html = renderToStaticMarkup(createElement(AllowanceBurnChart, { pace: view.pace, cycles: view.cycles, history: view.history, timezone: TZ }));
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /forecast unavailable; 2 other cycles shown faint/);
  // Points consumed over an elapsed span is a total, not a level, so the inversion stops before it.
  assert.match(html, />Open cycle, reset Sep 10, 12:00 PM: 13\.0 points over 0\.8h</, 'the newer history-only cycle is drawn, not dropped');
  assert.match(html, />Completed cycle, reset Sep 9, 7:00 AM/);
  assert.doesNotMatch(html, /points left/, 'cycle totals stay consumption');
  assert.doesNotMatch(html, /Recent cycles seed/, 'a stale reading pauses the forecast, so no seed line or band is drawn');
  assert.doesNotMatch(html, /Recent cycles spread/);
  assert.match(html, /aria-label="Sep 10, 4:00 AM: 85\.0% left via statusline"/);
  assert.match(html, /Cycle start Sep 10, 2:00 AM, reset Sep 10, 7:00 AM\./, 'the mirror names the cycle the chart plots between');
  assert.match(html, /data-slot="chart"[^>]*aria-hidden/, 'the drawn SVG is decoration; the mirror beside it is what is announced');
});

// Recharts measures a container before it draws anything, so renderToStaticMarkup emits no SVG and
// none of the plotted values reach the markup. `burnSeries` is where the direction of every line is
// decided, so it is asserted directly: without this, re-inverting the whole chart still ships green.
test('every plotted series descends: full at the cycle start, empty at the reset', () => {
  const view = windowOf(quotas.filter(row => row.account_id === 'claude-a' && row.window_key === 'five_hour'));
  const series = burnSeries({ pace: view.pace, cycles: view.cycles });
  assert.equal(series.rows[0].phase, 0);
  assert.equal(series.rows[0].even, 100, 'the even-pace guide starts on a full allowance');
  assert.equal(series.rows.at(-1)!.phase, 1);
  assert.equal(series.rows.at(-1)!.even, 0, 'and reaches empty at the reset, a descending diagonal');

  const recorded = series.rows.filter(row => row.current !== null).map(row => row.current!);
  assert.deepEqual(recorded, [95, 88, 40], '5%, 12% and 60% used are 95%, 88% and 40% left');
  assert.ok(recorded.every((value, index) => index === 0 || value <= recorded[index - 1]), `the recorded line never climbs: ${recorded}`);
  assert.deepEqual(series.rows.filter(row => row.past[0] !== null).map(row => row.past[0]), [90, 70], 'a completed cycle at 30% used plots 70');

  const observed = series.rows.find(row => row.phase === series.observedPhase)!;
  assert.equal(observed.current, view.pace!.remaining, 'the newest reading is what is left, 88, not the 12 it consumed');
  assert.equal(observed.projected, view.pace!.remaining, 'and the projection leaves that point without a step');
  assert.equal(series.rows.at(-1)!.projected!.toFixed(1), '53.6', 'ending where the stat and the group label say it ends');
  assert.ok(series.rows.at(-1)!.projected! < observed.projected!, 'the projection descends');
  assert.deepEqual([series.axisFloor, series.yTicks], [0, [0, 50, 100]], 'nothing overruns, so the axis keeps its old range');
});

test('an overrun sinks below the empty floor and takes the axis with it', () => {
  const view = windowOf([fiveHour('2026-09-10T13:00:00Z', 5), fiveHour('2026-09-10T13:40:00Z', 45)]);
  const series = burnSeries({ pace: view.pace, cycles: view.cycles });
  assert.equal(series.projectedLeft, -145, 'demand past the allowance is negative remaining, not 245% used');
  assert.equal(series.rows.at(-1)!.projected, -145);
  assert.equal(series.axisFloor, -150, 'the axis grows downward to hold it');
  assert.deepEqual(series.yTicks, [-150, 0, 50, 100], 'and still tops out at a full allowance');
  assert.equal(series.rows.at(-1)!.even, 0, 'the even-pace guide still lands on the empty floor');
});

test('the forecast band runs floor first, because the fastest burn leaves the least', () => {
  // Three completed cycles at 5, 15 and 10 points/hour, so the quartiles differ and the band is not degenerate.
  const cycle = (day: string, step: number) => [
    fiveHour(`${day}T07:30:00Z`, 5, `${day}T12:00:00Z`),
    fiveHour(`${day}T09:30:00Z`, 5 + step, `${day}T12:00:00Z`),
    fiveHour(`${day}T11:30:00Z`, 5 + step * 2, `${day}T12:00:00Z`),
  ];
  const rows = [...cycle('2026-09-08', 10), ...cycle('2026-09-09', 30), ...cycle('2026-09-10', 20), fiveHour('2026-09-10T13:00:00Z', 4), fiveHour('2026-09-10T13:40:00Z', 8)];
  const html = renderOne(rows);
  // Pinned, not merely ordered: a band reverted to consumption space is still ascending, and both edges
  // sitting at or below the 92% the window is at now is what tells the two spaces apart.
  assert.match(html, /Recent cycles spread 42\.0% to 58\.7% left by reset\./);
  const view = windowOf(rows);
  const series = burnSeries({ pace: view.pace, cycles: view.cycles });
  const band = series.rows.at(-1)!.band!;
  assert.ok(band[0] < band[1], `the low edge comes from the high burn rate: ${band}`);
  assert.equal(band[0], 42);
  assert.equal(band[1].toFixed(1), '58.7');
  assert.ok(band.every(edge => edge <= view.pace!.remaining), `the band only descends from the 92% left now: ${band}`);
  assert.match(html, /role="meter"[^>]*aria-valuenow="92"/);
  assert.doesNotMatch(html, /NaN/);
});

test('the tooltip names every level as what is left, including the rows with no reading to anchor them', () => {
  const row: Row = { phase: 1, at: '2026-09-10T17:00:00Z', reading: null, current: null, past: [62], even: 0, seed: 41.2, projected: 12.5, band: [10.4, 20.6] };
  const others = [{ key: 'c1', resetAt: '2026-09-03T12:00:00Z' }] as unknown as QuotaCycle<LiveQuota>[];
  const tip = renderToStaticMarkup(createElement(BurnTooltip, { active: true, payload: [{ payload: row }], timezone: TZ, others }));
  assert.match(tip, />Projected left<\/span><span[^>]*>12\.5%</);
  assert.match(tip, />Recent cycles<\/span><span[^>]*>41\.2% left</, 'the seed row says which direction it runs, like the rows around it');
  assert.match(tip, />Spread left<\/span><span[^>]*>10\.4–20\.6%</);
  assert.match(tip, />Even pace left<\/span><span[^>]*>0%</);
  assert.match(tip, />Cycle to Sep 3<\/span><span[^>]*>62\.0% left</, 'a past cycle changed meaning with the inversion, so it had to change wording too');

  const reading = { id: 'r1', account_id: 'claude-a', window_key: 'five_hour', label: 'Claude · 5h', observed_at: '2026-09-10T13:40:00Z', used_percent: 12, resets_at: '2026-09-10T17:00:00Z', window_minutes: 300, reader: 'statusline' } as LiveQuota;
  const live = renderToStaticMarkup(createElement(BurnTooltip, { active: true, payload: [{ payload: { ...row, reading } }], timezone: TZ, others }));
  assert.match(live, />Left<\/span><span[^>]*>88\.0%</, '12% used is 88% left');
  assert.doesNotMatch(live, /Projected left|Even pace left/, 'a phase with a reading shows the reading, not the continuations');
});

// The meter is a depleting gauge, so the two ends of its range are the regression fence: the old
// direction drew these exactly backwards and never exercised the empty end at all.
test('the meter starts full and empties: an untouched window is a full bar, an exhausted one is empty', () => {
  const fresh = renderOne([fiveHour('2026-09-10T13:00:00Z', 0), fiveHour('2026-09-10T13:40:00Z', 0)]);
  assert.match(fresh, /role="meter"[^>]*aria-valuenow="100"/);
  assert.match(fresh, fill('100'), 'nothing spent yet, so the whole bar is still there');
  assert.match(fresh, /100% left by reset/);
  assert.doesNotMatch(fresh, /NaN/);

  const spent = renderOne([fiveHour('2026-09-10T13:00:00Z', 80), fiveHour('2026-09-10T13:40:00Z', 100)]);
  assert.match(spent, /role="meter"[^>]*aria-valuenow="0"/);
  assert.match(spent, /role="meter"[\s\S]{0,400}?bg-destructive\/20"><span[^>]*style="width:0%"/, 'the fill is gone, so the track carries the alarm; an empty bar is not a calm one');
  assert.match(spent, /This allowance is fully used/);
  assert.doesNotMatch(spent, /NaN/);
});

test('an over-consuming forecast clamps the drawn width and keeps the warning on the real figure', () => {
  // 40 points in 40 minutes against 3h20m left: the window is spent long before its reset.
  const html = renderOne([fiveHour('2026-09-10T13:00:00Z', 5), fiveHour('2026-09-10T13:40:00Z', 45)]);
  assert.match(html, /role="meter"[^>]*aria-valuenow="55"/, '55 points are still left, whatever the forecast says');
  assert.match(html, /role="meter"[^>]*aria-valuetext="55\.0% left, 45\.0% used, projected 145% short by reset"/);
  // The alarm is on the track as well as the fill, so it survives the fill shrinking to nothing, and
  // the fill is hatched rather than solid red: the reserve is doomed, not itself the bad news.
  assert.match(html, /role="meter"[\s\S]{0,400}?bg-destructive\/20"><span[^>]*var\(--destructive\)[^>]*style="width:55%"/);
  assert.doesNotMatch(html, /width:-/, 'a drawn width is never negative');
  assert.match(html, /145% short by reset/, 'a shortfall is named, never printed as a bare negative percentage');
  assert.match(html, /Projected left at reset<\/span><span[^>]*text-destructive[^>]*>145\.0% short</, 'and the stat under the same label spells it the same way');
  assert.doesNotMatch(html, />-\d/, 'no figure on the card is a bare negative');
  assert.match(html, /projected 145\.0% beyond the allowance by reset/);
  assert.match(html, /145\.0 pts over/, 'overage magnitude stays consumption');
  assert.doesNotMatch(html, /NaN/);
});

test('a shortfall under a point is still a shortfall, and a fractional reading carries no float tail', () => {
  // 0.05 points in 40 minutes with 3h20m to go: the forecast crosses the allowance by a fraction.
  const sliver = renderOne([fiveHour('2026-09-10T13:00:00Z', 99.9), fiveHour('2026-09-10T13:40:00Z', 99.95)]);
  assert.match(sliver, /0\.2% short by reset/, 'rounding this to "0% short" would deny the warning printed above it');
  assert.doesNotMatch(sliver, /0% short by reset/);
  assert.match(sliver, /Projected left at reset<\/span><span[^>]*>0\.2% short</);

  const frac = renderOne([fiveHour('2026-09-10T13:00:00Z', 5), fiveHour('2026-09-10T13:40:00Z', 8.04)]);
  assert.match(frac, /role="meter"[^>]*aria-valuenow="92"/, '91.96000000000001 is rounded once, before it reaches the DOM');
  assert.match(frac, fill('92'));
  assert.match(frac, /role="meter"[^>]*aria-valuetext="92\.0% left, 8\.0% used/);
  assert.doesNotMatch(frac, /width:\d+\.\d{3,}%/, 'no drawn width carries a float tail');
});

test('a window with too little evidence says so rather than drawing a projection', () => {
  const html = renderOne([fiveHour('2026-09-10T13:55:00Z', 4), fiveHour('2026-09-10T14:00:00Z', 6)]);
  assert.match(html, />learning pace</);
  assert.match(html, /no projection yet · observed/, 'fresh but unforecastable is not the same as stale');
  assert.match(html, /role="meter"[^>]*aria-valuetext="94\.0% left, 6\.0% used"/, 'with no projection the widget claims none');
  assert.match(html, fill('94'), 'the level is still drawn from what is left');
  assert.match(html, /At least 30 minutes of readings in this reset window are needed/);
  assert.doesNotMatch(html, /NaN/);
});
