import assert from 'node:assert/strict';
import test from 'node:test';
import { createResetFeedFetcher } from '../lib/reset-feed-fetch';
import { normalizeNextReset, resetFeedCoverageNotes } from '../lib/nextreset-feeds';
import { activeResetFeeds, feedSources, isFeedSource, nextResetUrls, RESET_NORMALIZATION_VERSION, type FeedSource } from '../lib/reset-feeds';
import { resetDay } from '../lib/reset-calendar';

// Synthetic partial records, not a raw export. Shape checked against the public
// https://nextreset.net/api/resets and /api/status on 2026-09-12.
const at = '2026-09-12T12:00:00.000Z';
const item = (id: string, kind = 'regular', scope = 'unspecified', sourceKind = 'x_post') => ({
  id, kind, scope, sourceKind, announcedAt: at, sourceUrl: `https://example.com/posts/${id}`,
  title: { en: `Synthetic ${kind} announcement` }, summary: { en: 'Synthetic scope context.' },
});
const meta = { checked_at: at, upstream_generated_at: at, fresh: true, saved_snapshot: false,
  x_source: { checked_at: at, fresh: true, coverage: { posts: true, replies: true, caughtUp: true } } };
const archive = { data: [item('regular'), item('broad', 'regular', 'broad'), item('observed', 'regular', 'broad', 'observed'),
  item('banked', 'banked', 'broad'), item('credits', 'compensation', 'limited'), item('mixed', 'mixed', 'broad')], meta };
const status = { latest_update: archive.data[0], scheduled: null, meta };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'content-type': 'application/json', etag: 'test-etag' } });
const saved = { version: String(RESET_NORMALIZATION_VERSION), current_hash: 'saved', etag: 'primary-etag', last_modified: 'old-date' };

test('NextReset retains history, publication time, scope and distinct credit categories', () => {
  const doc = normalizeNextReset('nextreset-timeline', archive, status);
  assert.equal(doc.items.length, 6);
  assert.deepEqual(doc.items.map(i => i.reset_kind), ['reset', 'global', 'global', 'banked', 'credits', 'credits']);
  assert.deepEqual(doc.items.map(i => i.category), ['history', 'history', 'history', 'announcement', 'announcement', 'announcement']);
  assert.equal(doc.items[2].status, 'archive observation');
  assert.equal(doc.items[0].effective_at, null);
  assert.equal(doc.items[3].banked_state, 'announced');
  assert.equal(doc.provenance, 'nextreset');
  assert.equal(doc.normalization_version, RESET_NORMALIZATION_VERSION);
  assert.deepEqual(resetFeedCoverageNotes(doc, Date.parse(at)), []);
});

test('announcement stream excludes archive observations and includes latest reviewed update', () => {
  const doc = normalizeNextReset('nextreset-announcements', archive, { ...status, latest_update: item('new') });
  assert.equal(doc.items.length, 6);
  assert.ok(doc.items.every(i => i.category === 'announcement'));
  assert.ok(doc.items.some(i => i.id === 'new'));
  assert.ok(!doc.items.some(i => i.id === 'observed'));
});

test('pending records remain announcements after their publication time; unknown shape is a visible gap', () => {
  // A synthetic scheduled value exercises supported record fields, not a claim
  // about a currently active pending announcement (live scheduled was null).
  const doc = normalizeNextReset('nextreset-timeline', archive, { ...status, scheduled: item('pending', 'regular', 'broad') });
  const pending = doc.items.find(i => i.id === 'pending')!;
  assert.equal(pending.category, 'announcement');
  assert.equal(pending.status, 'pending announcement');
  assert.equal(resetDay(pending), at.slice(0, 10));
  const unknown = normalizeNextReset('nextreset-announcements', archive, { ...status, scheduled: { unknown: true } });
  assert.equal(unknown.coverage?.pending_unavailable, true);
  assert.match(resetFeedCoverageNotes(unknown, Date.parse(at)).join(), /Pending announcement format unavailable/);
});

test('fresh archive does not imply complete direct-post review; check age is not event age', () => {
  const doc = normalizeNextReset('nextreset-timeline', { ...archive, meta: { ...meta, x_source: { ...meta.x_source, fresh: false } } }, status);
  assert.equal(doc.upstream_stale, false);
  assert.match(resetFeedCoverageNotes(doc, Date.parse(at)).join(), /review delayed or incomplete/);
  assert.match(resetFeedCoverageNotes(doc, Date.parse(at) + 46 * 60_000).join(), /Archive sync delayed/);
  const stale = normalizeNextReset('nextreset-timeline', archive, { ...status, meta: { ...meta, fresh: false } });
  assert.equal(stale.upstream_stale, true);
});

test('invalid archive schemas and unsafe records fail closed without silently replacing good data', () => {
  for (const bad of [{}, { data: null, meta }, { data: [{ ...item('bad'), sourceUrl: 'javascript:alert(1)' }], meta },
    { data: [{ ...item('bad'), sourceUrl: 'https://user:secret@example.com' }], meta },
    { data: [{ ...item('bad'), announcedAt: 'invalid' }], meta }, { data: [item('bad', 'unknown')], meta }]) {
    assert.throws(() => normalizeNextReset('nextreset-timeline', bad, status), /schema changed/);
  }
  assert.throws(() => normalizeNextReset('nextreset-timeline', archive, {}), /schema changed/);
});


