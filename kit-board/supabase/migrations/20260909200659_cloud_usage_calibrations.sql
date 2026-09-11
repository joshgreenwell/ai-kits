CREATE TABLE personal_hub.usage_calibrations (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  window_key text NOT NULL CHECK (window_key IN ('five_hour', 'seven_day')),
  window_minutes integer NOT NULL CHECK (
    (window_key = 'five_hour' AND window_minutes = 300) OR
    (window_key = 'seven_day' AND window_minutes = 10080)),
  start_sample_id uuid NOT NULL REFERENCES personal_hub.quota_samples(id),
  end_sample_id uuid NOT NULL REFERENCES personal_hub.quota_samples(id),
  started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
  local_tokens double precision NOT NULL CHECK (local_tokens > 0 AND local_tokens < 'Infinity'::float8),
  percent_delta double precision NOT NULL CHECK (percent_delta BETWEEN 3 AND 100),
  tokens_per_point double precision NOT NULL CHECK (tokens_per_point > 0 AND tokens_per_point < 'Infinity'::float8),
  method_version text NOT NULL CHECK (method_version = 'local-equivalent-v1-prorated-hours'),
  confirmed_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  CHECK (ended_at >= started_at + interval '2 hours'),
  CHECK (end_sample_id != start_sample_id)
);
CREATE UNIQUE INDEX usage_calibration_receipt ON personal_hub.usage_calibrations (account_id, start_sample_id, end_sample_id, method_version) WHERE revoked_at IS NULL;
CREATE INDEX usage_calibration_active ON personal_hub.usage_calibrations (account_id, confirmed_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX usage_calibration_start ON personal_hub.usage_calibrations (start_sample_id);
CREATE INDEX usage_calibration_end ON personal_hub.usage_calibrations (end_sample_id);
ALTER TABLE personal_hub.usage_calibrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.usage_calibrations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON personal_hub.usage_calibrations TO personal_hub_app;
GRANT UPDATE (revoked_at) ON personal_hub.usage_calibrations TO personal_hub_app;
CREATE POLICY app_read ON personal_hub.usage_calibrations FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.usage_calibrations FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_revoke ON personal_hub.usage_calibrations FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
