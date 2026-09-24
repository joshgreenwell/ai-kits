// The PR watch runner's decisions, kept free of I/O so tests can drive them with fakes
// (tests/pr-watch.test.ts). scripts/pr-watch.mjs wires in GitHub (gh), Claude (claude --bg), and the
// site. docs/pr-watch.md explains the rules in prose.
import { createHash } from 'node:crypto';

/**
 * An AI review opens its body with "AI review": the skill's "AI review by <model> of `<head SHA>`.", or
 * the bold "**AI review — <model>.**" that earlier reviews used.
 */
const AI_REVIEW = /^\W*AI review\b/i;
const REVIEWED_SHA = /AI review by [^\n]+? of `([0-9a-f]{7,40})`/;

export const defaults = {
  model: 'claude-opus-5-5',
  effort: 'medium',
  permission_mode: 'auto',
  skill: 'luumen-ai-pr-review',
  max_concurrent: 2,
  review_timeout_minutes: 60,
};

export const short = sha => (sha ?? '').slice(0, 7);
export const sameCommit = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

/**
 * The head an AI review covered, or null for any other review: the SHA its body names, else the commit
 * GitHub recorded the review against, which is the head when it was submitted.
 */
export function aiReviewSha(review) {
  const body = review?.body ?? '';
  if (!AI_REVIEW.test(body)) return null;
  return REVIEWED_SHA.exec(body)?.[1] ?? (/^[0-9a-f]{40}$/.test(review.commit_id ?? '') ? review.commit_id : null);
}

/** The newest AI review the viewer posted, optionally only those submitted at or after `since`. */
export function latestAiReview(reviews, viewer, since) {
  const floor = since ? Date.parse(since) - 60_000 : -Infinity;
  return reviews
    .filter(review => review.user?.login?.toLowerCase() === viewer.toLowerCase() && aiReviewSha(review) && review.submitted_at && Date.parse(review.submitted_at) >= floor)
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))
    .map(review => ({ sha: aiReviewSha(review), url: review.html_url, submitted_at: review.submitted_at }))[0] ?? null;
}

/**
 * A fingerprint of what the PR changes, not where it sits: file names and statuses plus only the added
 * and removed lines. Hunk offsets are left out, so rebasing onto a moved base or merging the base in
 * leaves it alone while any edit to the PR's own lines changes it.
 */
export function diffFingerprint(files) {
  const parts = [...files]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map(file => {
      const lines = typeof file.patch === 'string'
        ? file.patch.split('\n').filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')).join('\n')
        // Binary files and very large diffs come without a patch; the file's blob stands in.
        : `blob:${file.sha ?? ''}:${file.additions ?? 0}:${file.deletions ?? 0}`;
      return [file.filename, file.status, file.previous_filename ?? '', lines].join('\0');
    });
  return createHash('sha256').update(parts.join('\0\0')).digest('hex');
}

/**
 * Whether a commit counts as the PR author updating the PR. Only a commit by another named person (a
 * teammate, or the owner pushing a fix to someone else's PR) does not. Bots count, since a workflow
 * that pushes fixes to the branch acts for the author, and so does an email linked to no account,
 * which cannot be told apart: a missed review costs more than an extra one.
 */
export function isAuthorCommit(commit, author) {
  const logins = [commit.author?.login, commit.committer?.login].filter(Boolean).map(login => login.toLowerCase());
  if (logins.includes(author.toLowerCase())) return true;
  return !commit.author || commit.author.type === 'Bot' || /\[bot\]$/i.test(commit.author.login ?? '');
}

/** `claude --bg` prints "backgrounded · <id> · <name>". */
export function backgroundedSession(stdout) {
  return /backgrounded\s*·\s*([A-Za-z0-9_-]{1,64})/.exec(stdout)?.[1] ?? null;
}

/** A background session is finished once it reports done, or is gone from the agent list. */
export function sessionState(agents, session) {
  const entry = agents.find(agent => agent.id === session || agent.sessionId === session);
  if (!entry) return { finished: true, label: 'gone' };
  const state = String(entry.state ?? entry.status ?? 'unknown');
  return { finished: ['done', 'failed', 'error', 'stopped', 'exited', 'killed'].includes(state), label: state };
}

