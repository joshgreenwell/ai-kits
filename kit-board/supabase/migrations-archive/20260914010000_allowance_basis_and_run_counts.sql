-- Allowance identity and freshness (USG-009): the readings ledger keeps the basis the
-- wire contract already carries, runs count their accepted uploads per record type, and
-- the per-binding last-observation reads get their indexes. Apply before the server code
-- that writes `basis`; readings accepted earlier were always provider-reported.
ALTER TABLE personal_hub.allowance_readings
  ADD COLUMN basis text NOT NULL DEFAULT 'reported' CHECK (basis IN ('exact','reported','estimated','unknown'));

-- The compatibility view gains `basis` as its last column (v1 samples are reported). Replacing
-- a view resets its options, so security_invoker and the grants are restated here.
CREATE OR REPLACE VIEW personal_hub.allowance_percent_view WITH (security_invoker = true) AS
  SELECT q.id, q.account_id, q.source_id, q.window_key, q.label, q.observed_at, q.received_at, q.used_percent, q.resets_at, q.window_minutes,
         'quota_samples'::text AS origin, 'v1'::text AS reader, 'reported'::text AS basis
    FROM personal_hub.quota_samples q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id AND NOT s.disabled
  UNION ALL
  SELECT r.id, r.account_id, b.source_id, r.meter_key, r.label, r.observed_at, r.received_at, r.value, r.resets_at, r.window_minutes,
         'allowance_readings'::text, r.reader, r.basis
    FROM personal_hub.allowance_readings r JOIN personal_hub.companion_bindings b ON b.id = r.binding_id AND b.enabled
    JOIN personal_hub.companion_installs i ON i.id = b.install_id AND NOT i.disabled
   WHERE r.kind = 'percent_used' AND r.resets_at IS NOT NULL AND r.window_minutes IS NOT NULL;
REVOKE ALL ON personal_hub.allowance_percent_view FROM PUBLIC, anon, authenticated;
GRANT SELECT ON personal_hub.allowance_percent_view TO personal_hub_app;

-- Accepted, duplicate, and rejected counts per record type (`invalid` for records that failed to
-- parse), summed key-wise across the envelopes of one run. Buckets stay in accepted_buckets.
ALTER TABLE personal_hub.companion_runs
  ADD COLUMN accepted_by_type jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The Connections page reads each binding's newest observation from the ledgers rather than
-- from collector contact, so a coverage-only receipt can never look like a fresh reading.
CREATE INDEX allowance_readings_binding_recent ON personal_hub.allowance_readings (binding_id, observed_at DESC);
CREATE INDEX activity_requests_binding_recent ON personal_hub.activity_requests (binding_id, observed_at DESC);
