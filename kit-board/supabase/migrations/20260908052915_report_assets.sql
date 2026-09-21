CREATE TABLE personal_hub.report_assets (
  report_id uuid NOT NULL REFERENCES personal_hub.report_revisions(id),
  asset_key text NOT NULL CHECK (asset_key ~ '^[a-f0-9]{64}$'),
  filename text NOT NULL CHECK (filename ~ '^[A-Za-z0-9._-]{1,200}$'),
  media_type text NOT NULL CHECK (media_type IN ('application/json', 'text/csv', 'text/markdown', 'text/plain', 'text/html')),
  content text NOT NULL CHECK (octet_length(content) <= 4000000),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (report_id, asset_key)
);

ALTER TABLE personal_hub.report_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.report_assets FROM PUBLIC;
GRANT SELECT, INSERT ON personal_hub.report_assets TO personal_hub_app;
CREATE POLICY app_read_report_assets ON personal_hub.report_assets FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_append_report_assets ON personal_hub.report_assets FOR INSERT TO personal_hub_app WITH CHECK (true);
