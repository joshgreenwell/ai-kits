-- Monthly report subjects crosswalk (USG-012). A detailed monthly envelope names a machine
-- subject (`report_revisions.subject_key`), not a usage account. Mapping a subject to the
-- logical account it reports on lets the query layer use its retained monthly and daily rows
-- as historical fallback for periods the hourly ledger never covered, and only there. The
-- source zone is the IANA zone the analyzer's calendar days were computed in; without it a
-- snapshot is a whole-month fact and is never placed on individual days. Rows are operator
-- configuration, not evidence: the envelopes themselves stay untouched.
CREATE TABLE personal_hub.usage_report_subjects (
  subject_key text PRIMARY KEY CHECK (subject_key ~ '^[a-zA-Z0-9._-]{1,80}$'),
  account_id text REFERENCES personal_hub.usage_accounts(id),
  source_timezone text CHECK (source_timezone IS NULL OR source_timezone ~ '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE personal_hub.usage_report_subjects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.usage_report_subjects FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON personal_hub.usage_report_subjects TO personal_hub_app;
CREATE POLICY app_read ON personal_hub.usage_report_subjects FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.usage_report_subjects FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_report_subjects FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
