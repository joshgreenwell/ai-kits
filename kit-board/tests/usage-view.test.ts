import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FILTERS, activeFilterChips, chartScale, clearedFilters, compositionView, customRangeFromDates, hourlyAllowed, hourlyPossible, intervalLabel, parseTokensFilters, queryString, rangeDates, seriesSummary, serializeTokensFilters, whenIn,
} from '../lib/usage-view';

test('the private URL round-trips the filter state and drops what it does not recognize', () => {
  assert.deepEqual(parseTokensFilters(new URLSearchParams('')), DEFAULT_FILTERS, 'a bare URL is the landing view: month to date, all accounts and projects, daily');
  const url = 'preset=last_7_days&accounts=claude-a,codex-b&accounts=claude-a&projects=no_project,0f7e1c2a-1111-4222-8333-444455556666&providers=claude,bogus&surfaces=cli&agent_scope=subagent&resolution=hour&timezone=Mars/Olympus&efforts=high';
  const parsed = parseTokensFilters(new URLSearchParams(url));
  assert.deepEqual([parsed.preset, parsed.accounts, parsed.projects, parsed.providers, parsed.surfaces, parsed.agent_scope, parsed.resolution, parsed.timezone, parsed.efforts],
    ['last_7_days', ['claude-a', 'codex-b'], ['0f7e1c2a-1111-4222-8333-444455556666', 'no_project'], ['claude'], ['cli'], 'subagent', 'hour', 'America/Chicago', ['high']], 'lists are deduplicated and sorted; unknown providers and zones are dropped');
  assert.equal(queryString(parsed), 'preset=last_7_days&resolution=hour&agent_scope=subagent&accounts=claude-a%2Ccodex-b&providers=claude&efforts=high&surfaces=cli&projects=0f7e1c2a-1111-4222-8333-444455556666%2Cno_project');
  assert.deepEqual(parseTokensFilters(serializeTokensFilters(parsed)), parsed, 'serialize then parse is the identity');
  const custom = parseTokensFilters(new URLSearchParams('preset=custom&start=2026-09-01T05:00:00.000Z&end=2026-09-08T05:00:00.000Z'));
  assert.deepEqual([custom.preset, custom.start, custom.end], ['custom', '2026-09-01T05:00:00.000Z', '2026-09-08T05:00:00.000Z']);
  assert.equal(parseTokensFilters(new URLSearchParams('preset=custom&start=2026-09-01T05:00:00.000Z')).preset, 'month_to_date', 'a custom preset without both bounds falls back');
  assert.deepEqual(parseTokensFilters(new URLSearchParams('preset=today&start=2026-09-01T05:00:00.000Z&end=2026-09-02T05:00:00.000Z')).start, null, 'bounds belong to the custom preset only');
  // A range the API cannot serve hourly reads as daily instead of failing the page.
  assert.equal(parseTokensFilters(new URLSearchParams('preset=last_30_days&resolution=hour')).resolution, 'day');
  assert.equal(parseTokensFilters(new URLSearchParams('preset=custom&resolution=hour&start=2026-08-01T05:00:00.000Z&end=2026-09-15T05:00:00.000Z')).resolution, 'day');
  assert.equal(parseTokensFilters(new URLSearchParams('preset=custom&resolution=hour&start=2026-09-01T05:00:00.000Z&end=2026-09-08T05:00:00.000Z')).resolution, 'hour');
  assert.deepEqual([hourlyPossible({ preset: 'previous_month', start: null, end: null }), hourlyPossible({ preset: 'today', start: null, end: null }), hourlyPossible({ preset: 'custom', start: null, end: null })], [false, true, false]);
  assert.equal(whenIn('2026-09-05T20:00:00.000Z', 'America/Chicago'), 'Sep 5, 3:00 PM'); assert.equal(whenIn(null, 'America/Chicago'), '—');
});

test('chips name every narrowing with its label and remove one value at a time', () => {
  const filters = { ...DEFAULT_FILTERS, accounts: ['claude-a', 'codex-b'], projects: ['no_project', 'p1'], agent_scope: 'main' as const, agents: ['a'.repeat(64)] };
  const chips = activeFilterChips(filters, { accounts: { 'claude-a': 'Claude personal' }, projects: { p1: 'Kit board' } });
  assert.deepEqual(chips.map(c => c.label), ['Account: Claude personal', 'Account: codex-b', 'Project: No project', 'Project: Kit board', 'Agent: agent aaaaaaaa', 'Main agent only']);
  assert.deepEqual(chips[0].next.accounts, ['codex-b']);
  assert.deepEqual(chips.at(-1)!.next.agent_scope, 'all');
  const cleared = clearedFilters({ ...filters, preset: 'previous_month', resolution: 'hour' });
  assert.deepEqual([cleared.accounts, cleared.projects, cleared.agent_scope, cleared.preset, cleared.resolution], [[], [], 'all', 'previous_month', 'hour'], 'clear all keeps the period and resolution');
});

