import assert from 'node:assert/strict';
import test from 'node:test';
import { createResetFeedFetcher } from '../lib/reset-feed-fetch';
import { nextResetUrls, normalizeNextReset, resetFeedCoverageNotes, resetFeedDefinition } from '../lib/reset-feed-fallback';
import { feedSources, RESET_NORMALIZATION_VERSION } from '../lib/reset-feeds';
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
const primary = { events: [{ id: 'primary', type: 'reset', summary: 'Synthetic primary', date: at, url: 'https://example.com/primary' }] };
const saved = { version: String(RESET_NORMALIZATION_VERSION), current_hash: 'saved', etag: 'primary-etag', last_modified: 'old-date' };

test('fallback retains history, publication time, scope and distinct credit categories', () => {
  const doc = normalizeNextReset('codex-timeline', archive, status);
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
  const doc = normalizeNextReset('codex-announcements', archive, { ...status, latest_update: item('new') });
  assert.equal(doc.items.length, 6);
  assert.ok(doc.items.every(i => i.category === 'announcement'));
  assert.ok(doc.items.some(i => i.id === 'new'));
  assert.ok(!doc.items.some(i => i.id === 'observed'));
});

test('pending records remain announcements after their publication time; unknown shape is a visible gap', () => {
  // A synthetic scheduled value exercises supported record fields, not a claim
  // about a currently active pending announcement (live scheduled was null).
  const doc = normalizeNextReset('codex-timeline', archive, { ...status, scheduled: item('pending', 'regular', 'broad') });
  const pending = doc.items.find(i => i.id === 'pending')!;
  assert.equal(pending.category, 'announcement');
  assert.equal(pending.status, 'pending announcement');
  assert.equal(resetDay(pending), at.slice(0, 10));
  const unknown = normalizeNextReset('codex-announcements', archive, { ...status, scheduled: { unknown: true } });
  assert.equal(unknown.coverage?.pending_unavailable, true);
  assert.match(resetFeedCoverageNotes(unknown, Date.parse(at)).join(), /Pending announcement format unavailable/);
});

test('fresh archive does not imply complete direct-post review; check age is not event age', () => {
  const doc = normalizeNextReset('codex-timeline', { ...archive, meta: { ...meta, x_source: { ...meta.x_source, fresh: false } } }, status);
  assert.equal(doc.upstream_stale, false);
  assert.match(resetFeedCoverageNotes(doc, Date.parse(at)).join(), /review delayed or incomplete/);
  assert.match(resetFeedCoverageNotes(doc, Date.parse(at) + 46 * 60_000).join(), /Archive sync delayed/);
  const stale = normalizeNextReset('codex-timeline', archive, { ...status, meta: { ...meta, fresh: false } });
  assert.equal(stale.upstream_stale, true);
});

test('invalid archive schemas and unsafe records fail closed without silently replacing good data', () => {
  for (const bad of [{}, { data: null, meta }, { data: [{ ...item('bad'), sourceUrl: 'javascript:alert(1)' }], meta },
    { data: [{ ...item('bad'), sourceUrl: 'https://user:secret@example.com' }], meta },
    { data: [{ ...item('bad'), announcedAt: 'invalid' }], meta }, { data: [item('bad', 'unknown')], meta }]) {
    assert.throws(() => normalizeNextReset('codex-timeline', bad, status), /schema changed/);
  }
  assert.throws(() => normalizeNextReset('codex-timeline', archive, {}), /schema changed/);
});

test('saved provenance controls attribution, without relabeling existing primary snapshots', () => {
  assert.equal(resetFeedDefinition('codex-timeline').label, 'Codex Reset · history');
  const doc = normalizeNextReset('codex-timeline', archive, status);
  assert.equal(resetFeedDefinition('codex-timeline', doc).label, 'NextReset · history');
  assert.equal(resetFeedDefinition('codex-announcements', doc).url, nextResetUrls.status);
  assert.equal(resetFeedDefinition('codex-forecast', doc).label, 'Codex Reset · forecast');
});

test('two primary HTTP 403s share one bounded fallback snapshot and clear origin validators', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); calls.push({ url, options });
    return url === nextResetUrls.archive ? json(archive) : url === nextResetUrls.status ? json(status) : new Response('Denied', { status: 403 });
  };
  const run = createResetFeedFetcher(fetcher);
  const results = await Promise.all([run('codex-timeline', saved), run('codex-announcements', saved)]);
  assert.equal(calls.length, 4);
  for (const result of results) {
    assert.ok('payload' in result);
    assert.equal(result.payload.primary_error, 'http_403');
    assert.equal(result.payload.provenance, 'nextreset');
    assert.equal(result.etag, null); assert.equal(result.last_modified, null);
  }
  for (const call of calls) {
    assert.equal(call.options?.redirect, 'error'); assert.equal(call.options?.cache, 'no-store');
    assert.equal(call.options?.credentials, 'omit'); assert.ok(call.options?.signal);
    if (call.url.startsWith('https://nextreset.net/')) assert.equal(new Headers(call.options?.headers).get('if-none-match'), null);
  }
});

test('healthy primary avoids fallback; recovery never reuses fallback validators', async () => {
  let count = 0;
  const run = createResetFeedFetcher(async (input, options) => {
    count++; assert.equal(String(input), feedSources['codex-timeline'].url);
    assert.equal(new Headers(options?.headers).get('if-none-match'), null);
    return json(primary);
  });
  const result = await run('codex-timeline', { ...saved, provenance: 'nextreset' });
  assert.ok('payload' in result); assert.equal(result.payload.provenance, undefined);
  assert.equal(result.etag, 'test-etag'); assert.equal(count, 1);
});

test('304 reuses only a current primary revision', async () => {
  const run = createResetFeedFetcher(async (_input, options) => {
    assert.equal(new Headers(options?.headers).get('if-none-match'), 'primary-etag');
    return new Response(null, { status: 304 });
  });
  assert.deepEqual(await run('codex-timeline', saved), { unchanged: true });
  const old = createResetFeedFetcher(async (_input, options) => {
    assert.equal(new Headers(options?.headers).get('if-none-match'), null);
    return json(primary);
  });
  assert.ok('payload' in await old('codex-timeline', { ...saved, version: '4' }));
});

test('both-source failures propagate and cannot produce a successful replacement payload', async () => {
  const run = createResetFeedFetcher(async input => new Response('Unavailable', { status: String(input).includes('nextreset') ? 503 : 403 }));
  await assert.rejects(run('codex-timeline'), /http_503/);
  await assert.rejects(run('codex-announcements'), /http_503/);
});

test('JSON schema failures use fallback; forecast and Claude do not switch providers', async () => {
  const run = createResetFeedFetcher(async input => String(input) === nextResetUrls.archive ? json(archive) : String(input) === nextResetUrls.status ? json(status) : json({}));
  const result = await run('codex-timeline');
  assert.ok('payload' in result); assert.equal(result.payload.primary_error, 'schema_changed');
  await assert.rejects(run('codex-forecast'), /schema changed/);
  await assert.rejects(run('claude-radar'), /schema changed/);
});

test('fallback enforces content type, size and JSON bounds', async () => {
  for (const response of [() => new Response('<html>bad</html>'),
    () => new Response('a'.repeat(2_000_001), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } })]) {
    const run = createResetFeedFetcher(async input => String(input).includes('nextreset') ? response() : new Response(null, { status: 403 }));
    await assert.rejects(run('codex-timeline'));
  }
});
