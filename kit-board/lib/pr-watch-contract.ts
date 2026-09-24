import { z } from 'zod';
import { RequestError } from './contracts';

// The PR watch queue's shapes, shared by the page, the routes, and the store. The runner
// (scripts/pr-watch.mjs) speaks the same report shape without importing it, so the schema here is
// the contract it is tested against (tests/pr-watch.test.ts).

export const prWatchStatuses = ['watching', 'stopped', 'closed', 'merged'] as const;
export type PrWatchStatus = (typeof prWatchStatuses)[number];
export type PrReviewState = 'idle' | 'running' | 'failed';

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

export const addWatchInput = z.strictObject({ url: z.string().min(1).max(500) });
export const watchActionInput = z.strictObject({ action: z.enum(['stop', 'review']) });

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const shortText = (max: number) => z.string().max(max).transform(value => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim());

/**
 * What the runner reports after looking at one watch. Every field is optional: a tick that only saw an
 * unchanged head sends `checked_at` alone, and `null` clears a field (an error that went away).
 */
export const runnerReport = z.strictObject({
  checked_at: z.iso.datetime({ offset: true }),
  status: z.enum(['watching', 'closed', 'merged']).optional(),
  title: shortText(300).optional(),
  author_login: z.string().regex(/^[A-Za-z0-9-]{1,39}(\[bot\])?$/).optional(),
  head_sha: sha.optional(),
  head_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  reviewed_sha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  baseline_source: z.enum(['ai_review', 'watch_start']).optional(),
  review: z.discriminatedUnion('event', [
    // A review session was started for this head.
    z.strictObject({ event: z.literal('started'), session: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), target_sha: sha, started_at: z.iso.datetime({ offset: true }) }),
    // The session posted its review; the URL is that review on GitHub.
    z.strictObject({ event: z.literal('posted'), finished_at: z.iso.datetime({ offset: true }), url: z.string().max(500).regex(/^https:\/\/github\.com\//) }),
    // The session ended, or ran out of time, without a review on GitHub.
    z.strictObject({ event: z.literal('failed'), finished_at: z.iso.datetime({ offset: true }) }),
  ]).optional(),
  note: shortText(500).nullable().optional(),
  error: shortText(500).nullable().optional(),
});
export type RunnerReport = z.infer<typeof runnerReport>;

export const runnerHeartbeat = z.strictObject({
  machine_label: shortText(80).optional(),
  version: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
});

export type PrWatch = PullRequestRef & {
  id: string;
  url: string;
  status: PrWatchStatus;
  title: string | null;
  author_login: string | null;
  head_sha: string | null;
  head_fingerprint: string | null;
  reviewed_sha: string | null;
  baseline_source: 'ai_review' | 'watch_start' | null;
  review_state: PrReviewState;
  review_session: string | null;
  review_target_sha: string | null;
  review_started_at: string | null;
  review_finished_at: string | null;
  review_count: number;
  last_review_url: string | null;
  review_requested_at: string | null;
  last_checked_at: string | null;
  last_note: string | null;
  last_error: string | null;
  created_at: string;
  stopped_at: string | null;
};

export type PrWatchRunner = { producer_id: string; machine_label: string | null; version: string | null; last_seen_at: string };
export type PrWatchList = { watches: PrWatch[]; runners: PrWatchRunner[]; as_of: string };
