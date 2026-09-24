-- Prune: remove four sets of rows found by a read-only review of production on 2026-09-24, keeping a
-- copy of every removed row in personal_hub_archive.
--
-- What goes and why.
-- A. Codex weekly, 24 allowance readings. After the 2026-09-19 14:41Z reset, the app_server reader on
--    both machines kept reporting the pre-reset used value (100) under the next reset anchor
--    (2026-09-26 15:02) until 2026-09-20 02:46, while the embedded reader reported 1-2%. Each flip counted
--    as +99 in Observed burn: 397 pts on 09-19, and 984 pts over 30 days instead of 589, plus the spikes
--    in the allowance chart. The app_server 0% reading at 15:05 and every embedded row stay.
-- B. Cursor premium_requests, 60 readings (the PC's cursor-personal account only, last reading
--    2026-09-21 02:46). The superseded combined meter, replaced by the auto and api meters; it only draws
--    a permanently stale card.
-- C. Cursor local requests from parser 2.0.0+cursor-local1, 8,785 activity_requests rows and their
--    8,785 canonical_requests rows (8,713 on cursor-personal, 72 on cursor-primary). None has a start
--    time: each carries the first collector run's clock, so 7,888 land in one hour on the evening of
--    2026-09-17 (Chicago) and make that day's request-count spike. None carries tokens. Both machines now
--    run 2.2.0+cursor-local2, which emits no records, so nothing re-uploads them. These are all the Cursor
--    request rows there are.
-- D. Retired reset feeds codex-forecast, codex-timeline and codex-announcements: 22 revisions and 3
--    state rows. No longer configured in lib/reset-feeds.ts and already filtered out of the dashboard by
--    activeResetFeeds; codex-forecast still holds a v5:http_403. Revisions go first because
--    reset_feed_revisions.source references reset_feed_state.
-- Not included: the Codex Spark windows (codex_bengalfox:*, 174 readings and 56 v1 samples). They are
-- real observations, only useless; prune them separately if wanted.
--
-- The projection rule of 20260922120000. Deleting ledger rows requires rebuilding canonical_requests.
-- Every batch-C key has exactly one revision (verified: no other revision shares an (account_id,
-- semantic_key) with a local1 row), so there is no lower-ranked survivor to promote and deleting the
-- projection rows is the rebuild. The orphan check proves no projection row points at a deleted revision.
--
-- Counts. Each batch asserts the exact count measured on 2026-09-24 immediately before this was
-- written. If the data has moved, the assertion raises, the whole file rolls back and nothing is deleted.
--
-- The archive. personal_hub_archive holds one <table>_pruned copy per table with the batch name and
-- time. No role but the owner can read it (no grants, RLS on). Generated columns (activity_requests'
-- token totals and activity_at) are kept as plain values. Undo a batch with
--   INSERT INTO personal_hub.<table> (<columns>) SELECT <columns> FROM personal_hub_archive.<table>_pruned
--   WHERE prune_batch = '<batch>';
-- listing the columns and leaving out generated ones. Drop the schema in a later migration once it is
-- no longer wanted.
--
-- Safety on live data. The DELETEs take row locks only on the rows they remove, which no collector
-- writes any more, so hourly uploads keep inserting. lock_timeout keeps the file from queueing behind a
-- long read; if it trips, the file rolls back and can be rerun.
SET lock_timeout = '30s';
SET statement_timeout = '10min';

CREATE SCHEMA personal_hub_archive;
REVOKE ALL ON SCHEMA personal_hub_archive FROM PUBLIC;

