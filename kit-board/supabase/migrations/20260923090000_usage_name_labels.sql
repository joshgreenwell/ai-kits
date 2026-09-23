-- Readable names for the hashed keys the ledgers already hold (companion 2.2.0, `name.label` records).
--
-- NOT A LEDGER. A label never enters a ledger row: the ledgers keep their `h:` and 64-hex keys, which
-- stay the identity, and no content hash changes. This table only lets the reads show a name beside a
-- key. It is keyed per install because tool, namespace and custom agent-name keys are salted per
-- install; the same readable name on two machines is two keys.
--
-- A label is upserted by the newest `observed_at`, so a late-arriving older record never overwrites a
-- newer one (lib/usage-store.ts). There is no DELETE grant: a label that stops being produced simply
-- stops being refreshed.
--
-- The CHECKs are deliberately weaker than the zod contract (lib/usage-contract.ts `labelText`), which
-- also forbids every Cf/Cs/Zl/Zp character and counts code points; the property test in
-- tests/usage-side-records.integration.test.ts proves every accepted label passes these under the
-- collation the database was created with.
CREATE TABLE personal_hub.usage_name_labels (
  install_id  uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  kind        text NOT NULL CHECK (kind IN ('tool','tool_namespace','agent_name','agent','session_agent')),
  key         text NOT NULL,
  label       text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200 AND label = btrim(label) AND label !~ '[[:cntrl:]]'),
  role        text CHECK (role IN ('main','subagent')),
  parent_key  text CHECK (parent_key ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (install_id, kind, key),
  CONSTRAINT usage_name_labels_shape CHECK (
       (kind IN ('tool','tool_namespace','agent_name') AND key ~ '^h:[a-f0-9]{16}$' AND role IS NULL AND parent_key IS NULL)
    OR (kind = 'agent'         AND key ~ '^[a-f0-9]{64}$' AND parent_key IS NULL)
    OR (kind = 'session_agent' AND key ~ '^[a-f0-9]{64}$'))
);

ALTER TABLE personal_hub.usage_name_labels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.usage_name_labels FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_name_labels FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON personal_hub.usage_name_labels FROM authenticated'; END IF;
END $$;
GRANT SELECT, INSERT ON personal_hub.usage_name_labels TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.usage_name_labels FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.usage_name_labels FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.usage_name_labels FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
-- Column scoped, with the key withheld: the app can refresh a label but never re-key one. No DELETE.
GRANT UPDATE (label, role, parent_key, observed_at, updated_at) ON personal_hub.usage_name_labels TO personal_hub_app;
