import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestError } from '../lib/contracts';
import { digest } from '../lib/crypto';
import { producerForToken } from '../lib/producer-credentials';
import { parsePullRequestUrl, runnerReport } from '../lib/pr-watch-contract';
import { aiReviewSha, backgroundedSession, decide, defaults, diffFingerprint, isAuthorCommit, latestAiReview, reviewPrompt, sessionState } from '../scripts/pr-watch-core.mjs';

// The runner's decisions (scripts/pr-watch-core.mjs) driven with fakes for GitHub and Claude. Every
// report a decision produces is parsed with the site's schema, so the runner and the site cannot drift.

const VIEWER = 'owner-login';
const AUTHOR = 'dana';
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const NOW = new Date('2026-09-24T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

type Decision = { report: Record<string, any> | null; action: Record<string, any> | null };
type Scenario = {
  watch?: Record<string, unknown>;
  head?: string;
  pull?: Record<string, unknown>;
  files?: object[];
  reviews?: object[];
  commits?: object[] | null;
  agents?: object[];
  slot?: boolean;
};

const patch = (lines: string[], hunk = '@@ -10,4 +10,5 @@') => [hunk, ...lines].join('\n');
const FILES_V1 = [{ filename: 'src/export.ts', status: 'modified', patch: patch([' context', '+const format = "csv";', '-const format = "tsv";']) }];
const FILES_V2 = [{ filename: 'src/export.ts', status: 'modified', patch: patch([' context', '+const format = "json";', '-const format = "tsv";']) }];
const aiReview = (sha: string, submitted_at: string, login = VIEWER, id = 1) => ({
  id, user: { login }, submitted_at, html_url: `https://github.com/acme/app/pull/7#pullrequestreview-${id}`,
  body: `AI review by claude-opus-5-5 of \`${sha}\`.\n\n**Summary.** Two findings.`,
});
const commit = (login: string | null, committer = 'web-flow') => ({ author: login ? { login } : null, committer: { login: committer }, commit: { author: { name: login ?? 'Unlinked Person' } } });

async function run(scenario: Scenario) {
  const calls = { files: 0, reviews: 0, agents: 0, compare: [] as string[][] };
  const watch = {
    id: '00000000-0000-4000-8000-000000000007', owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7',
    status: 'watching', review_state: 'idle', head_sha: null, head_fingerprint: null, reviewed_sha: null, review_requested_at: null,
    review_session: null, review_target_sha: null, review_started_at: null, last_note: null, ...scenario.watch,
  };
  const pull = { title: 'Add CSV export', state: 'open', merged: false, head: { sha: scenario.head ?? A }, user: { login: AUTHOR }, ...scenario.pull };
  const result = await decide({
    watch, pull, viewer: VIEWER, slot: scenario.slot ?? true, now: NOW, config: defaults,
    files: async () => { calls.files++; return scenario.files ?? FILES_V1; },
    reviews: async () => { calls.reviews++; return scenario.reviews ?? []; },
    newCommits: async (from: string, to: string) => { calls.compare.push([from, to]); return scenario.commits === undefined ? [] : scenario.commits; },
    agents: async () => { calls.agents++; return scenario.agents ?? []; },
  }) as Decision;
  if (result.report) assert.doesNotThrow(() => runnerReport.parse(result.report), 'every report the runner builds passes the site schema');
  return { ...result, calls };
}

// ---- The contract ------------------------------------------------------------------------------

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
  for (const bad of [
    {},
    { checked_at, extra: true },
    { checked_at, status: 'stopped' },
    { checked_at, head_sha: 'abc1234' },
    { checked_at, head_fingerprint: 'f'.repeat(63) },
    { checked_at, note: 'x'.repeat(501) },
    { checked_at, review: { event: 'posted', finished_at: checked_at, url: 'https://evil.example/review' } },
    { checked_at, review: { event: 'started', session: 'has space', target_sha: A, started_at: checked_at } },
    { checked_at, review: { event: 'cancelled', finished_at: checked_at } },
  ]) assert.equal(runnerReport.safeParse(bad).success, false, JSON.stringify(bad));
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

// ---- The runner's helpers ------------------------------------------------------------------------

test('AI reviews are recognized by the line the skill writes first', () => {
  assert.equal(aiReviewSha(aiReview(A, NOW.toISOString())), A);
  assert.equal(aiReviewSha({ body: 'AI review by claude-opus-5-5 (medium) of `abc1234`.', commit_id: B }), 'abc1234', 'the SHA the body names wins');
  assert.equal(aiReviewSha({ body: '**AI review — Claude Fable 5.1.** Re-review of f02288e.', commit_id: B }), B, 'the earlier bold header falls back to the review commit');
  assert.equal(aiReviewSha({ body: '**AI review — Claude Fable 5.1.**', commit_id: null }), null);
  assert.equal(aiReviewSha({ body: 'Looks good to me, not an AI review', commit_id: B }), null);
  assert.equal(aiReviewSha({ body: '', commit_id: B }), null, 'an empty review (a thread reply) is not an AI review');
  assert.equal(aiReviewSha(null), null);

  const reviews = [
    aiReview(A, minutesAgo(90), VIEWER, 1),
    aiReview(B, minutesAgo(30), VIEWER.toUpperCase(), 2),
    aiReview(C, minutesAgo(5), 'someone-else', 3),
    { id: 4, user: { login: VIEWER }, body: 'LGTM', submitted_at: minutesAgo(1), html_url: 'https://github.com/acme/app/pull/7#pullrequestreview-4' },
    { id: 5, user: { login: VIEWER }, body: aiReview(C, '').body, submitted_at: null, html_url: 'x' },
    { id: 6, user: { login: VIEWER }, body: '', commit_id: C, submitted_at: minutesAgo(2), html_url: 'x' },
  ];
  assert.deepEqual(latestAiReview(reviews, VIEWER), { sha: B, url: 'https://github.com/acme/app/pull/7#pullrequestreview-2', submitted_at: minutesAgo(30) });
  assert.equal(latestAiReview(reviews, VIEWER, minutesAgo(10)), null, 'reviews from before the session started do not count as its review');
  assert.equal(latestAiReview(reviews, VIEWER, minutesAgo(30.5))?.sha, B, 'a minute of clock skew is allowed');
});

test('the diff fingerprint follows the changed lines, not where they sit', () => {
  const base = diffFingerprint(FILES_V1);
  const moved = [{ ...FILES_V1[0], patch: patch([' other context', '+const format = "csv";', '-const format = "tsv";'], '@@ -40,4 +52,5 @@ function main') }];
  assert.equal(diffFingerprint(moved), base, 'a rebase that moves the hunk leaves it alone');
  assert.notEqual(diffFingerprint(FILES_V2), base, 'editing an added line changes it');
  assert.notEqual(diffFingerprint([{ ...FILES_V1[0], status: 'renamed', previous_filename: 'src/old.ts' }]), base);
  const two = [...FILES_V1, { filename: 'README.md', status: 'modified', patch: patch(['+docs']) }];
  assert.equal(diffFingerprint(two), diffFingerprint([...two].reverse()), 'file order does not matter');
  const binary = (sha: string) => [{ filename: 'logo.png', status: 'modified', sha, additions: 0, deletions: 0 }];
  assert.notEqual(diffFingerprint(binary('1'.repeat(40))), diffFingerprint(binary('2'.repeat(40))), 'a file without a patch falls back to its blob');
});

test('commits count as the author\'s unless another named person made them', () => {
  assert.equal(isAuthorCommit(commit(AUTHOR), AUTHOR), true);
  assert.equal(isAuthorCommit(commit('Dana'), AUTHOR), true);
  assert.equal(isAuthorCommit(commit('reviewer', AUTHOR), AUTHOR), true, 'a commit the author applied');
  assert.equal(isAuthorCommit(commit('reviewer'), AUTHOR), false, 'a named person other than the author');
  assert.equal(isAuthorCommit(commit('github-actions[bot]', 'github-actions[bot]'), AUTHOR), true, 'a workflow that pushes fixes acts for the author');
  assert.equal(isAuthorCommit({ author: { login: 'fixer-app', type: 'Bot' }, committer: null }, AUTHOR), true);
  assert.equal(isAuthorCommit(commit(null), AUTHOR), true, 'an email not linked to an account cannot be told apart');
});

test('background sessions are read from claude --bg and claude agents', () => {
  assert.equal(backgroundedSession('backgrounded · bg_1a2B-3c · PR review · acme/app#7 · aaaaaaa\n'), 'bg_1a2B-3c');
  assert.equal(backgroundedSession('Error: workspace not trusted'), null);
  const agents = [{ id: 'bg_1', sessionId: 's-1', state: 'running' }, { id: 'bg_2', state: 'done' }];
  assert.deepEqual(sessionState(agents, 'bg_1'), { finished: false, label: 'running' });
  assert.deepEqual(sessionState(agents, 's-1'), { finished: false, label: 'running' });
  assert.deepEqual(sessionState(agents, 'bg_2'), { finished: true, label: 'done' });
  assert.deepEqual(sessionState(agents, 'bg_3'), { finished: true, label: 'gone' });
});

test('the review prompt invokes the skill and starts from what changed', () => {
  const watch = { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app/pull/7' };
  const followUp = reviewPrompt({ watch, pull: { head: { sha: B } }, reason: '2 new commits were pushed.', since: A, skill: 'luumen-ai-pr-review' });
  assert.ok(followUp.startsWith('/luumen-ai-pr-review https://github.com/acme/app/pull/7\n'));
  assert.match(followUp, new RegExp(`gh api repos/acme/app/compare/${A}\\.\\.\\.${B}`));
  assert.match(followUp, /which remain open/);
  assert.match(followUp, /do not stop to ask a question/);
  const first = reviewPrompt({ watch, pull: { head: { sha: B } }, reason: 'The owner asked.', since: null, skill: 'luumen-ai-pr-review' });
  assert.match(first, /full first review/);
  assert.doesNotMatch(first, /compare/);
});

// ---- One tick's decision, branch by branch --------------------------------------------------------

test('first look without an AI review watches from the head and waits', async () => {
  const { report, action, calls } = await run({});
  assert.equal(action, null);
  assert.equal(report!.baseline_source, 'watch_start');
  assert.equal(report!.head_sha, A);
  assert.equal(report!.head_fingerprint, diffFingerprint(FILES_V1));
  assert.equal(report!.author_login, AUTHOR);
  assert.match(report!.note, /Review now/);
  assert.equal(calls.compare.length, 0);
});

test('first look with Review now requested starts a full first review', async () => {
  const { report, action } = await run({ watch: { review_requested_at: minutesAgo(2) } });
  assert.deepEqual(action, { type: 'review', reason: 'The owner asked for a review from the watch queue.', since: null, target_sha: A });
  assert.equal(report!.head_sha, A);
  assert.equal(report!.baseline_source, 'watch_start');
});

test('first look at a PR whose last AI review covers the head only records the baseline', async () => {
  const { report, action, calls } = await run({ reviews: [aiReview(A.slice(0, 7), minutesAgo(60))] });
  assert.equal(action, null);
  assert.deepEqual([report!.baseline_source, report!.reviewed_sha, report!.head_sha], ['ai_review', A.slice(0, 7), A]);
  assert.equal(calls.compare.length, 0);
});

test('first look after the author pushed past the last AI review starts a follow-up', async () => {
  const { report, action, calls } = await run({ head: B, reviews: [aiReview(A, minutesAgo(60))], commits: [commit(AUTHOR)] });
  assert.deepEqual(calls.compare, [[A, B]]);
  assert.equal(action!.type, 'review');
  assert.equal(action!.since, A);
  assert.equal(action!.target_sha, B);
  assert.deepEqual([report!.head_sha, report!.reviewed_sha, report!.baseline_source], [B, A, 'ai_review']);
});

test('first look when only others pushed past the last AI review records the head without a review', async () => {
  const { report, action } = await run({ head: B, reviews: [aiReview(A, minutesAgo(60))], commits: [commit('teammate')] });
  assert.equal(action, null);
  assert.equal(report!.head_sha, B);
  assert.match(report!.note, /not the author's/);
});

test('first look when GitHub cannot compare (a force push) reviews to be safe', async () => {
  const { action } = await run({ head: B, reviews: [aiReview(A, minutesAgo(60))], commits: null });
  assert.equal(action!.type, 'review');
});

test('an unchanged head costs one read and changes nothing', async () => {
  const { report, action, calls } = await run({ watch: { head_sha: A, head_fingerprint: diffFingerprint(FILES_V1), reviewed_sha: A, last_note: 'Watching from the AI review of aaaaaaa.' } });
  assert.equal(action, null);
  assert.deepEqual(Object.keys(report!).sort(), ['author_login', 'checked_at', 'note', 'title']);
  assert.equal(report!.note, 'Watching from the AI review of aaaaaaa.');
  assert.deepEqual([calls.files, calls.reviews, calls.compare.length, calls.agents], [0, 0, 0, 0]);
});

test('a rebase or base merge that leaves the diff alone moves the head without a review', async () => {
  const moved = [{ ...FILES_V1[0], patch: patch([' context', '+const format = "csv";', '-const format = "tsv";'], '@@ -30,4 +31,5 @@') }];
  const { report, action, calls } = await run({ head: B, files: moved, watch: { head_sha: A, head_fingerprint: diffFingerprint(FILES_V1), reviewed_sha: A } });
  assert.equal(action, null);
  assert.equal(report!.head_sha, B);
  assert.match(report!.note, /without changing the diff/);
  assert.equal(calls.compare.length, 0);
});

test('an author push that changes the diff starts a follow-up from the last reviewed commit', async () => {
  const { report, action } = await run({ head: C, files: FILES_V2, commits: [commit(AUTHOR), commit(AUTHOR)],
    watch: { head_sha: B, head_fingerprint: diffFingerprint(FILES_V1), reviewed_sha: A } });
  assert.deepEqual(action, { type: 'review', reason: `2 new commits that change the diff were pushed to ${AUTHOR}'s PR (head ccccccc).`, since: A, target_sha: C });
  assert.deepEqual([report!.head_sha, report!.head_fingerprint, report!.error], [C, diffFingerprint(FILES_V2), null]);
});

test('commits that change the diff but are not the author\'s do not start a review', async () => {
  const { report, action } = await run({ head: C, files: FILES_V2, commits: [commit('teammate'), commit('teammate')],
    watch: { head_sha: B, head_fingerprint: diffFingerprint(FILES_V1), reviewed_sha: A } });
  assert.equal(action, null);
  assert.equal(report!.head_sha, C);
  assert.equal(report!.note, 'New commits by teammate, not the author; no review.');
});

test('without a free review slot the push is queued and the head is left for the next tick', async () => {
  const { report, action } = await run({ head: C, files: FILES_V2, commits: [commit(AUTHOR)], slot: false,
    watch: { head_sha: B, head_fingerprint: diffFingerprint(FILES_V1), reviewed_sha: A } });
  assert.equal(action, null);
  assert.equal(report!.head_sha, undefined, 'the next tick sees the same push and starts it then');
  assert.match(report!.note, /^Queued: .*2 at a time/);
});

test('Review now on a watched PR starts a review even when nothing changed', async () => {
  const { action } = await run({ watch: { head_sha: A, head_fingerprint: diffFingerprint(FILES_V1), reviewed_sha: A, review_requested_at: minutesAgo(1) } });
  assert.deepEqual(action, { type: 'review', reason: 'The owner asked for a review from the watch queue.', since: A, target_sha: A });
});

test('a closed or merged PR ends its watch', async () => {
  const merged = await run({ pull: { state: 'closed', merged: true }, watch: { head_sha: A } });
  assert.deepEqual([merged.report!.status, merged.action], ['merged', null]);
  const closed = await run({ pull: { state: 'closed', merged: false }, watch: { head_sha: A } });
  assert.equal(closed.report!.status, 'closed');
});

test('a stopped watch with no review running is left alone', async () => {
  const { report, action, calls } = await run({ watch: { status: 'stopped', head_sha: A } });
  assert.deepEqual([report, action], [null, null]);
  assert.equal(calls.files + calls.reviews, 0);
});

// ---- A running review --------------------------------------------------------------------------------

const running = (over: Record<string, unknown> = {}) => ({
  review_state: 'running', review_session: 'bg_77', review_target_sha: B, review_started_at: minutesAgo(12),
  head_sha: B, head_fingerprint: diffFingerprint(FILES_V1), reviewed_sha: A, ...over,
});

test('a posted review at the head is recorded and its finished session left alone', async () => {
  const { report, action } = await run({ head: B, watch: running(), agents: [{ id: 'bg_77', state: 'done' }],
    reviews: [aiReview(A, minutesAgo(90)), aiReview(B, minutesAgo(1), VIEWER, 9)] });
  assert.equal(action, null);
  assert.deepEqual(report!.review, { event: 'posted', finished_at: minutesAgo(1), url: 'https://github.com/acme/app/pull/7#pullrequestreview-9' });
  assert.deepEqual([report!.reviewed_sha, report!.head_sha, report!.error], [B, B, null]);
});

test('a session still open after posting is stopped', async () => {
  const { action } = await run({ head: B, watch: running(), agents: [{ id: 'bg_77', state: 'running' }], reviews: [aiReview(B, minutesAgo(1))] });
  assert.deepEqual(action, { type: 'stop', session: 'bg_77' });
});

test('a push during the review leaves the head at the reviewed commit for the next tick', async () => {
  const { report } = await run({ head: C, watch: running(), agents: [], reviews: [aiReview(B, minutesAgo(1))] });
  assert.equal(report!.review.event, 'posted');
  assert.equal(report!.head_sha, undefined);
  assert.match(report!.note, /pushed again while it ran/);
});

test('a session that ended without posting fails the review and says how to open it', async () => {
  const { report, action } = await run({ head: B, watch: running(), agents: [{ id: 'bg_77', state: 'done' }], reviews: [aiReview(A, minutesAgo(90))] });
  assert.equal(action, null);
  assert.equal(report!.review.event, 'failed');
  assert.match(report!.error, /claude attach bg_77/);
});

test('a session past the time limit is stopped and failed', async () => {
  const { report, action } = await run({ head: B, watch: running({ review_started_at: minutesAgo(61) }), agents: [{ id: 'bg_77', state: 'running' }] });
  assert.deepEqual(action, { type: 'stop', session: 'bg_77' });
  assert.equal(report!.review.event, 'failed');
  assert.match(report!.error, /past 60 minutes/);
});

test('a review in progress reports its progress and nothing else', async () => {
  const { report, action } = await run({ head: B, watch: running(), agents: [{ id: 'bg_77', state: 'running' }] });
  assert.equal(action, null);
  assert.equal(report!.review, undefined);
  assert.equal(report!.note, 'Reviewing bbbbbbb in session bg_77 (running, 12 min).');
});

test('a stopped watch still finishes the review it was running', async () => {
  const { report } = await run({ head: B, watch: running({ status: 'stopped' }), agents: [], reviews: [aiReview(B, minutesAgo(1))] });
  assert.equal(report!.review.event, 'posted');
  assert.equal(report!.status, undefined);
});
