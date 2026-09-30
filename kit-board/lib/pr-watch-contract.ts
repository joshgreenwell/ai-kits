import { z } from 'zod';
import { RequestError } from './contracts';
import type { PublishedContract } from './kits';

// The PR watch queue's shapes, shared by the page, the routes, and the store. The runner
// (kit-pr-watch/pr-watch.mjs) never imports them: `npm run contracts` writes the work list it reads and
// the report it posts to lib/generated/contracts/, and the kit tests every decision against its copies.

export const prWatchStatuses = ['watching', 'stopped', 'closed', 'merged'] as const;
export type PrWatchStatus = (typeof prWatchStatuses)[number];
export const prReviewStates = ['idle', 'running', 'failed'] as const;
export type PrReviewState = (typeof prReviewStates)[number];
/**
 * 'review' re-reviews someone else's PR when its author pushes; 'address' works through new review
 * comments on the owner's own PR and pushes the fixes.
 */
export const prWatchKinds = ['review', 'address'] as const;
export type PrWatchKind = (typeof prWatchKinds)[number];
export const addressOutcomes = ['pushed', 'no_change', 'needs_you'] as const;
export type AddressOutcome = (typeof addressOutcomes)[number];

export type PullRequestRef = { owner: string; repo: string; number: number };

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repoPattern = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Read a pasted pull request link. Only github.com PR pages count; a trailing tab such as /files or
 * /commits, a query, or a fragment is dropped, so any link copied from the PR resolves to the same watch.
 */
export function parsePullRequestUrl(input: string): PullRequestRef {
  const text = input.trim();
  let url: URL;
  try { url = new URL(text); } catch { throw new RequestError('Paste a GitHub pull request link, such as https://github.com/owner/repo/pull/123'); }
  if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new RequestError('Only https://github.com pull request links can be watched');
  }
  const [owner, repo, kind, number] = url.pathname.split('/').filter(Boolean);
  if (kind !== 'pull' || !owner || !repo || !number || !/^[1-9][0-9]{0,9}$/.test(number) || !ownerPattern.test(owner) || !repoPattern.test(repo) || repo === '.' || repo === '..') {
    throw new RequestError('That link is not a pull request; it should look like https://github.com/owner/repo/pull/123');
  }
  const parsed = Number(number);
  if (parsed > 2_147_483_647) throw new RequestError('That pull request number is out of range');
  return { owner, repo, number: parsed };
}

