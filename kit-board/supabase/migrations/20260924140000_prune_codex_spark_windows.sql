-- Prune: remove the Codex Spark windows (codex_bengalfox:300 and codex_bengalfox:10080), keeping a copy
-- of every removed row in personal_hub_archive.
--
-- What goes and why. Measured read-only on 2026-09-24 just before this was written: 174 allowance
-- readings (codex-primary, embedded reader, 2026-08-01 to 2026-09-16 23:52) and 56 v1 quota samples
-- (codex-primary, 2026-09-01 to 2026-09-13). Nearly all read 0%, and each sits on its own floating reset
-- anchor, so the history is about 61 one-sample cycles that draw nothing useful behind the Spark toggle.
-- They are real observations, left out of 20260924130000 for that reason, and are pruned now on request.
-- Codex has reported no Spark window since 2026-09-16. The collector still records one if Codex reports
-- it again (codex_account.rs keys every rate-limit window it is given), so new rows would reappear.
--
-- References. usage_calibrations points at quota_samples through start_sample_id and end_sample_id; no
-- calibration uses a Spark window or a Spark sample (verified: 0 and 0), and the check below refuses
-- the delete if one does. Nothing else references either table, and neither feeds a projection.
--
-- Counts. Each batch asserts the exact count measured on 2026-09-24. If the data has moved, the
-- assertion raises, the whole file rolls back and nothing is deleted.
--
-- The archive. The readings go to the allowance_readings_pruned table 20260924130000 created; the
-- samples get a quota_samples_pruned table in the same schema, owner-only with RLS on. Undo with
--   INSERT INTO personal_hub.<table> (<columns>) SELECT <columns> FROM personal_hub_archive.<table>_pruned
--   WHERE prune_batch = 'codex-spark';
--
-- Production only. The production Mac install exists there and nowhere else, so on any other database
-- (the disposable cluster `npm run test:db` builds) only the empty archive table is created.
SET lock_timeout = '30s';
SET statement_timeout = '5min';

CREATE TABLE personal_hub_archive.quota_samples_pruned (LIKE personal_hub.quota_samples, prune_batch text NOT NULL, pruned_at timestamptz NOT NULL);
REVOKE ALL ON personal_hub_archive.quota_samples_pruned FROM PUBLIC;
ALTER TABLE personal_hub_archive.quota_samples_pruned ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM personal_hub.companion_installs WHERE id = '2cf53a04-3680-473f-8726-f98618f5899a') THEN
    RAISE NOTICE 'prune_codex_spark_windows: not the production dataset, nothing to prune';
    RETURN;
  END IF;

  WITH gone AS (
    DELETE FROM personal_hub.allowance_readings
    WHERE meter_key IN ('codex_bengalfox:300', 'codex_bengalfox:10080')
    RETURNING *)
  INSERT INTO personal_hub_archive.allowance_readings_pruned SELECT gone.*, 'codex-spark', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 174 THEN RAISE EXCEPTION 'codex-spark: expected 174 allowance readings, got %', n; END IF;

  IF EXISTS (SELECT 1 FROM personal_hub.usage_calibrations c
             JOIN personal_hub.quota_samples q ON q.id IN (c.start_sample_id, c.end_sample_id)
             WHERE q.window_key IN ('codex_bengalfox:300', 'codex_bengalfox:10080')) THEN
    RAISE EXCEPTION 'codex-spark: a calibration references a Spark sample';
  END IF;
  WITH gone AS (
    DELETE FROM personal_hub.quota_samples
    WHERE window_key IN ('codex_bengalfox:300', 'codex_bengalfox:10080')
    RETURNING *)
  INSERT INTO personal_hub_archive.quota_samples_pruned SELECT gone.*, 'codex-spark', now() FROM gone;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 56 THEN RAISE EXCEPTION 'codex-spark: expected 56 quota samples, got %', n; END IF;
END $$;
