import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RequestError } from '../lib/contracts';
import { validate } from '../lib/contract-validator.mjs';
import { digest } from '../lib/crypto';
import { producerForToken } from '../lib/producer-credentials';
import { parsePullRequestUrl, prWatchContracts, runnerReport, runnerWork } from '../lib/pr-watch-contract';

// The board's half of PR watch: which links become watches, what a runner report may say, and who may
// call the runner routes. The runner's decisions are tested in kit-pr-watch/, against the copies of the
// two contracts below, so these tests also check the zod source and those JSON Schemas agree.

const NOW = new Date('2026-09-24T12:00:00.000Z');
const A = 'a'.repeat(40);
const generated = (id: keyof typeof prWatchContracts) => JSON.parse(readFileSync(`lib/generated/contracts/${id}.schema.json`, 'utf8'));

test('a pasted pull request link resolves to one watch however it was copied', () => {
  const ref = { owner: 'acme', repo: 'app.web', number: 42 };
  for (const url of [
    'https://github.com/acme/app.web/pull/42',
    '  https://github.com/acme/app.web/pull/42/  ',
    'https://www.github.com/acme/app.web/pull/42',
    'https://github.com/acme/app.web/pull/42/files',
    'https://github.com/acme/app.web/pull/42/commits/abc1234',
    'https://github.com/acme/app.web/pull/42?notification_referrer_id=x#discussion_r1',
  ]) assert.deepEqual(parsePullRequestUrl(url), ref, url);
});

test('only github.com pull request links are accepted', () => {
  for (const url of [
    'not a link',
    'http://github.com/acme/app/pull/42',
    'https://gitlab.com/acme/app/pull/42',
    'https://github.com.evil.example/acme/app/pull/42',
    'https://user:pass@github.com/acme/app/pull/42',
    'https://github.com:8443/acme/app/pull/42',
    'https://github.com/acme/app/issues/42',
    'https://github.com/acme/app/pull/0',
    'https://github.com/acme/app/pull/42x',
    'https://github.com/acme/app/pull',
    'https://github.com/acme/../pull/42',
    'https://github.com/-acme/app/pull/42',
    'https://github.com/acme/app/pull/99999999999',
  ]) assert.throws(() => parsePullRequestUrl(url), RequestError, url);
});

test('runner reports are strict, bounded, and cleaned of control characters', () => {
  const checked_at = NOW.toISOString();
  assert.equal(runnerReport.parse({ checked_at, note: 'line one\nline\u0007two' }).note, 'line one line two');
  assert.equal(runnerReport.parse({ checked_at, error: null }).error, null, 'null clears an error');
  assert.equal(runnerReport.parse({ checked_at, author_login: 'dependabot[bot]' }).author_login, 'dependabot[bot]');
  assert.ok(runnerReport.parse({ checked_at, review: { event: 'started', session: 'bg_1a2b', target_sha: A, started_at: checked_at } }).review);
  assert.equal(runnerReport.parse({ checked_at, status: 'stopped' }).status, 'stopped', 'an address watch on a PR the owner did not open ends');
  const addressed = runnerReport.parse({ checked_at, comments_through: checked_at, comments_pending: 0,
    review: { event: 'addressed', finished_at: checked_at, outcome: 'needs_you', summary: 'Fixed the test name.\r\n\n\n\nQuestions for you:\n- Keep\u0007 the fallback?', url: null } }).review;
  assert.equal(addressed?.event === 'addressed' && addressed.summary, 'Fixed the test name.\n\nQuestions for you:\n- Keep  the fallback?', 'a summary keeps its line breaks and loses control characters');
  for (const bad of [
    {},
    { checked_at, extra: true },
    { checked_at, status: 'paused' },
    { checked_at, comments_pending: -1 },
    { checked_at, comments_through: 'yesterday' },
    { checked_at, review: { event: 'addressed', finished_at: checked_at, outcome: 'merged', summary: '', url: null } },
    { checked_at, review: { event: 'addressed', finished_at: checked_at, outcome: 'pushed', summary: 'x'.repeat(2001), url: null } },
    { checked_at, review: { event: 'addressed', finished_at: checked_at, outcome: 'pushed', summary: '', url: 'https://evil.example/compare' } },
    { checked_at, head_sha: 'abc1234' },
    { checked_at, head_fingerprint: 'f'.repeat(63) },
    { checked_at, note: 'x'.repeat(501) },
    { checked_at, review: { event: 'posted', finished_at: checked_at, url: 'https://evil.example/review' } },
    { checked_at, review: { event: 'started', session: 'has space', target_sha: A, started_at: checked_at } },
    { checked_at, review: { event: 'cancelled', finished_at: checked_at } },
  ]) {
    assert.equal(runnerReport.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(validate(bad, generated('pr-watch-report-v1')).valid, false, `the kit's copy refuses it too: ${JSON.stringify(bad)}`);
  }
});

test('the work list the runner reads matches its published schema, and new keys do not break it', () => {
  const schema = generated('pr-watch-work-v1');
  const example = () => structuredClone(prWatchContracts['pr-watch-work-v1'].example) as unknown as { watches: Record<string, unknown>[] } & Record<string, unknown>;
  const added = example();
  added.watches[0].labels = ['ready'];
  added.cursor = 'next';
  assert.equal(runnerWork.safeParse(added).success, true, 'the board may add a field before the runner reads it');
  assert.deepEqual(validate(added, schema), { valid: true, issues: [] });
  const unkinded = example();
  delete unkinded.watches[0].kind;
  const paused = example();
  paused.watches[1].status = 'paused';
  for (const [body, path] of [[unkinded, ['watches', 0, 'kind']], [paused, ['watches', 1, 'status']]] as const) {
    assert.equal(runnerWork.safeParse(body).success, false);
    assert.deepEqual(validate(body, schema).issues.map(issue => issue.path), [path]);
  }
});

test('the runner key is scoped to the pr-watch kind', () => {
  const primary = JSON.stringify({ 'pr-watch': { hash: digest('runner-key'), kinds: ['pr-watch'] }, monthly: { hash: digest('usage-key'), kinds: ['usage'] } });
  assert.equal(producerForToken('runner-key', 'pr-watch', primary), 'pr-watch');
  assert.equal(producerForToken('runner-key', 'usage', primary), undefined, 'the runner key cannot publish usage');
  assert.equal(producerForToken('usage-key', 'pr-watch', primary), undefined, 'a usage key cannot read the queue');
});

test('the edge proxy admits the runner routes and still gates the queue page API', async () => {
  const { proxy } = await import('../proxy');
  const { NextRequest } = await import('next/server');
  const bearer = { authorization: 'Bearer example-runner-key' };
  const status = (method: string, path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`http://localhost${path}`, { method, headers })).status;
  const id = '00000000-0000-4000-8000-000000000007';
  // The handlers check the producer key themselves (requireProducer with the pr-watch kind).
  assert.equal(status('GET', '/api/v1/pr-watches?machine=mac&version=1.0.0', bearer), 200);
  assert.equal(status('POST', `/api/v1/pr-watches/${id}`, bearer), 200);
  assert.equal(status('POST', '/api/v1/pr-watches', bearer), 401, 'only the documented methods are admitted');
  assert.equal(status('GET', `/api/v1/pr-watches/${id}`, bearer), 401);
  assert.equal(status('GET', '/api/pr-watches', bearer), 401, 'the page API needs the session cookie');
  assert.equal(status('POST', '/api/pr-watches'), 401);
  assert.equal(status('PATCH', `/api/pr-watches/${id}`), 401);
  assert.equal(status('GET', '/reviews'), 307, 'the page redirects to sign-in');
});
