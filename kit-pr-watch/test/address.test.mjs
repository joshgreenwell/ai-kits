import test from 'node:test';
import assert from 'node:assert/strict';
import { addressPrompt, addressResult, addressSummary, decideAddress, defaults, feedback, remoteMatches } from '../pr-watch-core.mjs';
import { assertReportPasses } from './contract.mjs';

// Address watches (pr-watch-core.mjs): which comments start a pass on the owner's own PR, and what one
// tick does with them. Like test/review.test.mjs, every report is checked against pr-watch-report-v1.

const VIEWER = 'owner-login';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const NOW = new Date('2026-09-30T12:00:00.000Z');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const CREATED = minutesAgo(24 * 60);

let nextId = 100;
const user = (login) => ({ login, type: /\[bot\]$/.test(login) ? 'Bot' : 'User' });
const review = (login, submitted_at, fields = {}) => {
  const id = nextId++;
  return { id, user: user(login), author_association: 'MEMBER', state: 'COMMENTED', body: 'Please rename this.', submitted_at,
    html_url: `https://github.com/acme/app/pull/7#pullrequestreview-${id}`, ...fields };
};
const inline = (login, created_at, fields = {}) => {
  const id = nextId++;
  return { id, user: user(login), author_association: 'MEMBER', body: 'This can be null.', created_at, path: 'src/export.ts',
    pull_request_review_id: null, in_reply_to_id: null, html_url: `https://github.com/acme/app/pull/7#discussion_r${id}`, ...fields };
};
const said = (login, created_at, fields = {}) => {
  const id = nextId++;
  return { id, user: user(login), author_association: 'MEMBER', body: 'Can we split this PR?', created_at,
    html_url: `https://github.com/acme/app/pull/7#issuecomment-${id}`, ...fields };
};

async function run(scenario) {
  const calls = { comments: 0, agents: 0, result: 0 };
  const watch = {
    id: '00000000-0000-4000-8000-000000000009', kind: 'address', owner: 'acme', repo: 'app', number: 7, url: 'https://github.com/acme/app/pull/7',
    status: 'watching', review_state: 'idle', head_sha: null, review_requested_at: null, review_session: null, review_target_sha: null,
    review_started_at: null, last_note: null, comments_through: null, created_at: CREATED, ...scenario.watch,
  };
  const pull = { title: 'Encrypt vendor credentials', state: 'open', merged: false, user: { login: VIEWER },
    head: { sha: scenario.head ?? A, ref: 'fix/encrypt', repo: { full_name: 'acme/app' } }, base: { ref: 'develop' }, ...scenario.pull };
  const decision = await decideAddress({
    watch, pull, viewer: VIEWER, slot: scenario.slot ?? true, now: NOW, config: defaults,
    reviews: async () => { calls.comments++; return scenario.reviews ?? []; },
    reviewComments: async () => { calls.comments++; return scenario.reviewComments ?? []; },
    issueComments: async () => { calls.comments++; return scenario.issueComments ?? []; },
    agents: async () => { calls.agents++; return scenario.agents ?? []; },
    result: async () => { calls.result++; return scenario.result === undefined ? null : scenario.result; },
  });
  if (decision.report) assertReportPasses(decision.report);
  return { ...decision, calls };
}

// ---- Which comments count ------------------------------------------------------------------------

test('feedback from members and review bots counts; the owner, outsiders, and bot chatter do not', () => {
  const items = feedback({
    viewer: VIEWER,
    reviews: [
      review('zach', minutesAgo(50), { state: 'CHANGES_REQUESTED', body: '' }),
      review('zach', minutesAgo(49), { state: 'APPROVED', body: 'Looks good' }),
      review('zach', minutesAgo(48), { body: '' }),
      review('zach', null, { body: 'A pending review nobody has submitted' }),
      review('outsider', minutesAgo(47), { author_association: 'CONTRIBUTOR' }),
      review(VIEWER, minutesAgo(46), { body: 'AI review by claude-opus-5-5 of `abc1234`.' }),
      review('coderabbitai[bot]', minutesAgo(45), { author_association: 'NONE', body: '**Actionable comments posted: 2**' }),
      review('coderabbitai[bot]', minutesAgo(44), { author_association: 'NONE', body: '**Actionable comments posted: 0**' }),
    ],
    reviewComments: [
      inline('coderabbitai[bot]', minutesAgo(45), { author_association: 'NONE' }),
      inline('coderabbitai[bot]', minutesAgo(40), { author_association: 'NONE', in_reply_to_id: 1, body: '@owner-login, thanks for the update' }),
      inline('outsider', minutesAgo(39), { author_association: 'NONE' }),
    ],
    issueComments: [
      said('github-actions[bot]', minutesAgo(38), { author_association: 'NONE', body: 'Size: L' }),
      said('lee', minutesAgo(37)),
      said(VIEWER, minutesAgo(36)),
    ],
  });
  assert.deepEqual(items.map(item => [item.source, item.login]), [
    ['review', 'zach'],
    ['review', 'coderabbitai[bot]'],
    ['inline', 'coderabbitai[bot]'],
    ['conversation', 'lee'],
  ]);
  assert.ok(items.every(item => item.url.startsWith('https://github.com/acme/app/pull/7#')));
});

