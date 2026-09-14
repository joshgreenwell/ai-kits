-- Historical ledgers stay visible after their source stops (USG-011). Disabling a source,
-- binding, or install means "stop new uploads"; it never meant "hide what was observed".
--
-- 1. token_bucket_canonical states the one nonregressing selection rule for hourly buckets
--    (account + session + UTC hour + model: most calls, then most tokens, then newest
--    observation and receipt) so the dashboard, the reconciliation report, and the tests read
--    the same definition. Revisions from retired v1 sources and from the companion select
--    together; a v1-only key is preserved as a coarse row, a shared key is counted once.
-- 2. allowance_percent_view no longer filters disabled sources or disabled bindings and
--    installs. Each row carries `history_only`: true when its producer is disabled, so the
--    readers keep those observations for cycle history and never select one as the current
--    reading. A v1 sample that a v2 reading duplicates exactly (same account, meter, observation
--    time, value, and reset anchor: the two hooks read the same inbox) is shown once, as the v2
--    reading, so old and new copies never appear twice. The v2 copy must itself be a row this view
--    exposes and must be live unless the v1 source is disabled too, so a disabled binding never
--    demotes an enabled browser source's observation to history.
-- No table changes, no new grants beyond SELECT on the new view.
CREATE VIEW personal_hub.token_bucket_canonical WITH (security_invoker = true) AS
  SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model)
         t.id, t.account_id, t.source_id, t.session_hash, t.hour, t.model, t.observed_at, t.received_at, t.content_hash,
         t.input_tokens, t.cached_tokens, t.cache_write_tokens, t.output_tokens, t.total_tokens, t.calls,
         s.mode AS source_mode, s.disabled AS source_disabled
    FROM personal_hub.token_bucket_revisions t
    JOIN personal_hub.telemetry_sources s ON s.id = t.source_id
   ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC;
REVOKE ALL ON personal_hub.token_bucket_canonical FROM PUBLIC, anon, authenticated;
GRANT SELECT ON personal_hub.token_bucket_canonical TO personal_hub_app;

-- Replacing a view resets its options, so security_invoker and the grants are restated.
CREATE OR REPLACE VIEW personal_hub.allowance_percent_view WITH (security_invoker = true) AS
  SELECT q.id, q.account_id, q.source_id, q.window_key, q.label, q.observed_at, q.received_at, q.used_percent, q.resets_at, q.window_minutes,
         'quota_samples'::text AS origin, 'v1'::text AS reader, 'reported'::text AS basis,
         s.disabled AS history_only
    FROM personal_hub.quota_samples q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id
   WHERE NOT EXISTS (
     SELECT 1 FROM personal_hub.allowance_readings r
       JOIN personal_hub.companion_bindings rb ON rb.id = r.binding_id
       JOIN personal_hub.companion_installs ri ON ri.id = rb.install_id
      WHERE r.account_id = q.account_id AND r.meter_key = q.window_key AND r.observed_at = q.observed_at
        AND r.kind = 'percent_used' AND r.value = q.used_percent AND r.resets_at = q.resets_at AND r.window_minutes IS NOT NULL
        AND (s.disabled OR (rb.enabled AND NOT ri.disabled)))
  UNION ALL
  SELECT r.id, r.account_id, b.source_id, r.meter_key, r.label, r.observed_at, r.received_at, r.value, r.resets_at, r.window_minutes,
         'allowance_readings'::text, r.reader, r.basis,
         (NOT b.enabled OR i.disabled) AS history_only
    FROM personal_hub.allowance_readings r JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
    JOIN personal_hub.companion_installs i ON i.id = b.install_id
   WHERE r.kind = 'percent_used' AND r.resets_at IS NOT NULL AND r.window_minutes IS NOT NULL;
REVOKE ALL ON personal_hub.allowance_percent_view FROM PUBLIC, anon, authenticated;
GRANT SELECT ON personal_hub.allowance_percent_view TO personal_hub_app;
