-- Stable project labels and append-only identity mappings. Working-directory
-- evidence is scoped to one install; native provider identity is scoped to an
-- account and provider. Paths never leave the companion.
CREATE TABLE personal_hub.usage_projects (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE personal_hub.usage_project_identities (
  id uuid PRIMARY KEY,
  basis text NOT NULL CHECK (basis IN ('native','working_directory')),
  evidence_key text NOT NULL CHECK (evidence_key ~ '^[a-f0-9]{64}$'),
  install_id uuid REFERENCES personal_hub.companion_installs(id),
  account_id text REFERENCES personal_hub.usage_accounts(id),
  provider text,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  CHECK (last_seen >= first_seen),
  CHECK (
    (basis = 'working_directory' AND install_id IS NOT NULL AND account_id IS NULL AND provider IS NULL)
    OR
    (basis = 'native' AND install_id IS NULL AND account_id IS NOT NULL AND provider IS NOT NULL)
  )
);
CREATE UNIQUE INDEX usage_project_identity_working_directory
  ON personal_hub.usage_project_identities (install_id, evidence_key)
  WHERE basis = 'working_directory';
CREATE UNIQUE INDEX usage_project_identity_native
  ON personal_hub.usage_project_identities (account_id, provider, evidence_key)
  WHERE basis = 'native';

CREATE TABLE personal_hub.usage_project_mapping_revisions (
  id uuid PRIMARY KEY,
  revision_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  identity_id uuid NOT NULL REFERENCES personal_hub.usage_project_identities(id),
  project_id uuid REFERENCES personal_hub.usage_projects(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX usage_project_mapping_history
  ON personal_hub.usage_project_mapping_revisions (identity_id, revision_order DESC);

-- Retained detailed requests can backfill identity sightings. The generated UUID
-- is only a row identifier; identity equality remains the scoped unique index.
WITH observations AS (
  SELECT b.install_id,
    CASE
      WHEN r.project_basis = 'working_directory' THEN r.project_key
      WHEN r.project_basis IS NULL AND r.project_key IS NULL THEN r.project_hash
    END AS evidence_key,
    coalesce(r.ended_at, r.observed_at) AS observed_at
  FROM personal_hub.activity_requests r
  JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
  WHERE (r.project_basis = 'working_directory' AND r.project_key IS NOT NULL)
    OR (r.project_basis IS NULL AND r.project_key IS NULL AND r.project_hash IS NOT NULL)
)
INSERT INTO personal_hub.usage_project_identities
  (id, basis, evidence_key, install_id, account_id, provider, first_seen, last_seen)
SELECT (
    substr(md5('working_directory:' || install_id::text || ':' || evidence_key), 1, 8) || '-' ||
    substr(md5('working_directory:' || install_id::text || ':' || evidence_key), 9, 4) || '-4' ||
    substr(md5('working_directory:' || install_id::text || ':' || evidence_key), 14, 3) || '-8' ||
    substr(md5('working_directory:' || install_id::text || ':' || evidence_key), 18, 3) || '-' ||
    substr(md5('working_directory:' || install_id::text || ':' || evidence_key), 21, 12)
  )::uuid,
  'working_directory', evidence_key, install_id, NULL, NULL,
  min(observed_at), max(observed_at)
FROM observations
GROUP BY install_id, evidence_key
ON CONFLICT DO NOTHING;

INSERT INTO personal_hub.usage_project_identities
  (id, basis, evidence_key, install_id, account_id, provider, first_seen, last_seen)
SELECT (
    substr(md5('native:' || r.account_id || ':' || r.provider || ':' || r.project_key), 1, 8) || '-' ||
    substr(md5('native:' || r.account_id || ':' || r.provider || ':' || r.project_key), 9, 4) || '-4' ||
    substr(md5('native:' || r.account_id || ':' || r.provider || ':' || r.project_key), 14, 3) || '-8' ||
    substr(md5('native:' || r.account_id || ':' || r.provider || ':' || r.project_key), 18, 3) || '-' ||
    substr(md5('native:' || r.account_id || ':' || r.provider || ':' || r.project_key), 21, 12)
  )::uuid,
  'native', r.project_key, NULL, r.account_id, r.provider,
  min(coalesce(r.ended_at, r.observed_at)), max(coalesce(r.ended_at, r.observed_at))
FROM personal_hub.activity_requests r
WHERE r.project_basis = 'native' AND r.project_key IS NOT NULL
GROUP BY r.account_id, r.provider, r.project_key
ON CONFLICT DO NOTHING;

-- Resolution canonicalizes ledger revisions first. Richer project evidence wins
-- a replay tie, and retained legacy project_hash values remain useful working-
-- directory evidence without rewriting raw requests. Mapping order comes from a
-- database identity after writers serialize on the identity row.
CREATE VIEW personal_hub.activity_request_project_resolution
WITH (security_invoker = true) AS
WITH normalized AS (
  SELECT r.*,
    CASE
      WHEN r.project_basis IN ('native','working_directory') AND r.project_key IS NOT NULL THEN r.project_basis
      WHEN r.project_basis = 'none' THEN 'none'
      WHEN r.project_basis IS NULL AND r.project_key IS NULL AND r.project_hash IS NOT NULL THEN 'working_directory'
      ELSE 'unknown'
    END AS effective_project_basis,
    CASE
      WHEN r.project_basis IN ('native','working_directory') AND r.project_key IS NOT NULL THEN r.project_key
      WHEN r.project_basis IS NULL AND r.project_key IS NULL AND r.project_hash IS NOT NULL THEN r.project_hash
      ELSE NULL
    END AS effective_project_key
  FROM personal_hub.activity_requests r
), canonical AS (
  SELECT normalized.*,
    row_number() OVER (
      PARTITION BY account_id, semantic_key
      ORDER BY
        CASE effective_project_basis WHEN 'native' THEN 0 WHEN 'working_directory' THEN 1 WHEN 'none' THEN 2 ELSE 3 END,
        CASE channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END,
        CASE session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END,
        observed_at DESC, received_at DESC, id DESC
    ) AS project_revision_rank
  FROM normalized
)
SELECT
  r.id AS request_id,
  r.account_id,
  r.binding_id,
  r.semantic_key,
  r.observed_at,
  r.effective_project_basis AS project_basis,
  r.effective_project_key AS project_key,
  i.id AS identity_id,
  m.project_id,
  p.label AS project_label,
  CASE
    WHEN r.effective_project_basis = 'none' THEN 'no_project'
    WHEN r.effective_project_basis = 'unknown' THEN 'unknown'
    WHEN i.id IS NULL THEN 'unknown'
    WHEN m.project_id IS NULL THEN 'unassigned'
    ELSE 'project'
  END AS project_state
FROM canonical r
JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
LEFT JOIN personal_hub.usage_project_identities i ON
  (r.effective_project_basis = 'working_directory' AND i.basis = 'working_directory'
    AND i.install_id = b.install_id AND i.evidence_key = r.effective_project_key)
  OR
  (r.effective_project_basis = 'native' AND i.basis = 'native'
    AND i.account_id = r.account_id AND i.provider = r.provider AND i.evidence_key = r.effective_project_key)
LEFT JOIN LATERAL (
  SELECT revision.project_id
  FROM personal_hub.usage_project_mapping_revisions revision
  WHERE revision.identity_id = i.id
  ORDER BY revision.revision_order DESC
  LIMIT 1
) m ON true
LEFT JOIN personal_hub.usage_projects p ON p.id = m.project_id
WHERE r.project_revision_rank = 1;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['usage_projects','usage_project_identities','usage_project_mapping_revisions'] LOOP
    EXECUTE format('ALTER TABLE personal_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON personal_hub.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON personal_hub.%I TO personal_hub_app', t);
    EXECUTE format('CREATE POLICY app_read ON personal_hub.%I FOR SELECT TO personal_hub_app USING (true)', t);
    EXECUTE format('CREATE POLICY app_insert ON personal_hub.%I FOR INSERT TO personal_hub_app WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT UPDATE (label, updated_at) ON personal_hub.usage_projects TO personal_hub_app;
GRANT UPDATE (first_seen, last_seen) ON personal_hub.usage_project_identities TO personal_hub_app;
GRANT USAGE, SELECT ON SEQUENCE personal_hub.usage_project_mapping_revisions_revision_order_seq TO personal_hub_app;
CREATE POLICY app_update ON personal_hub.usage_projects FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_project_identities FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
REVOKE ALL ON personal_hub.activity_request_project_resolution FROM PUBLIC, anon, authenticated;
GRANT SELECT ON personal_hub.activity_request_project_resolution TO personal_hub_app;