test('an inline comment arrives with its review, and one the owner answered in its thread is done', () => {
  const pending = review('zach', minutesAgo(10), { body: '' });
  const drafted = inline('zach', minutesAgo(90), { pull_request_review_id: pending.id });
  const bot = inline('coderabbitai[bot]', minutesAgo(60), { author_association: 'NONE' });
  const fixed = inline(VIEWER, minutesAgo(30), { in_reply_to_id: bot.id, body: 'Fixed in abc1234' });
  const followUp = inline('zach', minutesAgo(20), { in_reply_to_id: bot.id, body: 'This test was already added in another commit' });
  const items = feedback({ viewer: VIEWER, reviews: [pending], reviewComments: [drafted, bot, fixed, followUp], issueComments: [] });
  assert.deepEqual(items.map(item => [item.id, item.at]), [[followUp.id, followUp.created_at], [drafted.id, pending.submitted_at]],
    'the bot comment is answered; the reply that came after the answer still counts; the drafted comment counts from its review');
});

test('a clone matches its repository over SSH or HTTPS, and nothing else', () => {
  for (const remote of ['git@github.com:acme/app.git', 'https://github.com/acme/app', 'https://github.com/Acme/App.git\n', 'ssh://git@github.com/acme/app.git', 'https://x-access-token@github.com/acme/app.git']) {
    assert.equal(remoteMatches(remote, 'acme/app'), true, remote);
  }
  for (const remote of ['git@github.com:acme/app-ai.git', 'https://github.com.evil.example/acme/app', 'https://gitlab.com/acme/app', '', 'git@github.com:acme/app/extra.git']) {
    assert.equal(remoteMatches(remote, 'acme/app'), false, remote);
  }
});

// ---- The session's result and prompt --------------------------------------------------------------

test('a result file is checked and trimmed before the page sees it', () => {
  assert.equal(addressResult(null), null);
  assert.equal(addressResult({ outcome: 'merged', summary: 'x' }), null);
  const result = addressResult({ outcome: 'needs_you', summary: `  ${'s'.repeat(1_600)}  `, commits: ['abc1234', 'not a sha', 7, A],
    questions: [' Keep the fallback? ', '', 42, ...Array.from({ length: 12 }, (_, i) => `q${i}`)] });
  assert.equal(result.summary.length, 1_500);
  assert.deepEqual(result.commits, ['abc1234', A]);
  assert.equal(result.questions.length, 10);
  assert.equal(result.questions[0], 'Keep the fallback?');
  assert.equal(addressSummary({ summary: 'Renamed the test.', commits: [], questions: ['Keep the fallback?'] }), 'Renamed the test.\n\nQuestions for you:\n- Keep the fallback?');
  assert.ok(addressSummary({ summary: 'x'.repeat(1_500), commits: [], questions: Array.from({ length: 10 }, () => 'q'.repeat(300)) }).length <= 2_000);
});

