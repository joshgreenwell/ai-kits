import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const at = (minute: number) => new Date(Date.UTC(2026, 8, 24, 12, minute)).toISOString();
const conflict = { status: 409 }, missing = { status: 404 };

/**
 * The queue as the page and the runner use it, run as the application role so the grants and
 * policies in the migration are what is tested: add, dedupe, report a first look, Review now, a
 * review that starts, is stopped mid-run, and still posts, then a merged PR and a failed review.
 */
maybe('the PR watch queue: add, report, review, stop, and end as the application role', async () => {
  const { createPrWatchStore } = await import('../lib/pr-watch-store');
  const admin = postgres(url!, options);
  const app = postgres(url!, { ...options, username: 'personal_hub_app' });
  const store = createPrWatchStore(() => app);
  const repo = `app-${randomUUID().slice(0, 8)}`;
  try {
    const first = await store.add({ owner: 'Acme', repo, number: 7 });
    assert.equal(first.duplicate, false);
    assert.deepEqual([first.watch.status, first.watch.review_state, first.watch.review_count, first.watch.url], ['watching', 'idle', 0, `https://github.com/Acme/${repo}/pull/7`]);
    const id = first.watch.id;
    const again = await store.add({ owner: 'acme', repo: repo.toUpperCase(), number: 7 });
    assert.deepEqual([again.duplicate, again.watch.id], [true, id], 'GitHub names are case-insensitive');

    // Three pastes at once make one watch: the advisory lock serializes the check and the insert.
    const racing = await Promise.all([1, 2, 3].map(() => store.add({ owner: 'acme', repo, number: 8 })));
    assert.equal(new Set(racing.map(result => result.watch.id)).size, 1);
    assert.equal(racing.filter(result => !result.duplicate).length, 1);
    const other = racing[0].watch.id;

    // The runner's tick: a heartbeat, then the live watches.
    const work = await store.runnerWork('pr-watch', { machine_label: 'Josh’s Mac', version: '1.0.0' });
    assert.ok(work.some(watch => watch.id === id) && work.some(watch => watch.id === other));
    const firstLook = await store.report(id, { checked_at: at(0), title: 'Add export', author_login: 'dana', head_sha: A, head_fingerprint: 'f'.repeat(64),
      baseline_source: 'watch_start', note: 'Watching from aaaaaaa.' });
    assert.deepEqual([firstLook.title, firstLook.author_login, firstLook.head_sha, firstLook.baseline_source, firstLook.last_note, firstLook.last_checked_at],
      ['Add export', 'dana', A, 'watch_start', 'Watching from aaaaaaa.', at(0)]);

    // Review now, then the runner starts it.
    assert.ok((await store.act(id, 'review')).review_requested_at);
    const started = await store.report(id, { checked_at: at(5), head_sha: B, error: null, note: 'Review started in session bg_1.',
      review: { event: 'started', session: 'bg_1', target_sha: B, started_at: at(5) } });
    assert.deepEqual([started.review_state, started.review_session, started.review_target_sha, started.review_requested_at, started.head_sha],
      ['running', 'bg_1', B, null, B], 'starting a review answers the request');
    await assert.rejects(store.report(id, { checked_at: at(6), review: { event: 'started', session: 'bg_2', target_sha: B, started_at: at(6) } }), conflict, 'one review at a time');
    await assert.rejects(store.act(id, 'review'), conflict);

    // Stopping mid-review keeps the review: the runner still sees it until it posts.
    const stopped = await store.act(id, 'stop');
    assert.deepEqual([stopped.status, stopped.review_state], ['stopped', 'running']);
    assert.ok(stopped.stopped_at);
    assert.ok((await store.runnerWork('pr-watch', {})).some(watch => watch.id === id));
    const posted = await store.report(id, { checked_at: at(20), reviewed_sha: B, note: 'Reviewed bbbbbbb.', error: null,
      review: { event: 'posted', finished_at: at(19), url: `https://github.com/acme/${repo}/pull/7#pullrequestreview-1` } });
    assert.deepEqual([posted.status, posted.review_state, posted.review_count, posted.reviewed_sha, posted.review_finished_at],
      ['stopped', 'idle', 1, B, at(19)]);
    await assert.rejects(store.report(id, { checked_at: at(21), review: { event: 'posted', finished_at: at(21), url: 'https://github.com/x' } }), conflict, 'a review posts once');
    await assert.rejects(store.act(id, 'stop'), conflict);
    assert.ok(!(await store.runnerWork('pr-watch', {})).some(watch => watch.id === id), 'a stopped, idle watch leaves the runner alone');
    const rewatch = await store.add({ owner: 'Acme', repo, number: 7 });
    assert.equal(rewatch.duplicate, false, 'a stopped PR can be watched again as a new row');
    assert.notEqual(rewatch.watch.id, id);

    // A merge ends the watch, and nothing reopens it.
    const merged = await store.report(other, { checked_at: at(30), status: 'merged', note: 'Merged; the watch ended.' });
    assert.equal(merged.status, 'merged'); assert.ok(merged.stopped_at);
    assert.equal((await store.report(other, { checked_at: at(35), status: 'closed' })).status, 'merged');

    // A failed review shows as failed and does not block the next start.
    await store.report(rewatch.watch.id, { checked_at: at(40), head_sha: C, review: { event: 'started', session: 'bg_3', target_sha: C, started_at: at(40) } });
    const failed = await store.report(rewatch.watch.id, { checked_at: at(45), error: 'Review session bg_3 ended (done) without posting an AI review.', review: { event: 'failed', finished_at: at(45) } });
    assert.deepEqual([failed.review_state, failed.review_count], ['failed', 0]);
    assert.match(failed.last_error!, /without posting/);
    assert.equal((await store.act(rewatch.watch.id, 'review')).status, 'watching');

    const listed = await store.list();
    const mine = listed.watches.filter(watch => watch.repo === repo);
    assert.deepEqual(mine.map(watch => watch.id).slice(0, 1), [rewatch.watch.id], 'live watches come first');
    assert.ok(mine.some(watch => watch.id === id) && mine.some(watch => watch.id === other), 'ended watches follow for context');
    const runner = listed.runners.find(row => row.producer_id === 'pr-watch');
    assert.ok(runner && runner.last_seen_at);

    await assert.rejects(store.act(randomUUID(), 'stop'), missing);
    await assert.rejects(store.act('not-a-uuid', 'review'), missing);
    await assert.rejects(store.report(randomUUID(), { checked_at: at(50) }), missing);
  } finally {
    await admin`DELETE FROM personal_hub.pr_watches WHERE repo = ${repo}`;
    await Promise.all([admin.end({ timeout: 1 }), app.end({ timeout: 1 })]);
  }
});

