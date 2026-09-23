-- App projects (companion 2.2.0, `project.catalog` and `project.membership` records).
--
-- A project is a group the owner created in an app (today the Codex desktop app); a folder is never a
-- project. The companion reports the app's catalog and, for each folder key and session key the ledgers
-- already hold, which app project it belongs to and how that was decided. None of this is a ledger and
-- no ledger row changes: the reads join these tables to canonical_requests at read time
-- (lib/usage-query.ts), so a rename or a later membership relabels history without touching it.
--
-- Same-named projects merge: an app project's usage_projects id is derived from its name alone,
--   md5('app-project-name:' || lower(btrim(name))) split 8-4-(4)3-(8)3-12,
-- the same uuid shape 20260913235900 uses for identities (lib/usage-app-projects.ts derives it in JS and
-- tests/usage-side-records.integration.test.ts proves the two agree). A rename therefore moves an app
-- project to a new id; the old usage_projects row stays, unused, because nothing may delete.

-- The grant block every table below repeats: RLS on, nothing for PUBLIC/anon/authenticated, SELECT and
-- INSERT plus column-scoped UPDATE for the application role, and no DELETE anywhere.

CREATE TABLE personal_hub.usage_app_projects (
  install_id  uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  project_key text NOT NULL CHECK (project_key ~ '^[a-f0-9]{64}$'),
  app         text NOT NULL CHECK (app IN ('codex_desktop','claude_desktop','cursor')),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name) AND name !~ '[[:cntrl:]]'),
  position    integer CHECK (position >= 0),
  state       text NOT NULL CHECK (state IN ('active','removed')),
  project_id  uuid NOT NULL REFERENCES personal_hub.usage_projects(id),
  observed_at timestamptz NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, project_key)
);
CREATE INDEX usage_app_projects_project ON personal_hub.usage_app_projects (project_id);

ALTER TABLE personal_hub.usage_app_projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.usage_app_projects FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_app_projects FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_app_projects FROM authenticated'; END IF;
END $$;
GRANT SELECT, INSERT ON personal_hub.usage_app_projects TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.usage_app_projects FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.usage_app_projects FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_app_projects FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
GRANT UPDATE (app, name, position, state, project_id, observed_at, updated_at) ON personal_hub.usage_app_projects TO personal_hub_app;

-- No FK to usage_app_projects: catalog and membership records arrive in any order, and the read treats
-- a membership naming a project it has not seen as Unassigned.
CREATE TABLE personal_hub.usage_project_memberships (
  install_id  uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  member_kind text NOT NULL CHECK (member_kind IN ('working_directory','session')),
  member_key  text NOT NULL CHECK (member_key ~ '^[a-f0-9]{64}$'),
  project_key text CHECK (project_key ~ '^[a-f0-9]{64}$'),
  resolution  text NOT NULL CHECK (resolution IN
    ('app_assignment','inherited','root_prefix','worktree_root_prefix','projectless','outside_roots','no_folder')),
  observed_at timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, member_kind, member_key),
  CONSTRAINT usage_project_memberships_shape CHECK (
    (project_key IS NOT NULL) = (resolution IN ('app_assignment','inherited','root_prefix','worktree_root_prefix')))
);

ALTER TABLE personal_hub.usage_project_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.usage_project_memberships FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_project_memberships FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_project_memberships FROM authenticated'; END IF;
END $$;
GRANT SELECT, INSERT ON personal_hub.usage_project_memberships TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.usage_project_memberships FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.usage_project_memberships FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_project_memberships FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
GRANT UPDATE (project_key, resolution, observed_at, updated_at) ON personal_hub.usage_project_memberships TO personal_hub_app;

-- Which installs have reported project data at all: the read's 'not_reported' state ("companion update
-- needed") is an install with no row here.
CREATE TABLE personal_hub.usage_project_reports (
  install_id        uuid PRIMARY KEY REFERENCES personal_hub.companion_installs(id),
  first_reported_at timestamptz NOT NULL DEFAULT now(),
  last_reported_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE personal_hub.usage_project_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.usage_project_reports FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_project_reports FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_project_reports FROM authenticated'; END IF;
END $$;
GRANT SELECT, INSERT ON personal_hub.usage_project_reports TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.usage_project_reports FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.usage_project_reports FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_project_reports FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
GRANT UPDATE (last_reported_at) ON personal_hub.usage_project_reports TO personal_hub_app;

-- Side records the server could not apply, so a deterministic failure is visible (Settings > Companion
-- counts them, and the companion is told through `deferred_record_ids`). A deferred record is never
-- rejected: the companion keeps it and a later resync retries it.
CREATE TABLE personal_hub.usage_side_record_deferrals (
  install_id  uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  record_type text NOT NULL CHECK (record_type IN ('name.label','project.catalog','project.membership')),
  target_key  text NOT NULL CHECK (char_length(target_key) BETWEEN 1 AND 200),
  reason      text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  occurrences integer NOT NULL DEFAULT 1,
  first_at    timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, record_type, target_key)
);

ALTER TABLE personal_hub.usage_side_record_deferrals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.usage_side_record_deferrals FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_side_record_deferrals FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_side_record_deferrals FROM authenticated'; END IF;
END $$;
GRANT SELECT, INSERT ON personal_hub.usage_side_record_deferrals TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.usage_side_record_deferrals FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.usage_side_record_deferrals FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_side_record_deferrals FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
GRANT UPDATE (reason, occurrences, last_at) ON personal_hub.usage_side_record_deferrals TO personal_hub_app;