export const pullRequestUrl = (ref: PullRequestRef) => `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;

export const addWatchInput = z.strictObject({ url: z.string().min(1).max(500), kind: z.enum(prWatchKinds).default('review') });
export const watchActionInput = z.strictObject({ action: z.enum(['stop', 'review']) });

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const reviewedSha = z.string().regex(/^[0-9a-f]{7,40}$/);
const session = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const baselineSources = ['ai_review', 'watch_start'] as const;
const shortText = (max: number) => z.string().max(max).transform(value => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim());
/** Like shortText, but keeps line breaks, for a session's own summary. */
const longText = (max: number) => z.string().max(max).transform(value => value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
const timestamp = z.iso.datetime({ offset: true });
const githubUrl = z.string().max(500).regex(/^https:\/\/github\.com\//);

/**
 * What the runner reports after looking at one watch. Every field is optional: a tick that only saw an
 * unchanged head sends `checked_at` alone, and `null` clears a field (an error that went away).
 */
export const runnerReport = z.strictObject({
  checked_at: timestamp,
  // 'stopped' ends an address watch on a PR the owner did not open.
  status: z.enum(['watching', 'closed', 'merged', 'stopped']).optional(),
  title: shortText(300).optional(),
  author_login: z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/).optional(),
  head_sha: sha.optional(),
  head_fingerprint: fingerprint.optional(),
  reviewed_sha: reviewedSha.optional(),
  baseline_source: z.enum(baselineSources).optional(),
  // Address watches only: the newest comment taken on, and how many newer ones are waiting.
  comments_through: timestamp.optional(),
  comments_pending: z.number().int().min(0).max(10_000).optional(),
  review: z.discriminatedUnion('event', [
    // A session was started for this head: a review, or a pass over new comments.
    z.strictObject({ event: z.literal('started'), session, target_sha: sha, started_at: timestamp }),
    // A review session posted its review; the URL is that review on GitHub.
    z.strictObject({ event: z.literal('posted'), finished_at: timestamp, url: githubUrl }),
    // An address session finished and said what it did; the URL is the pushed range, when it pushed.
    z.strictObject({ event: z.literal('addressed'), finished_at: timestamp, outcome: z.enum(addressOutcomes), summary: longText(2000), url: githubUrl.nullable() }),
    // The session ended, or ran out of time, without a review on GitHub or a result.
    z.strictObject({ event: z.literal('failed'), finished_at: timestamp }),
  ]).optional(),
  note: shortText(500).nullable().optional(),
  error: shortText(500).nullable().optional(),
});
export type RunnerReport = z.infer<typeof runnerReport>;

export const runnerHeartbeat = z.strictObject({
  machine_label: shortText(80).optional(),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
});

/**
 * One watch as the board stores it: what the runner reads from GET /api/v1/pr-watches, and what the page
 * lists. Each rule is one the table's CHECK constraints already hold, so the board cannot send a watch
 * that fails it. The object is open: a runner ignores a field it does not know.
 */
export const prWatch = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  kind: z.enum(prWatchKinds),
  owner: z.string().regex(ownerPattern),
  repo: z.string().regex(repoPattern),
  number: z.number().int().min(1).max(2_147_483_647),
  url: z.string().regex(/^https:\/\/github\.com\//),
  status: z.enum(prWatchStatuses),
  title: z.string().max(300).nullable(),
  author_login: z.string().max(64).nullable(),
  head_sha: sha.nullable(),
  head_fingerprint: fingerprint.nullable(),
  reviewed_sha: reviewedSha.nullable().describe('The head the last review or pass covered; the baseline for the next one.'),
  baseline_source: z.enum(baselineSources).nullable(),
  review_state: z.enum(prReviewStates),
  review_session: session.nullable(),
  review_target_sha: sha.nullable(),
  review_started_at: timestamp.nullable(),
  review_finished_at: timestamp.nullable(),
  review_count: z.number().int().min(0).max(2_147_483_647),
  last_review_url: z.string().regex(/^https:\/\/github\.com\//).nullable(),
  review_requested_at: timestamp.nullable().describe('Set by Review now or Address now; the next tick starts a session.'),
  last_checked_at: timestamp.nullable(),
  last_note: z.string().max(500).nullable(),
  last_error: z.string().max(500).nullable(),
  comments_through: timestamp.nullable().describe('Address watches: the newest comment a pass has taken on.'),
  comments_pending: z.number().int().min(0).max(10_000),
  last_outcome: z.enum(addressOutcomes).nullable(),
  last_summary: z.string().max(2000).nullable(),
  created_at: timestamp,
  stopped_at: timestamp.nullable(),
});
export type PrWatch = z.infer<typeof prWatch>;

/** GET /api/v1/pr-watches: every watch of either kind that still needs the runner. */
export const runnerWork = z.object({ watches: z.array(prWatch) });

export type PrWatchRunner = { producer_id: string; machine_label: string | null; version: string | null; last_seen_at: string };
export type PrWatchList = { watches: PrWatch[]; runners: PrWatchRunner[]; as_of: string };

const reviewWatch = {
  id: '00000000-0000-4000-8000-000000000012', kind: 'review', owner: 'example-owner', repo: 'example-app', number: 12,
  url: 'https://github.com/example-owner/example-app/pull/12', status: 'watching', title: 'Add the deployment checklist', author_login: 'example-author',
  head_sha: 'a'.repeat(40), head_fingerprint: 'c'.repeat(64), reviewed_sha: 'a'.repeat(40), baseline_source: 'ai_review',
  review_state: 'idle', review_session: null, review_target_sha: null, review_started_at: null, review_finished_at: null, review_count: 1,
  last_review_url: 'https://github.com/example-owner/example-app/pull/12#pullrequestreview-1', review_requested_at: null,
  last_checked_at: '2026-09-29T14:00:00.000Z', last_note: 'Watching from the AI review of aaaaaaa.', last_error: null,
  comments_through: null, comments_pending: 0, last_outcome: null, last_summary: null, created_at: '2026-09-28T15:30:00.000Z', stopped_at: null,
} as const;

const addressWatch = {
  id: '00000000-0000-4000-8000-000000000014', kind: 'address', owner: 'example-owner', repo: 'example-app', number: 14,
  url: 'https://github.com/example-owner/example-app/pull/14', status: 'watching', title: 'Cache the release lookup', author_login: 'example-owner',
  head_sha: 'd'.repeat(40), head_fingerprint: null, reviewed_sha: null, baseline_source: null,
  review_state: 'running', review_session: 'example-session', review_target_sha: 'd'.repeat(40), review_started_at: '2026-09-29T13:55:00.000Z',
  review_finished_at: null, review_count: 0, last_review_url: null, review_requested_at: null, last_checked_at: '2026-09-29T14:00:00.000Z',
  last_note: 'Addressing comments in session example-session (running, 5 min).', last_error: null,
  comments_through: '2026-09-29T13:40:00.000Z', comments_pending: 0, last_outcome: null, last_summary: null, created_at: '2026-09-29T09:00:00.000Z', stopped_at: null,
} as const;

/**
 * The two contracts the runner speaks, published beside the report contracts by `npm run contracts`.
 * kit-pr-watch keeps copies and tests every report its decisions produce against them.
 */
export const prWatchContracts = {
  'pr-watch-work-v1': {
    id: 'pr-watch-work-v1',
    title: 'PR watch work list',
    summary: "What GET /api/v1/pr-watches answers the runner: every watch that is live or still has a session running, of either kind. The board may add fields; a runner ignores those it does not read.",
    schema: runnerWork,
    example: { watches: [reviewWatch, addressWatch] },
  },
  'pr-watch-report-v1': {
    id: 'pr-watch-report-v1',
    title: 'PR watch report',
    summary: 'What the runner posts to /api/v1/pr-watches/:id after one look at a watch: what it saw, and any session it started or saw finish. Only checked_at is required; null clears a note or an error.',
    schema: runnerReport,
    example: {
      checked_at: '2026-09-29T14:05:00.000Z', title: 'Add the deployment checklist', author_login: 'example-author',
      head_sha: 'b'.repeat(40), head_fingerprint: 'e'.repeat(64),
      review: { event: 'started', session: 'example-session', target_sha: 'b'.repeat(40), started_at: '2026-09-29T14:05:00.000Z' },
      note: "Review started in session example-session: 1 new commit that changes the diff was pushed to example-author's PR (head bbbbbbb).",
      error: null,
    },
  },
} as const satisfies Record<string, PublishedContract>;
