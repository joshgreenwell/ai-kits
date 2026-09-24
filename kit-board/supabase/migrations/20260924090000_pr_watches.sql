-- PR watch queue (docs/pr-watch.md).
--
-- The site holds the queue and the Mac does the work: the owner pastes a pull request on /reviews, and
-- the local runner (scripts/pr-watch.mjs, every five minutes under launchd) polls GitHub for each
-- watch, starts a follow-up AI review when the PR author pushes a change to the diff, and reports what
-- it saw back here. Nothing deletes: stopping a watch is a status, and a stopped PR can be watched
-- again as a new row.

CREATE TABLE personal_hub.pr_watches (
  id                  uuid PRIMARY KEY,
  owner               text NOT NULL CHECK (owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  repo                text NOT NULL CHECK (repo ~ '^[A-Za-z0-9._-]{1,100}$'),
  number              integer NOT NULL CHECK (number > 0),
  status              text NOT NULL DEFAULT 'watching' CHECK (status IN ('watching','stopped','closed','merged')),
  title               text CHECK (char_length(title) <= 300),
  author_login        text CHECK (char_length(author_login) <= 64),
  -- The last head the runner saw and the fingerprint of the PR diff at that head, so a rebase or a
  -- merge from the base that leaves the diff unchanged is not a new change.
  head_sha            text CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  head_fingerprint    text CHECK (head_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The head the latest AI review covered, read back from that review's body on GitHub.
  reviewed_sha        text CHECK (reviewed_sha ~ '^[0-9a-f]{7,40}$'),
  baseline_source     text CHECK (baseline_source IN ('ai_review','watch_start')),
  review_state        text NOT NULL DEFAULT 'idle' CHECK (review_state IN ('idle','running','failed')),
  review_session      text CHECK (review_session ~ '^[A-Za-z0-9_-]{1,64}$'),
  review_target_sha   text CHECK (review_target_sha ~ '^[0-9a-f]{40}$'),
  review_started_at   timestamptz,
  review_finished_at  timestamptz,
  review_count        integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  last_review_url     text CHECK (last_review_url ~ '^https://github\.com/'),
  -- Set from the page to ask for a review on the next tick whatever the author did.
  review_requested_at timestamptz,
  last_checked_at     timestamptz,
  last_note           text CHECK (char_length(last_note) <= 500),
  last_error          text CHECK (char_length(last_error) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  stopped_at          timestamptz,
  CONSTRAINT pr_watches_running_shape CHECK (
    review_state <> 'running' OR (review_started_at IS NOT NULL AND review_target_sha IS NOT NULL))
);
-- One live watch per pull request; GitHub owner and repository names are case-insensitive.
CREATE UNIQUE INDEX pr_watches_one_active ON personal_hub.pr_watches (lower(owner), lower(repo), number) WHERE status = 'watching';
CREATE INDEX pr_watches_recent ON personal_hub.pr_watches (created_at DESC);

ALTER TABLE personal_hub.pr_watches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.pr_watches FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON personal_hub.pr_watches FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON personal_hub.pr_watches FROM authenticated'; END IF;
END $$;
GRANT SELECT, INSERT ON personal_hub.pr_watches TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.pr_watches FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.pr_watches FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.pr_watches FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
GRANT UPDATE (status, title, author_login, head_sha, head_fingerprint, reviewed_sha, baseline_source, review_state,
  review_session, review_target_sha, review_started_at, review_finished_at, review_count, last_review_url,
  review_requested_at, last_checked_at, last_note, last_error, updated_at, stopped_at) ON personal_hub.pr_watches TO personal_hub_app;

-- When the runner last asked for work, so the page can say whether anything is polling at all.
CREATE TABLE personal_hub.pr_watch_runners (
  producer_id   text PRIMARY KEY CHECK (char_length(producer_id) BETWEEN 1 AND 64),
  machine_label text CHECK (char_length(machine_label) <= 80),
  version       text CHECK (char_length(version) <= 32),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE personal_hub.pr_watch_runners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.pr_watch_runners FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON personal_hub.pr_watch_runners FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON personal_hub.pr_watch_runners FROM authenticated'; END IF;
END $$;
GRANT SELECT, INSERT ON personal_hub.pr_watch_runners TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.pr_watch_runners FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.pr_watch_runners FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.pr_watch_runners FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
GRANT UPDATE (machine_label, version, last_seen_at) ON personal_hub.pr_watch_runners TO personal_hub_app;
