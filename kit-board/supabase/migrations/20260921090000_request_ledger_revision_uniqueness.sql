-- Request ledger: collapse the Cursor replay rows and name the revision key.
--
-- What this deletes and why. The companion's cursor_execution adapter gave a bubble with no createdAt
-- the run timestamp as observed_at and ended_at, so every hourly run re-emitted the same record with a
-- new content_hash (the hash covers ended_at) and the revision key stored each copy as a new revision.
-- On 2026-09-21 production held 392,397 cursor/local_db rows for 8,785 records, one content variant per
-- record (verified read-only before this file was written: no (account_id, record_id) group differed in
-- anything but observed_at and ended_at), growing ~130k rows a day. This file keeps, per
-- (account_id, record_id) and identical content, the row with the earliest observed_at and deletes the
-- later sightings: 383,612 rows on that day's data, 8,785 kept. Content is every column except the
-- sighting columns (id, observed_at, ended_at, activity_at, received_at, content_hash) and the generated
-- token totals, the same rule `ingestUsage` now applies on the way in. Only provider = 'cursor' AND
-- channel = 'local_db' rows are examined; claude and codex rows, and any cursor row whose content differs,
-- are untouched. The revision key (account_id, semantic_key, channel, content_hash) already existed on
-- this table as the inline UNIQUE constraint of 20260912230000 under its default name; it is renamed to
-- activity_requests_revision so the four ledgers read alike, without a second index. The three event
-- ledgers' revision indexes are asserted with IF NOT EXISTS (production holds no duplicate on them).
--
-- Safety on live data. The DELETE takes ROW EXCLUSIVE on the table and row locks only on the rows it
-- removes, which no companion touches, so hourly uploads keep inserting. The rename is a catalog change.
-- lock_timeout keeps the DDL from queueing behind a long read; if it trips, the whole file rolls back and
-- can be rerun. ANALYZE gives the planner the new row count; autovacuum reclaims the dead tuples, or run
-- `VACUUM ANALYZE personal_hub.activity_requests` afterwards.
SET statement_timeout = '20min';
SET lock_timeout = '30s';

DELETE FROM personal_hub.activity_requests r
USING (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY account_id, record_id,
        to_jsonb(activity_requests) - '{id,observed_at,ended_at,activity_at,received_at,content_hash,total_tokens,observed_total_tokens}'::text[]
      ORDER BY observed_at, received_at, id) AS sighting
    FROM personal_hub.activity_requests
    WHERE provider = 'cursor' AND channel = 'local_db') ranked
  WHERE sighting > 1) replay
WHERE r.id = replay.id;

ANALYZE personal_hub.activity_requests;

DO $$
DECLARE
  current_name text;
  revision_columns int2[];
BEGIN
  SELECT array_agg(a.attnum ORDER BY c.ord) INTO revision_columns
  FROM unnest(ARRAY['account_id', 'semantic_key', 'channel', 'content_hash']) WITH ORDINALITY AS c(name, ord)
  JOIN pg_attribute a ON a.attrelid = 'personal_hub.activity_requests'::regclass AND a.attname = c.name;
  SELECT conname INTO current_name FROM pg_constraint
  WHERE conrelid = 'personal_hub.activity_requests'::regclass AND contype = 'u' AND conkey = revision_columns;
  IF current_name IS NULL THEN
    -- A database whose request ledger lost the inline constraint: recreate the key as an index.
    CREATE UNIQUE INDEX IF NOT EXISTS activity_requests_revision
      ON personal_hub.activity_requests (account_id, semantic_key, channel, content_hash);
  ELSIF current_name <> 'activity_requests_revision' THEN
    EXECUTE format('ALTER TABLE personal_hub.activity_requests RENAME CONSTRAINT %I TO activity_requests_revision', current_name);
  END IF;
END $$;

-- The event ledgers' revision keys, created with them by 20260913230451; asserted here without a notice.
DO $$
DECLARE ledger text;
BEGIN
  FOREACH ledger IN ARRAY ARRAY['agent_events', 'tool_events', 'resource_accesses'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'personal_hub' AND indexname = ledger || '_revision') THEN
      EXECUTE format('CREATE UNIQUE INDEX %I ON personal_hub.%I (account_id, semantic_key, channel, content_hash)', ledger || '_revision', ledger);
    END IF;
  END LOOP;
END $$;

RESET lock_timeout;
RESET statement_timeout;
