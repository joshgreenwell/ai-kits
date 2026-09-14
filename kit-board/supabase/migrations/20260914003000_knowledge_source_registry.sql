-- Stable knowledge-source labels and append-only identity mappings. A resource
-- identity is the privacy-safe key one companion install configured locally;
-- the roots and connectors behind it never leave that machine. The
-- configuration version is sighting metadata (the token the install most
-- recently classified under), never part of identity.
CREATE TABLE personal_hub.usage_knowledge_sources (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE personal_hub.usage_knowledge_source_identities (
  id uuid PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  resource_key text NOT NULL CHECK (resource_key ~ '^[a-z0-9_.:-]{1,64}$'),
  configuration_version text CHECK (configuration_version IS NULL OR configuration_version ~ '^[a-z0-9_.:-]{1,64}$'),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  CHECK (last_seen >= first_seen),
  CONSTRAINT usage_knowledge_source_identity_scope UNIQUE (install_id, resource_key)
);

CREATE TABLE personal_hub.usage_knowledge_source_mapping_revisions (
  id uuid PRIMARY KEY,
  revision_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  identity_id uuid NOT NULL REFERENCES personal_hub.usage_knowledge_source_identities(id),
  source_id uuid REFERENCES personal_hub.usage_knowledge_sources(id),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX usage_knowledge_source_mapping_history
  ON personal_hub.usage_knowledge_source_mapping_revisions (identity_id, revision_order DESC);

-- Retained resource accesses backfill identity sightings through the binding's
-- install. The generated UUID is only a row identifier; identity equality
-- remains the scoped unique constraint. The most recently received row names
-- the configuration the install last classified under.
INSERT INTO personal_hub.usage_knowledge_source_identities
  (id, install_id, resource_key, configuration_version, first_seen, last_seen)
SELECT (
    substr(md5('knowledge_source:' || b.install_id::text || ':' || r.resource_key), 1, 8) || '-' ||
    substr(md5('knowledge_source:' || b.install_id::text || ':' || r.resource_key), 9, 4) || '-4' ||
    substr(md5('knowledge_source:' || b.install_id::text || ':' || r.resource_key), 14, 3) || '-8' ||
    substr(md5('knowledge_source:' || b.install_id::text || ':' || r.resource_key), 18, 3) || '-' ||
    substr(md5('knowledge_source:' || b.install_id::text || ':' || r.resource_key), 21, 12)
  )::uuid,
  b.install_id, r.resource_key,
  (array_agg(r.configuration_version ORDER BY r.received_at DESC, r.id DESC)
    FILTER (WHERE r.configuration_version IS NOT NULL))[1],
  min(r.observed_at), max(r.observed_at)
FROM personal_hub.resource_accesses r
JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
GROUP BY b.install_id, r.resource_key
ON CONFLICT DO NOTHING;

-- Resolution canonicalizes ledger revisions first (the latest observation of
-- each access wins), then joins the install-scoped identity and its current
-- mapping. current_configuration flags rows classified under the configuration
-- the install most recently applied; earlier rows stay resolvable but are
-- reported separately because deleted transcripts cannot be re-verified.
CREATE VIEW personal_hub.resource_access_source_resolution
WITH (security_invoker = true) AS
WITH canonical AS (
  SELECT r.*,
    row_number() OVER (
      PARTITION BY account_id, semantic_key
      ORDER BY observed_at DESC, received_at DESC, id DESC
    ) AS access_revision_rank
  FROM personal_hub.resource_accesses r
)
SELECT
  r.id AS access_id,
  r.account_id,
  r.binding_id,
  b.install_id,
  r.provider,
  r.semantic_key,
  r.invocation_key,
  r.resource_key,
  r.configuration_version,
  r.access_kind,
  r.evidence_basis,
  r.outcome,
  r.observed_at,
  i.id AS identity_id,
  m.source_id,
  s.label AS source_label,
  CASE
    WHEN i.id IS NULL THEN 'unknown'
    WHEN m.source_id IS NULL THEN 'unassigned'
    ELSE 'source'
  END AS source_state,
  (r.configuration_version IS NOT DISTINCT FROM i.configuration_version) AS current_configuration
FROM canonical r
JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
LEFT JOIN personal_hub.usage_knowledge_source_identities i
  ON i.install_id = b.install_id AND i.resource_key = r.resource_key
LEFT JOIN LATERAL (
  SELECT revision.source_id
  FROM personal_hub.usage_knowledge_source_mapping_revisions revision
  WHERE revision.identity_id = i.id
  ORDER BY revision.revision_order DESC
  LIMIT 1
) m ON true
LEFT JOIN personal_hub.usage_knowledge_sources s ON s.id = m.source_id
WHERE r.access_revision_rank = 1;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['usage_knowledge_sources','usage_knowledge_source_identities','usage_knowledge_source_mapping_revisions'] LOOP
    EXECUTE format('ALTER TABLE personal_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON personal_hub.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON personal_hub.%I TO personal_hub_app', t);
    EXECUTE format('CREATE POLICY app_read ON personal_hub.%I FOR SELECT TO personal_hub_app USING (true)', t);
    EXECUTE format('CREATE POLICY app_insert ON personal_hub.%I FOR INSERT TO personal_hub_app WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT UPDATE (label, updated_at) ON personal_hub.usage_knowledge_sources TO personal_hub_app;
GRANT UPDATE (configuration_version, first_seen, last_seen) ON personal_hub.usage_knowledge_source_identities TO personal_hub_app;
GRANT USAGE, SELECT ON SEQUENCE personal_hub.usage_knowledge_source_mapping_revisions_revision_order_seq TO personal_hub_app;
CREATE POLICY app_update ON personal_hub.usage_knowledge_sources FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_knowledge_source_identities FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
REVOKE ALL ON personal_hub.resource_access_source_resolution FROM PUBLIC, anon, authenticated;
GRANT SELECT ON personal_hub.resource_access_source_resolution TO personal_hub_app;
