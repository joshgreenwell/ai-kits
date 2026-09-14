-- What each companion build reports it can do (USG-014). The document is the
-- strict capability contract in lib/companion-capabilities.ts: codes, flags,
-- counts, ids, and dates only. The digest identifies the build's advertised
-- adapters and features, so a different binary reporting the same version is
-- visible; the previous digest and change time keep that flip inspectable.
-- Grants are unchanged: personal_hub_app already holds table-level UPDATE on
-- companion_installs, and no new table is created.
ALTER TABLE personal_hub.companion_installs
  ADD COLUMN capabilities jsonb,
  ADD COLUMN capabilities_digest text CHECK (capabilities_digest IS NULL OR capabilities_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN capabilities_previous_digest text CHECK (capabilities_previous_digest IS NULL OR capabilities_previous_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN capabilities_reported_at timestamptz,
  ADD COLUMN capabilities_changed_at timestamptz;