test('the address prompt runs the babysit skill once, in a worktree, and pushes without force', () => {
  const watch = { url: 'https://github.com/acme/app/pull/7' };
  const pull = { head: { sha: A, ref: 'fix/encrypt', repo: { full_name: 'acme/app' } }, base: { ref: 'develop' } };
  const comments = Array.from({ length: 25 }, (_, i) => ({ source: 'inline', login: 'zach', at: minutesAgo(30 - i), url: `https://github.com/acme/app/pull/7#discussion_r${i}`, path: 'src/a.ts' }));
  const common = { watch, pull, reason: '25 new comments from zach.', comments, skill: 'luumen-pr-babysit', resultPath: '/w/tmp/pr-watch/results/9.json', worktree: '/w/tmp/pr-watch/worktrees/app-7' };
  const prompt = addressPrompt({ ...common, clone: '/w/app' });
  assert.ok(prompt.startsWith('/luumen-pr-babysit https://github.com/acme/app/pull/7\n'));
  assert.match(prompt, /the newest 20 of 25/);
  assert.ok(!prompt.includes('discussion_r4\n') && prompt.includes('discussion_r24'), 'the newest comments are the ones listed');
  assert.match(prompt, /git -C \/w\/app worktree add --detach \/w\/tmp\/pr-watch\/worktrees\/app-7 FETCH_HEAD/);
  assert.match(prompt, /git push origin HEAD:refs\/heads\/fix\/encrypt/);
  assert.match(prompt, /Never force-push/);
  assert.match(prompt, /do not start a monitor/);
  assert.match(prompt, /Do not post PR comments or review replies/);
  assert.ok(prompt.trimEnd().includes('/w/tmp/pr-watch/results/9.json'));
  assert.match(addressPrompt({ ...common, clone: null }), /gh repo clone acme\/app \/w\/tmp\/pr-watch\/worktrees\/app-7 -- --branch fix\/encrypt/);
  assert.match(addressPrompt({ ...common, comments: [], clone: null }), /a pass over all of the open review feedback/);
});

// ---- One tick --------------------------------------------------------------------------------------

test('first look records the watermark and points at Address now for earlier comments', async () => {
  const { report, action } = await run({ reviewComments: [inline('zach', minutesAgo(26 * 60))] });
  assert.equal(action, null);
  assert.deepEqual([report.comments_through, report.comments_pending, report.head_sha], [CREATED, 0, A]);
  assert.match(report.note, /1 earlier comment is on the PR; use Address now/);
});