maybe('the queue holds a bounded number of live watches', async () => {
  const { createPrWatchStore, MAX_ACTIVE_WATCHES } = await import('../lib/pr-watch-store');
  const admin = postgres(url!, options);
  const app = postgres(url!, { ...options, username: 'personal_hub_app' });
  const store = createPrWatchStore(() => app);
  const repo = `cap-${randomUUID().slice(0, 8)}`;
  try {
    const [{ count }] = await admin`SELECT count(*)::int AS count FROM personal_hub.pr_watches WHERE status = 'watching'`;
    for (let number = 1; number <= MAX_ACTIVE_WATCHES - count; number++) await store.add({ owner: 'acme', repo, number });
    await assert.rejects(store.add({ owner: 'acme', repo, number: 999 }), { status: 409, message: new RegExp(`${MAX_ACTIVE_WATCHES} pull requests`) });
    assert.equal((await store.add({ owner: 'acme', repo, number: 1 })).duplicate, true, 'a duplicate is not a new watch, even at the cap');
  } finally {
    await admin`DELETE FROM personal_hub.pr_watches WHERE repo = ${repo}`;
    await Promise.all([admin.end({ timeout: 1 }), app.end({ timeout: 1 })]);
  }
});

maybe('the application role can never delete a watch or rewrite which PR it is', async () => {
  const admin = postgres(url!, options);
  const app = postgres(url!, { ...options, username: 'personal_hub_app' });
  try {
    for (const table of ['pr_watches', 'pr_watch_runners']) {
      await assert.rejects(app.unsafe(`DELETE FROM personal_hub.${table} WHERE false`), /permission denied/, `${table} delete`);
    }
    for (const column of ['id', 'owner', 'repo', 'number', 'created_at']) {
      await assert.rejects(app.unsafe(`UPDATE personal_hub.pr_watches SET ${column} = ${column} WHERE false`), /permission denied/, `pr_watches.${column}`);
    }
    await assert.rejects(app.unsafe('UPDATE personal_hub.pr_watch_runners SET producer_id = producer_id WHERE false'), /permission denied/);
    const [grants] = await admin`SELECT
      has_table_privilege('anon', 'personal_hub.pr_watches', 'SELECT') AS anon_watches,
      has_table_privilege('authenticated', 'personal_hub.pr_watches', 'SELECT') AS authenticated_watches,
      has_table_privilege('anon', 'personal_hub.pr_watch_runners', 'SELECT') AS anon_runners`;
    assert.deepEqual(grants, { anon_watches: false, authenticated_watches: false, anon_runners: false });
  } finally {
    await Promise.all([admin.end({ timeout: 1 }), app.end({ timeout: 1 })]);
  }
});