export function reviewPrompt({ watch, pull, reason, since, skill }) {
  const repo = `${watch.owner}/${watch.repo}`;
  const head = pull.head.sha;
  const lines = [
    `/${skill} ${watch.url}`,
    '',
    'This follow-up AI review was started by the PR watch queue on the Personal Observatory. The owner asked for automatic AI reviews of this PR when they added it to the queue, which authorizes posting this one.',
    `- Why now: ${reason}`,
    `- Current head: ${head}.`,
  ];
  if (since && !sameCommit(since, head)) {
    lines.push(
      `- The last AI review covered ${since}. Review the PR at its current head as the skill requires, and start from what changed since then: \`gh api repos/${repo}/compare/${since}...${head}\`.`,
      '- Read the earlier AI reviews and their threads on this PR. In the review body, say which earlier findings the new changes resolve and which remain open. Do not post a finding that is still open again as a new inline comment.',
    );
  } else {
    lines.push('- There is no earlier AI review of this PR to follow up on; give it a full first review.');
  }
  lines.push(
    '- No one is watching this session, so do not stop to ask a question. If the skill says to ask the user something, post nothing and end with a one-paragraph explanation.',
    '- Do not switch branches or change files in any existing checkout. Read through gh, or use a temporary git worktree and remove it when you finish.',
  );
  return lines.join('\n');
}

/**
 * Decide what one tick does for one watch. Returns the report for the site and, when a review should
 * start or stop, the action for the caller to take. Nothing here touches the network.
 *
 * @param {object} input
 * @param {object} input.watch    the watch as the site returned it
 * @param {object} input.pull     GET /repos/{o}/{r}/pulls/{n}
 * @param {() => Promise<object[]>} input.files    the PR's changed files
 * @param {() => Promise<object[]>} input.reviews  the PR's reviews
 * @param {(base: string, head: string) => Promise<object[] | null>} input.newCommits  commits in head and not base, null when GitHub cannot compare them
 * @param {() => Promise<object[]>} input.agents   `claude agents --json --all`
 * @param {string} input.viewer   the gh login that posts the AI reviews
 * @param {boolean} input.slot    whether a review may start now (the concurrency cap)
 * @param {Date} input.now
 * @param {object} input.config
 */