test('a PR the owner did not open ends its address watch before any comment is read', async () => {
  const { report, action, calls } = await run({ pull: { user: { login: 'dana' } } });
  assert.equal(action, null);
  assert.equal(report.status, 'stopped');
  assert.match(report.note, /dana's.*use Re-review/);
  assert.equal(calls.comments, 0);
});

test('a closed or merged PR ends its address watch', async () => {
  assert.equal((await run({ pull: { state: 'closed', merged: true } })).report.status, 'merged');
  assert.equal((await run({ pull: { state: 'closed', merged: false } })).report.status, 'closed');
});

test('new comments wait until the reviewers have been quiet for the settle time', async () => {
  const { report, action } = await run({ watch: { comments_through: minutesAgo(60) }, reviewComments: [inline('coderabbitai[bot]', minutesAgo(8), { author_association: 'NONE' }), inline('zach', minutesAgo(3))] });
  assert.equal(action, null);
  assert.equal(report.comments_pending, 2);
  assert.equal(report.comments_through, minutesAgo(60), 'the watermark stays until a pass starts');
  assert.match(report.note, /2 new comments from coderabbitai\[bot\], zach\. Starting once the reviewers have been quiet for 10 minutes/);
});

test('quiet new comments start a pass that takes on everything through the newest', async () => {
  const comments = [inline('zach', minutesAgo(40)), said('lee', minutesAgo(15))];
  const { report, action } = await run({ head: B, watch: { comments_through: minutesAgo(60), last_note: 'Pushed 1 commit.' }, reviewComments: [comments[0]], issueComments: [comments[1]] });
  assert.deepEqual([action.type, action.target_sha, action.through], ['address', B, minutesAgo(15)]);
  assert.deepEqual(action.comments.map((item) => item.id), comments.map(item => item.id));
  assert.equal(action.reason, '2 new comments from zach, lee.');
  assert.deepEqual([report.comments_through, report.error], [minutesAgo(60), null], 'the caller moves the watermark once the session starts');
});

test('a review that keeps going for an hour starts anyway', async () => {
  const burst = [inline('zach', minutesAgo(65)), inline('zach', minutesAgo(2))];
  assert.equal((await run({ watch: { comments_through: minutesAgo(70) }, reviewComments: burst })).action?.type, 'address');
});

test('without a free slot the pass is queued and the watermark stays', async () => {
  const { report, action } = await run({ slot: false, watch: { comments_through: minutesAgo(60) }, reviewComments: [inline('zach', minutesAgo(30))] });
  assert.equal(action, null);
  assert.equal(report.comments_through, minutesAgo(60));
  assert.match(report.note, /^Queued: 1 new comment from zach\. Waiting for a slot \(2 at a time\)/);
});

test('Address now starts a pass over everything on the PR, even with nothing new', async () => {
  const earlier = inline('zach', minutesAgo(26 * 60));
  const { action } = await run({ watch: { review_requested_at: minutesAgo(1) }, reviewComments: [earlier] });
  assert.equal(action.type, 'address');
  assert.deepEqual(action.comments, []);
  assert.equal(action.through, CREATED, 'nothing newer than the watch itself');
  assert.match(action.reason, /^The owner asked for a pass from the watch queue\.$/);
});

test('with nothing new, the note from the last pass stays', async () => {
  const { report, action } = await run({ watch: { comments_through: minutesAgo(60), last_note: 'Pushed 2 commits; the head is now aaaaaaa.' }, reviewComments: [inline('zach', minutesAgo(90))] });
  assert.equal(action, null);
  assert.deepEqual([report.note, report.comments_pending], ['Pushed 2 commits; the head is now aaaaaaa.', 0]);
});

const running = (watch = {}) => ({ review_state: 'running', review_session: 'bg_9', review_target_sha: A, review_started_at: minutesAgo(20), comments_through: minutesAgo(30), ...watch });

test('a pass that pushed is recorded with the pushed range, and its open session stopped', async () => {
  const { report, action } = await run({ head: B, watch: running(), agents: [{ id: 'bg_9', state: 'running' }],
    result: { outcome: 'pushed', summary: 'Renamed the migration test.', commits: [B], questions: [] } });
  assert.deepEqual(action, { type: 'stop', session: 'bg_9' });
  assert.deepEqual(report.review, { event: 'addressed', finished_at: NOW.toISOString(), outcome: 'pushed', summary: 'Renamed the migration test.', url: `https://github.com/acme/app/compare/${A}...${B}` });
  assert.deepEqual([report.head_sha, report.note, report.error], [B, 'Pushed 1 commit; the head is now bbbbbbb.', null]);
});

test('a pass that needs the owner carries its questions and no link when nothing was pushed', async () => {
  const { report, action } = await run({ watch: running(), agents: [{ id: 'bg_9', state: 'done' }],
    result: { outcome: 'needs_you', summary: 'Left the fallback alone.', commits: [], questions: ['Keep the legacy fallback?'] } });
  assert.equal(action, null);
  assert.equal(report.review.url, null);
  assert.equal(report.review.summary, 'Left the fallback alone.\n\nQuestions for you:\n- Keep the legacy fallback?');
  assert.equal(report.note, 'Needs you: 1 question.');
});

test('a session that ended without a result fails the pass and says how to open it', async () => {
  const { report, action, calls } = await run({ watch: running(), agents: [] });
  assert.equal(action, null);
  assert.equal(report.review.event, 'failed');
  assert.match(report.error, /bg_9 ended \(gone\) without writing its result\. Open it with: claude attach bg_9/);
  assert.deepEqual([calls.agents, calls.result, calls.comments], [1, 1, 0], 'the session is read before the result, and no comments are read while it runs');
});

test('a pass past the time limit is stopped and failed', async () => {
  const { report, action } = await run({ watch: running({ review_started_at: minutesAgo(91) }), agents: [{ id: 'bg_9', state: 'running' }] });
  assert.deepEqual(action, { type: 'stop', session: 'bg_9' });
  assert.equal(report.review.event, 'failed');
  assert.match(report.error, /ran past 90 minutes/);
});

test('a pass in progress reports its progress and nothing else', async () => {
  const { report, action } = await run({ watch: running(), agents: [{ id: 'bg_9', state: 'running' }] });
  assert.equal(action, null);
  assert.equal(report.review, undefined);
  assert.equal(report.note, 'Addressing comments in session bg_9 (running, 20 min).');
});

test('a stopped watch finishes the pass it was running, and is otherwise left alone', async () => {
  const finished = await run({ watch: running({ status: 'stopped' }), agents: [], result: { outcome: 'no_change', summary: '', commits: [], questions: [] } });
  assert.equal(finished.report.review.event, 'addressed');
  const idle = await run({ watch: { status: 'stopped', comments_through: minutesAgo(60) }, reviewComments: [inline('zach', minutesAgo(30))] });
  assert.deepEqual([idle.report, idle.action, idle.calls.comments], [null, null, 0]);
});