CREATE TABLE personal_hub_archive.allowance_readings_pruned (LIKE personal_hub.allowance_readings, prune_batch text NOT NULL, pruned_at timestamptz NOT NULL);
CREATE TABLE personal_hub_archive.activity_requests_pruned (LIKE personal_hub.activity_requests, prune_batch text NOT NULL, pruned_at timestamptz NOT NULL);
CREATE TABLE personal_hub_archive.canonical_requests_pruned (LIKE personal_hub.canonical_requests, prune_batch text NOT NULL, pruned_at timestamptz NOT NULL);
CREATE TABLE personal_hub_archive.reset_feed_revisions_pruned (LIKE personal_hub.reset_feed_revisions, prune_batch text NOT NULL, pruned_at timestamptz NOT NULL);
CREATE TABLE personal_hub_archive.reset_feed_state_pruned (LIKE personal_hub.reset_feed_state, prune_batch text NOT NULL, pruned_at timestamptz NOT NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA personal_hub_archive FROM PUBLIC;
ALTER TABLE personal_hub_archive.allowance_readings_pruned   ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_hub_archive.activity_requests_pruned    ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_hub_archive.canonical_requests_pruned   ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_hub_archive.reset_feed_revisions_pruned ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_hub_archive.reset_feed_state_pruned     ENABLE ROW LEVEL SECURITY;

-- The deletes run on production only. The production Mac install exists there and nowhere else; the
-- disposable cluster `npm run test:db` builds seeds its own Cursor local1 fixture rows, which a later
-- test reads, so on any other database only the (empty) archive schema above is created.
DO $$
DECLARE n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM personal_hub.companion_installs WHERE id = '2cf53a04-3680-473f-8726-f98618f5899a') THEN
    RAISE NOTICE 'prune_stale_readings_and_retired_rows: not the production dataset, nothing to prune';
    RETURN;
  END IF;

  -- A. Codex weekly: stale 100% readings stamped with the new reset anchor.
  WITH gone AS (
    DELETE FROM personal_hub.allowance_readings
    WHERE account_id = 'codex-primary' AND meter_key = 'codex:10080' AND reader = 'app_server'
      AND value >= 99 AND resets_at >= '2026-09-26 15:00+00'
      AND observed_at >= '2026-09-19 14:41+00' AND observed_at < '2026-09-20 03:17+00'
    RETURNING *)
  INSERT INTO personal_hub_archive.allowance_readings_pruned SELECT gone.*, 'codex-weekly-stale-100', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 24 THEN RAISE EXCEPTION 'codex-weekly-stale-100: expected 24 rows, got %', n; END IF;

  -- B. Cursor premium_requests: the superseded combined meter.
  WITH gone AS (
    DELETE FROM personal_hub.allowance_readings
    WHERE account_id = 'cursor-personal' AND meter_key = 'premium_requests'
    RETURNING *)
  INSERT INTO personal_hub_archive.allowance_readings_pruned SELECT gone.*, 'cursor-premium-requests', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 60 THEN RAISE EXCEPTION 'cursor-premium-requests: expected 60 rows, got %', n; END IF;

  -- C. Cursor local1 requests: projection rows first, then the ledger rows they point at.
  IF EXISTS (SELECT 1 FROM personal_hub.activity_requests a
             WHERE a.provider = 'cursor' AND a.channel = 'local_db' AND a.parser_version = '2.0.0+cursor-local1'
               AND EXISTS (SELECT 1 FROM personal_hub.activity_requests o
                           WHERE o.account_id = a.account_id AND o.semantic_key = a.semantic_key AND o.id <> a.id)) THEN
    RAISE EXCEPTION 'cursor-local1-run-clock: a key has a second revision; the projection needs a real rebuild';
  END IF;
  WITH gone AS (
    DELETE FROM personal_hub.canonical_requests c
    USING personal_hub.activity_requests a
    WHERE a.id = c.revision_id AND a.provider = 'cursor' AND a.channel = 'local_db' AND a.parser_version = '2.0.0+cursor-local1'
    RETURNING c.*)
  INSERT INTO personal_hub_archive.canonical_requests_pruned SELECT gone.*, 'cursor-local1-run-clock', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 8785 THEN RAISE EXCEPTION 'cursor-local1-run-clock: expected 8785 projection rows, got %', n; END IF;
  WITH gone AS (
    DELETE FROM personal_hub.activity_requests
    WHERE provider = 'cursor' AND channel = 'local_db' AND parser_version = '2.0.0+cursor-local1'
    RETURNING *)
  INSERT INTO personal_hub_archive.activity_requests_pruned SELECT gone.*, 'cursor-local1-run-clock', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 8785 THEN RAISE EXCEPTION 'cursor-local1-run-clock: expected 8785 ledger rows, got %', n; END IF;
  IF EXISTS (SELECT 1 FROM personal_hub.canonical_requests c
             WHERE NOT EXISTS (SELECT 1 FROM personal_hub.activity_requests a WHERE a.id = c.revision_id)) THEN
    RAISE EXCEPTION 'canonical_requests would point at a deleted revision';
  END IF;

  -- D. Retired reset feeds: revisions, then the state rows they reference.
  WITH gone AS (
    DELETE FROM personal_hub.reset_feed_revisions
    WHERE source IN ('codex-forecast', 'codex-timeline', 'codex-announcements')
    RETURNING *)
  INSERT INTO personal_hub_archive.reset_feed_revisions_pruned SELECT gone.*, 'retired-reset-feeds', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 22 THEN RAISE EXCEPTION 'retired-reset-feeds: expected 22 revisions, got %', n; END IF;
  WITH gone AS (
    DELETE FROM personal_hub.reset_feed_state
    WHERE source IN ('codex-forecast', 'codex-timeline', 'codex-announcements')
    RETURNING *)
  INSERT INTO personal_hub_archive.reset_feed_state_pruned SELECT gone.*, 'retired-reset-feeds', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 3 THEN RAISE EXCEPTION 'retired-reset-feeds: expected 3 state rows, got %', n; END IF;
END $$;