export async function decide({ watch, pull, files, reviews, newCommits, agents, viewer, slot, now, config }) {
  const report = { checked_at: now.toISOString(), title: String(pull.title ?? '').slice(0, 300), author_login: pull.user?.login };
  const head = pull.head.sha;
  const author = pull.user?.login ?? '';

  if (watch.review_state === 'running') {
    // Read the session before the reviews: a review posted between the two reads is then seen as
    // posted rather than as a session that ended without one.
    const session = sessionState(await agents(), watch.review_session);
    const posted = latestAiReview(await reviews(), viewer, watch.review_started_at);
    if (posted) {
      const covered = sameCommit(posted.sha, head);
      return {
        report: {
          ...report,
          reviewed_sha: posted.sha,
          review: { event: 'posted', finished_at: posted.submitted_at, url: posted.url },
          // A review that reached the newest head covers any push made while it ran.
          ...(covered ? { head_sha: head, head_fingerprint: diffFingerprint(await files()) } : {}),
          note: `Reviewed ${short(posted.sha)}.${covered ? '' : ' The author pushed again while it ran; the next tick looks at that push.'}`,
          error: null,
        },
        action: session.finished ? null : { type: 'stop', session: watch.review_session },
      };
    }
    const minutes = (now.getTime() - Date.parse(watch.review_started_at)) / 60_000;
    if (session.finished) {
      return { report: { ...report, review: { event: 'failed', finished_at: now.toISOString() },
        error: `Review session ${watch.review_session} ended (${session.label}) without posting an AI review. Open it with: claude attach ${watch.review_session}` }, action: null };
    }
    if (minutes > config.review_timeout_minutes) {
      return { report: { ...report, review: { event: 'failed', finished_at: now.toISOString() },
        error: `Review session ${watch.review_session} ran past ${config.review_timeout_minutes} minutes and was stopped.` }, action: { type: 'stop', session: watch.review_session } };
    }
    return { report: { ...report, note: `Reviewing ${short(watch.review_target_sha)} in session ${watch.review_session} (${session.label}, ${Math.round(minutes)} min).` }, action: null };
  }

  // A stopped watch only comes back to finish a running review.
  if (watch.status !== 'watching') return { report: null, action: null };

  if (pull.state === 'closed') {
    return { report: { ...report, status: pull.merged ? 'merged' : 'closed', note: pull.merged ? 'Merged; the watch ended.' : 'Closed; the watch ended.' }, action: null };
  }

  const start = async (reason, since, extra = {}) => {
    const fingerprint = diffFingerprint(await files());
    if (!slot) {
      // Leave the head where it was, so the next tick reaches the same decision and starts it then.
      return { report: { ...report, ...extra, note: `Queued: ${reason} Waiting for a review slot (${config.max_concurrent} at a time).` }, action: null };
    }
    return {
      report: { ...report, ...extra, head_sha: head, head_fingerprint: fingerprint, error: null },
      action: { type: 'review', reason, since, target_sha: head },
    };
  };

  if (!watch.head_sha) {
    // First look: take the baseline from the viewer's last AI review, else from the head as it is now.
    const last = latestAiReview(await reviews(), viewer);
    if (!last) {
      if (watch.review_requested_at) return start('The owner asked for a review from the watch queue.', null, { baseline_source: 'watch_start' });
      return { report: { ...report, baseline_source: 'watch_start', head_sha: head, head_fingerprint: diffFingerprint(await files()),
        note: `No earlier AI review on this PR; watching from ${short(head)}. Use Review now for a first review.` }, action: null };
    }
    const baseline = { baseline_source: 'ai_review', reviewed_sha: last.sha };
    if (watch.review_requested_at) return start('The owner asked for a review from the watch queue.', last.sha, baseline);
    if (sameCommit(last.sha, head)) {
      return { report: { ...report, ...baseline, head_sha: head, head_fingerprint: diffFingerprint(await files()), note: `Watching from the AI review of ${short(last.sha)}.` }, action: null };
    }
    const commits = await newCommits(last.sha, head);
    const pushed = commits === null || commits.some(commit => isAuthorCommit(commit, author));
    if (pushed) return start(`New commits were pushed to ${author}'s PR since the last AI review of ${short(last.sha)}.`, last.sha, baseline);
    return { report: { ...report, ...baseline, head_sha: head, head_fingerprint: diffFingerprint(await files()),
      note: `Watching from ${short(head)}. The commits since the AI review of ${short(last.sha)} are not the author's.` }, action: null };
  }

  if (watch.review_requested_at) return start('The owner asked for a review from the watch queue.', watch.reviewed_sha);

  if (head === watch.head_sha) {
    return { report: { ...report, ...(watch.review_state === 'failed' ? {} : { note: watch.last_note ?? `No new commits since ${short(head)}.` }) }, action: null };
  }

  const fingerprint = diffFingerprint(await files());
  if (fingerprint === watch.head_fingerprint) {
    return { report: { ...report, head_sha: head, head_fingerprint: fingerprint, note: `The head moved to ${short(head)} without changing the diff (a rebase or a merge from the base); no review.` }, action: null };
  }
  const commits = await newCommits(watch.head_sha, head);
  const theirs = commits === null ? [] : commits.filter(commit => isAuthorCommit(commit, author));
  if (commits !== null && !theirs.length) {
    const others = [...new Set(commits.map(commit => commit.author?.login ?? commit.commit?.author?.name ?? 'someone'))].join(', ');
    return { report: { ...report, head_sha: head, head_fingerprint: fingerprint, note: `New commits by ${others || 'someone else'}, not the author; no review.` }, action: null };
  }
  const count = commits === null ? 'New commits' : `${theirs.length} new commit${theirs.length === 1 ? '' : 's'}`;
  return start(`${count} that change the diff ${commits !== null && theirs.length === 1 ? 'was' : 'were'} pushed to ${author}'s PR (head ${short(head)}).`, watch.reviewed_sha);
}
