import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { RequestError } from './contracts';
import { pullRequestUrl, type PrWatch, type PrWatchList, type PrWatchRunner, type PullRequestRef, type RunnerReport } from './pr-watch-contract';

type Sql = ReturnType<typeof postgres>;
type DatabaseProvider = () => Sql;

/** Enough for a working week of reviews; each one is a GitHub read every tick. */
export const MAX_ACTIVE_WATCHES = 25;
const ENDED_SHOWN = 20;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const columns = `id, owner, repo, number, status, title, author_login, head_sha, head_fingerprint, reviewed_sha, baseline_source,
  review_state, review_session, review_target_sha, review_started_at, review_finished_at, review_count, last_review_url,
  review_requested_at, last_checked_at, last_note, last_error, created_at, stopped_at`;

const iso = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;

function shape(row: Record<string, unknown>): PrWatch {
  const ref = { owner: row.owner as string, repo: row.repo as string, number: Number(row.number) };
  return {
    ...ref,
    id: row.id as string,
    url: pullRequestUrl(ref),
    status: row.status as PrWatch['status'],
    title: (row.title as string | null) ?? null,
    author_login: (row.author_login as string | null) ?? null,
    head_sha: (row.head_sha as string | null) ?? null,
    head_fingerprint: (row.head_fingerprint as string | null) ?? null,
    reviewed_sha: (row.reviewed_sha as string | null) ?? null,
    baseline_source: (row.baseline_source as PrWatch['baseline_source']) ?? null,
    review_state: row.review_state as PrWatch['review_state'],
    review_session: (row.review_session as string | null) ?? null,
    review_target_sha: (row.review_target_sha as string | null) ?? null,
    review_started_at: iso(row.review_started_at),
    review_finished_at: iso(row.review_finished_at),
    review_count: Number(row.review_count),
    last_review_url: (row.last_review_url as string | null) ?? null,
    review_requested_at: iso(row.review_requested_at),
    last_checked_at: iso(row.last_checked_at),
    last_note: (row.last_note as string | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    created_at: iso(row.created_at)!,
    stopped_at: iso(row.stopped_at),
  };
}

/** Injectable database provider, so the store runs against a disposable Postgres in tests. */
export function createPrWatchStore(getDatabase?: DatabaseProvider) {
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();
  const requireId = (id: string) => { if (!uuid.test(id)) throw new RequestError('Watch not found', 404); };

  async function list(): Promise<PrWatchList> {
    const db = await sql();
    // Live watches first, newest first; then the most recent ended ones for context.
    const [watches, runners] = await Promise.all([
      db.unsafe(`(SELECT ${columns} FROM personal_hub.pr_watches WHERE status = 'watching' OR review_state = 'running')
        UNION ALL
        (SELECT ${columns} FROM personal_hub.pr_watches WHERE status <> 'watching' AND review_state <> 'running' ORDER BY coalesce(stopped_at, updated_at) DESC LIMIT ${ENDED_SHOWN})`),
      db`SELECT producer_id, machine_label, version, last_seen_at FROM personal_hub.pr_watch_runners ORDER BY last_seen_at DESC LIMIT 5`,
    ]);
    const shaped = watches.map(shape).sort((a, b) =>
      Number(b.status === 'watching') - Number(a.status === 'watching') || b.created_at.localeCompare(a.created_at));
    return {
      watches: shaped,
      runners: runners.map(row => ({ producer_id: row.producer_id, machine_label: row.machine_label, version: row.version, last_seen_at: iso(row.last_seen_at)! } satisfies PrWatchRunner)),
      as_of: new Date().toISOString(),
    };
  }

  /** Start watching a pull request, or return the live watch it already has. */
  async function add(ref: PullRequestRef): Promise<{ watch: PrWatch; duplicate: boolean }> {
    const db = await sql();
    return db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      // One writer at a time, so the cap and the one-live-watch rule cannot both pass for two requests.
      await tx`SELECT pg_advisory_xact_lock(hashtext('personal_hub.pr_watches'))`;
      const existing = await tx.unsafe(`SELECT ${columns} FROM personal_hub.pr_watches
        WHERE status = 'watching' AND lower(owner) = lower($1) AND lower(repo) = lower($2) AND number = $3`, [ref.owner, ref.repo, ref.number]);
      if (existing.length) return { watch: shape(existing[0]), duplicate: true };
      const [{ count }] = await tx`SELECT count(*)::int AS count FROM personal_hub.pr_watches WHERE status = 'watching'`;
      if (count >= MAX_ACTIVE_WATCHES) throw new RequestError(`Already watching ${MAX_ACTIVE_WATCHES} pull requests; stop one first`, 409);
      const rows = await tx.unsafe(`INSERT INTO personal_hub.pr_watches (id, owner, repo, number) VALUES ($1, $2, $3, $4) RETURNING ${columns}`,
        [randomUUID(), ref.owner, ref.repo, ref.number]);
      return { watch: shape(rows[0]), duplicate: false };
    });
  }

  /**
   * Stop a watch, or ask for a review on the runner's next tick. Stopping never cancels a review that
   * is already running: it finishes and posts, and nothing new starts.
   */
  async function act(id: string, action: 'stop' | 'review'): Promise<PrWatch> {
    requireId(id);
    const db = await sql();
    const rows = action === 'stop'
      ? await db.unsafe(`UPDATE personal_hub.pr_watches SET status = 'stopped', stopped_at = now(), review_requested_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'watching' RETURNING ${columns}`, [id])
      : await db.unsafe(`UPDATE personal_hub.pr_watches SET review_requested_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'watching' AND review_state <> 'running' RETURNING ${columns}`, [id]);
    if (rows.length) return shape(rows[0]);
    const current = await db.unsafe(`SELECT ${columns} FROM personal_hub.pr_watches WHERE id = $1`, [id]);
    if (!current.length) throw new RequestError('Watch not found', 404);
    const watch = shape(current[0]);
    if (watch.status !== 'watching') throw new RequestError('This pull request is no longer being watched', 409);
    throw new RequestError('A review is already running for this pull request', 409);
  }

  /** The runner's tick: record that it asked, and hand it every watch that still needs attention. */
  async function runnerWork(producer: string, heartbeat: { machine_label?: string; version?: string }): Promise<PrWatch[]> {
    const db = await sql();
    await db`INSERT INTO personal_hub.pr_watch_runners (producer_id, machine_label, version, last_seen_at)
      VALUES (${producer}, ${heartbeat.machine_label ?? null}, ${heartbeat.version ?? null}, now())
      ON CONFLICT (producer_id) DO UPDATE SET machine_label = excluded.machine_label, version = excluded.version, last_seen_at = now()`;
    const rows = await db.unsafe(`SELECT ${columns} FROM personal_hub.pr_watches
      WHERE status = 'watching' OR review_state = 'running' ORDER BY created_at LIMIT ${MAX_ACTIVE_WATCHES * 2}`);
    return rows.map(shape);
  }

  /** Apply what the runner saw on one watch. A stopped watch keeps its status; its running review can still finish. */
  async function report(id: string, input: RunnerReport): Promise<PrWatch> {
    requireId(id);
    const db = await sql();
    const set: Record<string, unknown> = { last_checked_at: input.checked_at };
    for (const key of ['title', 'author_login', 'head_sha', 'head_fingerprint', 'reviewed_sha', 'baseline_source'] as const) {
      if (input[key] !== undefined) set[key] = input[key];
    }
    if (input.note !== undefined) set.last_note = input.note;
    if (input.error !== undefined) set.last_error = input.error;
    const review = input.review;
    if (review?.event === 'started') Object.assign(set, {
      review_state: 'running', review_session: review.session, review_target_sha: review.target_sha,
      review_started_at: review.started_at, review_finished_at: null, review_requested_at: null,
    });
    if (review?.event === 'posted') Object.assign(set, { review_state: 'idle', review_finished_at: review.finished_at, last_review_url: review.url });
    if (review?.event === 'failed') Object.assign(set, { review_state: 'failed', review_finished_at: review.finished_at });
    const ending = input.status && input.status !== 'watching' ? input.status : null;
    const rows = await db`UPDATE personal_hub.pr_watches SET ${db(set)},
        status = CASE WHEN status = 'watching' AND ${ending}::text IS NOT NULL THEN ${ending}::text ELSE status END,
        stopped_at = CASE WHEN status = 'watching' AND ${ending}::text IS NOT NULL THEN now() ELSE stopped_at END,
        review_count = review_count + ${review?.event === 'posted' ? 1 : 0},
        updated_at = now()
      WHERE id = ${id}
        AND (${review?.event === 'started'} = false OR (status = 'watching' AND review_state <> 'running'))
        AND (${review?.event === 'posted' || review?.event === 'failed'} = false OR review_state = 'running')
      RETURNING id`;
    if (!rows.length) {
      const current = await db`SELECT id FROM personal_hub.pr_watches WHERE id = ${id}`;
      if (!current.length) throw new RequestError('Watch not found', 404);
      throw new RequestError(review?.event === 'started' ? 'This watch cannot start a review now' : 'No review is running for this watch', 409);
    }
    const updated = await db.unsafe(`SELECT ${columns} FROM personal_hub.pr_watches WHERE id = $1`, [id]);
    return shape(updated[0]);
  }

  return { list, add, act, runnerWork, report };
}

export const prWatchStore = createPrWatchStore();
