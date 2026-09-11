CREATE SCHEMA IF NOT EXISTS personal_hub;
REVOKE ALL ON SCHEMA personal_hub FROM PUBLIC;
SET search_path TO personal_hub;
CREATE TABLE IF NOT EXISTS report_revisions (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('usage','tasks','standup','readings','audit')),
  period_key text NOT NULL,
  subject_key text NOT NULL,
  producer_id text NOT NULL,
  idempotency_key text NOT NULL,
  title text NOT NULL,
  produced_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('complete','partial','failed')),
  schema_version integer NOT NULL,
  coverage jsonb NOT NULL,
  payload jsonb NOT NULL,
  html text,
  content_hash text NOT NULL,
  UNIQUE(producer_id, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS report_history ON report_revisions(kind, period_key DESC, produced_at DESC);
CREATE INDEX IF NOT EXISTS report_current ON report_revisions(kind, period_key, subject_key, produced_at DESC);
CREATE TABLE IF NOT EXISTS login_limits (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE report_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA personal_hub FROM PUBLIC;