test('only active public feeds are served, including when retired state still has errors', () => {
  const rows = [
    { source: 'codex-timeline', error: 'v5:http_403', payload: { provenance: 'nextreset', primary_error: 'http_403' } },
    { source: 'codex-announcements', error: 'v5:http_403', payload: null },
    { source: 'codex-forecast', error: 'v5:http_403', payload: { forecast: { probability24: 24 } } },
    ...Object.keys(feedSources).map(source => ({ source, error: null, payload: null })),
    { source: 'constructor', error: 'unknown', payload: null },
  ];
  const result = activeResetFeeds(rows);
  assert.deepEqual(result.map(f => f.source), ['nextreset-timeline', 'nextreset-announcements', 'claude-radar']);
  assert.equal(result[0].label, 'NextReset · history');
  assert.equal(result[1].url, nextResetUrls.status);
  assert.ok(result.every(f => !f.error));
  assert.equal(rows.length, 7); // Filtering is not deletion of saved history.
  assert.equal(isFeedSource('__proto__'), false);
});

test('all active feeds fetch only unauthenticated public URLs, with one shared NextReset snapshot', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const run = createResetFeedFetcher(async (input, options) => {
    const url = String(input); calls.push({ url, options });
    assert.ok([nextResetUrls.archive, nextResetUrls.status, feedSources['claude-radar'].url].includes(url as typeof nextResetUrls.archive));
    return json(url === nextResetUrls.archive ? archive : url === nextResetUrls.status ? status : { items: [] });
  });
  const results = await Promise.all((Object.keys(feedSources) as FeedSource[]).map(source => run(source)));
  assert.equal(calls.length, 3);
  assert.deepEqual(new Set(calls.map(c => c.url)), new Set([nextResetUrls.archive, nextResetUrls.status, feedSources['claude-radar'].url]));
  assert.ok(results.every(r => 'payload' in r && !('primary_error' in r.payload)));
  for (const call of calls) {
    assert.equal(call.options?.redirect, 'error'); assert.equal(call.options?.cache, 'no-store');
    assert.equal(call.options?.credentials, 'omit'); assert.ok(call.options?.signal);
    assert.equal(new Headers(call.options?.headers).get('authorization'), null);
    assert.equal(new Headers(call.options?.headers).get('cookie'), null);
  }
});

test('retired and unknown sources are rejected before any network call', async () => {
  let count = 0;
  const run = createResetFeedFetcher(async () => { count++; throw new Error('Unexpected network call'); });
  for (const key of ['codex-timeline', 'codex-announcements', 'codex-forecast', 'constructor', '__proto__']) {
    await assert.rejects(run(key as FeedSource), /Inactive feed source/);
  }
  assert.equal(count, 0);
});

test('combined NextReset documents never reuse old origin or single-response validators', async () => {
  const run = createResetFeedFetcher(async (input, options) => {
    assert.equal(new Headers(options?.headers).get('if-none-match'), null);
    assert.equal(new Headers(options?.headers).get('if-modified-since'), null);
    return json(String(input) === nextResetUrls.archive ? archive : status);
  });
  const result = await run('nextreset-timeline', saved);
  assert.ok('payload' in result);
  assert.equal(result.payload.provenance, 'nextreset');
  assert.equal(result.etag, null); assert.equal(result.last_modified, null);
});

test('Claude retains conditional requests only for current saved revisions', async () => {
  const run = createResetFeedFetcher(async (input, options) => {
    assert.equal(String(input), feedSources['claude-radar'].url);
    assert.equal(new Headers(options?.headers).get('if-none-match'), 'primary-etag');
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(await run('claude-radar', saved), { unchanged: true });
  const old = createResetFeedFetcher(async (_input, options) => {
    assert.equal(new Headers(options?.headers).get('if-none-match'), null);
    return json({ items: [] });
  });
  const result = await old('claude-radar', { ...saved, version: '5' });
  assert.ok('payload' in result); assert.equal(result.etag, 'test-etag');
});

test('NextReset failures propagate without retrying the removed provider or inventing a replacement', async () => {
  for (const code of [403, 503]) {
    const urls: string[] = [];
    const run = createResetFeedFetcher(async input => { urls.push(String(input)); return new Response(null, { status: code }); });
    await assert.rejects(run('nextreset-timeline'), new RegExp('http_' + code));
    await assert.rejects(run('nextreset-announcements'), new RegExp('http_' + code));
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.startsWith('https://nextreset.net/')));
  }
  const timedOut = createResetFeedFetcher(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
  await assert.rejects(timedOut('nextreset-timeline'), { name: 'TimeoutError' });
});

test('public feed fetches enforce schema, content type, size and JSON bounds', async () => {
  for (const response of [() => json({}), () => new Response('<html>bad</html>'),
    () => new Response('a'.repeat(2_000_001), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } })]) {
    const run = createResetFeedFetcher(async () => response());
    await assert.rejects(run('nextreset-timeline'));
  }
  const run = createResetFeedFetcher(async () => json({}));
  await assert.rejects(run('claude-radar'), /schema changed/);
});

test('retired provider URLs and fallback UI are absent from active reset code', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const path of ['lib/reset-feeds.ts', 'lib/reset-feed-fetch.ts', 'lib/reset-feed-store.ts', 'lib/nextreset-feeds.ts', 'components/reset-record.tsx']) {
    const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.ok(!source.includes('codex-reset.com'), path);
    assert.ok(!source.includes('primary_error'), path);
    assert.ok(!source.includes('available via fallback'), path);
  }
});
