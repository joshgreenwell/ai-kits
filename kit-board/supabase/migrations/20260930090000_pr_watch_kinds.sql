-- PR watch queue, second kind: address review comments on the owner's own pull requests
-- (docs/pr-watch.md).
--
-- A 'review' watch (every row so far) re-reviews someone else's PR when its author pushes. An 'address'
-- watch runs the other way: when reviewers or review bots leave new comments on one of the owner's PRs,
-- the runner starts a background session that works through them and pushes fixes. Both kinds share the
-- row shape; the review_* columns hold whichever session the watch last ran, and review_count counts
-- passes of either kind.

ALTER TABLE personal_hub.pr_watches
  ADD COLUMN kind text NOT NULL DEFAULT 'review' CHECK (kind IN ('review','address')),
  -- The newest review comment an address pass has taken on; comments after it are new.
  ADD COLUMN comments_through timestamptz,
  -- New comments after comments_through that no pass has taken on yet, for the page.
  ADD COLUMN comments_pending integer NOT NULL DEFAULT 0 CHECK (comments_pending BETWEEN 0 AND 10000),
  -- What the last address pass did, and its own summary of it, including any questions for the owner.
  ADD COLUMN last_outcome text CHECK (last_outcome IN ('pushed','no_change','needs_you')),
  ADD COLUMN last_summary text CHECK (char_length(last_summary) <= 2000),
  ADD CONSTRAINT pr_watches_kind_columns CHECK (
    kind = 'address' OR (comments_through IS NULL AND comments_pending = 0 AND last_outcome IS NULL AND last_summary IS NULL));

-- One live watch per pull request and kind: a PR can be re-reviewed and have its comments addressed.
DROP INDEX personal_hub.pr_watches_one_active;
CREATE UNIQUE INDEX pr_watches_one_active ON personal_hub.pr_watches (kind, lower(owner), lower(repo), number) WHERE status = 'watching';

-- The kind is fixed at insert, like the PR a watch points at: it is not in the update grant.
GRANT UPDATE (comments_through, comments_pending, last_outcome, last_summary) ON personal_hub.pr_watches TO personal_hub_app;
