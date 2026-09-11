-- A single private application identity; browser roles have no access.
CREATE ROLE personal_hub_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA personal_hub TO personal_hub_app;
GRANT SELECT, INSERT ON personal_hub.report_revisions TO personal_hub_app;
GRANT SELECT, INSERT, UPDATE ON personal_hub.login_limits TO personal_hub_app;
CREATE POLICY app_read_reports ON personal_hub.report_revisions FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_append_reports ON personal_hub.report_revisions FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_read_limits ON personal_hub.login_limits FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert_limits ON personal_hub.login_limits FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update_limits ON personal_hub.login_limits FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
