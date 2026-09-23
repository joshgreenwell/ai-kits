-- Retire manual project mapping. Projects now come from the apps (usage_app_projects); the five labels
-- created by hand under Settings > Projects are deleted, and the application role can no longer append a
-- mapping revision. Each row is deleted only if it is exactly the known manual row (id AND label), no
-- mapping revision references it, and no app project has since been derived onto its id; production
-- held zero mapping revisions when this was written (2026-09-23). usage_project_identities and
-- usage_project_mapping_revisions are kept: ingest still records identities, and
-- activity_request_project_resolution stays the reference definition until a later migration drops it.
DO $$
DECLARE n integer;
BEGIN
  DELETE FROM personal_hub.usage_projects p
   WHERE p.id IN ('99e7df4c-6d2a-42fc-928e-f646569478c8','e5985792-881a-4b53-ae00-0474495b23a7',
                  '1ab1e194-fb87-446d-8e61-01b66f069184','32a37aa0-4276-48d1-a925-be664664faab',
                  '5a90ab2c-2915-4b51-8679-7783cf331ba5')
     AND p.label IN ('luumen-workspace','ai-kits','yoiboy-studio','area36-website','yaap')
     AND NOT EXISTS (SELECT 1 FROM personal_hub.usage_project_mapping_revisions r WHERE r.project_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM personal_hub.usage_app_projects a WHERE a.project_id = p.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 5 THEN RAISE NOTICE 'retire_manual_projects: deleted % of 5 manual projects', n; END IF;
END $$;
REVOKE INSERT ON personal_hub.usage_project_mapping_revisions FROM personal_hub_app;