test('composition reconciles to the headline, folds a reported-only remainder into unclassified, and withholds inconsistent shares', () => {
  const view = compositionView({ total_tokens: 1_000, composition: { input_fresh: 400, input_cached: 300, input_cache_write: 100, output: 150, reasoning: 60, unclassified: 0 } });
  assert.deepEqual(view.segments.map(s => [s.key, s.tokens, s.share]), [['input_fresh', 400, 0.4], ['input_cached', 300, 0.3], ['input_cache_write', 100, 0.1], ['output', 150, 0.15], ['unclassified', 50, 0.05]]);
  assert.deepEqual([view.remainder, view.inconsistent, view.reasoning_share_of_output], [50, false, 0.4]);
  assert.equal(view.segments.reduce((n, s) => n + s.tokens, 0), 1_000, 'segments sum to the total');
  const bad = compositionView({ total_tokens: 100, composition: { input_fresh: 90, input_cached: 20, input_cache_write: 0, output: 0, reasoning: null, unclassified: 0 } });
  assert.deepEqual([bad.inconsistent, bad.segments[0].share, bad.reasoning_share_of_output], [true, null, null]);
  assert.equal(compositionView({ total_tokens: 0, composition: { input_fresh: 0, input_cached: 0, input_cache_write: 0, output: 0, reasoning: null, unclassified: 0 } }).segments[0].share, null);
});

test('the chart scale, interval labels, series summary, and range helpers follow the display zone', () => {
  assert.deepEqual(chartScale([{ total_tokens: 0 }, { total_tokens: 1_500_000 }]).ticks.map(t => t.label), ['0', '750K', '1.5M']);
  assert.deepEqual(chartScale([]).ticks.map(t => t.label), ['0']);
  const tz = 'America/Chicago';
  assert.equal(intervalLabel({ start: '2026-09-02T05:00:00.000Z', end: '2026-09-03T05:00:00.000Z', state: 'observed' }, tz, 'day'), 'Wed, Sep 2');
  assert.equal(intervalLabel({ start: '2026-09-02T05:00:00.000Z', end: '2026-09-02T20:30:00.000Z', state: 'partial' }, tz, 'day'), 'Wed, Sep 2 · 00:00 to 15:30', 'a clipped day names both ends');
  assert.equal(intervalLabel({ start: '2026-09-02T14:00:00.000Z', end: '2026-09-02T15:00:00.000Z', state: 'observed' }, tz, 'hour'), 'Wed, Sep 2 · 09:00 to 10:00');
  const points = [
    { start: 'a', end: 'b', total_tokens: 10, calls: 1, composition: { input_fresh: 10, input_cached: 0, input_cache_write: 0, output: 0, reasoning: null, unclassified: 0 }, state: 'observed' as const, sources: ['buckets' as const] },
    { start: 'c', end: 'd', total_tokens: 0, calls: 0, composition: { input_fresh: 0, input_cached: 0, input_cache_write: 0, output: 0, reasoning: null, unclassified: 0 }, state: 'missing' as const, sources: [] },
  ];
  assert.deepEqual(seriesSummary(points), { counts: { observed: 1, zero: 0, missing: 1, partial: 0 }, total: 10, calls: 1, intervals: 2 });
  assert.equal(hourlyAllowed({ start: '2026-09-01T05:00:00Z', end: '2026-09-15T05:00:00Z' }), true);
  assert.equal(hourlyAllowed({ start: '2026-09-01T05:00:00Z', end: '2026-09-15T06:00:00Z' }), false);
  assert.deepEqual(customRangeFromDates('2026-09-01', '2026-09-07', tz), { start: '2026-09-01T05:00:00.000Z', end: '2026-09-08T05:00:00.000Z' }, 'the end date is inclusive');
  assert.equal(customRangeFromDates('2026-09-07', '2026-09-01', tz), null);
  assert.deepEqual(rangeDates({ start: '2026-09-01T05:00:00.000Z', end: '2026-09-08T05:00:00.000Z' }, tz), { start: '2026-09-01', end: '2026-09-07' });
});
