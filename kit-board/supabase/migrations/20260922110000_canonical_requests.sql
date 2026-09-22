-- One row per (account_id, semantic_key): the canonical revision, decided at write time in the order
-- lib/usage-canonical.ts defines, which is exactly the order lib/usage-query.ts used to apply on
-- every read.
--
-- THIS IS A PROJECTION, NOT A LEDGER. Every column is derived from personal_hub.activity_requests
-- and personal_hub.companion_bindings, and the whole table can be rebuilt from them by re-running
-- the backfill in 20260922120000. That is what licenses GRANT UPDATE on it. The precedent is
-- GRANT UPDATE (label, updated_at) ON usage_projects and
-- GRANT UPDATE (first_seen, last_seen) ON usage_project_identities, both in 20260913235900. The
-- seven ledgers keep no UPDATE and no DELETE, and this table gets no DELETE either.
--
-- WHY IT EXISTS. Reads ranked every revision of every in-range key on every request. Measured on
-- production 2026-09-22, that cost the requests card a 7.6 s median before a VACUUM FULL and left
-- the tools card at 71-93 s, past its 30 s budget, because the caller lookup ranked the ledger a
-- second time. The deeper reason is cache residency, not CPU: activity_requests and tool_events are
-- 563 MB of heap and indexes against roughly 224 MiB of shared_buffers, so the two halves of the
-- tools transaction evicted each other. This table is about 94,000 narrow rows. It is meant to stay
-- resident.
--
-- WHAT IS DELIBERATELY ABSENT: project_id and project_label. Naming a working directory in Settings
-- must retroactively relabel past requests, so the projection stores only the EVIDENCE of the
-- project-preferred revision, and the label is still resolved per read through
-- usage_project_identities -> usage_project_mapping_revisions -> usage_projects.
--
-- NO FOREIGN KEY ON revision_id. A projection FK would have blocked 20260921090000, which deleted
-- 383,612 ledger rows, and it would put a referential check on the hot ingest path. Any migration
-- that deletes ledger rows must re-run the backfill's unguarded recompute as its last statement.
--
-- NULLABILITY IS COPIED FROM THE SOURCE, EXACTLY. A column is NOT NULL here only where its ledger
-- source is NOT NULL today. That is what makes the maintenance statement unable to reject a row the
-- ledger accepted, which is why ingest needs no savepoint rescue around it, and
-- tests/usage-store.integration.test.ts asserts the property rather than trusting it.
CREATE TABLE personal_hub.canonical_requests (
  account_id   text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  semantic_key text NOT NULL,

  -- The winning revision, and the four values that decide a winner. Together with revision_id they
  -- are the upsert guard's comparison tuple, which is why they are stored and why they are NOT
  -- NULL: a row comparison containing a NULL yields NULL, which a WHERE reads as false.
  revision_id   uuid        NOT NULL,
  channel_rank  smallint    NOT NULL,
  identity_rank smallint    NOT NULL,
  observed_at   timestamptz NOT NULL,
  received_at   timestamptz NOT NULL,

  -- Denormalised from companion_bindings so the machine filter and the read lose their join to it.
  -- Safe because companion_bindings.source_id is written once at INSERT and never updated; every
  -- UPDATE on that table touches identity_hash, enabled or identity_reset_at.
  source_id uuid NOT NULL REFERENCES personal_hub.telemetry_sources(id),

  -- model_actual and activity_at are NULLABLE because their ledger sources are. Declaring either
  -- NOT NULL made the maintenance upsert refuse a valid envelope with SQLSTATE 23502, which is the
  -- exact failure this table must never cause; the nullability test caught it before it shipped.
  provider text NOT NULL, session_hash text NOT NULL, model_actual text,
  activity_at timestamptz, surface text NOT NULL, outcome text NOT NULL,
  reasoning_effort text, service_tier text, speed text,
  context_window_tokens bigint, cache_write_ttl text, token_state text,
  input_fresh_tokens bigint, input_cached_tokens bigint, input_cache_write_tokens bigint,
  output_tokens bigint, reasoning_tokens bigint, unclassified_tokens bigint, observed_total_tokens bigint,
  agent_key text, agent_class text, agent_name text, agent_depth bigint,
  parent_agent_key text, agent_identity_basis text,

  -- Project evidence of the project-preferred revision, which is what four first_value() windows in
  -- the read used to carry. Column names match those windows, so the identity joins and the state
  -- expression in lib/usage-query.ts work against this table unchanged.
  effective_project_basis text NOT NULL,
  effective_project_key   text,
  project_provider        text NOT NULL,
  project_install_id      uuid NOT NULL REFERENCES personal_hub.companion_installs(id),

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT canonical_requests_pkey PRIMARY KEY (account_id, semantic_key),
  CONSTRAINT canonical_requests_semantic_key_sha256_check CHECK (semantic_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT canonical_requests_project_basis_check
    CHECK (effective_project_basis IN ('native','working_directory','none','unknown')),
  CONSTRAINT canonical_requests_project_key_basis_check
    CHECK ((effective_project_basis IN ('native','working_directory')) = (effective_project_key IS NOT NULL))
);

-- The one read index. activity_at is the SECOND column, so both range bounds are index BOUNDARY
-- conditions and the scan size is the SELECTED RANGE. Contrast activity_requests_semantic_activity
-- (account_id, semantic_key, activity_at), where the same predicate is a non-boundary in-index
-- filter, which is why a one-day read used to cost nearly what a one-month read cost.
CREATE INDEX canonical_requests_activity
  ON personal_hub.canonical_requests (account_id, activity_at DESC);
-- The primary key serves the tools and knowledge caller joins and the upsert's conflict target.
-- No agent, project or model index: those filters apply to a set the range scan has already reduced,
-- and the instance has no storage to spare.

ALTER TABLE personal_hub.canonical_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.canonical_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON personal_hub.canonical_requests TO personal_hub_app;
-- Column scoped, with the two key columns withheld, exactly as usage_project_identities does it. The
-- app recomputes a projection row; it can never re-key one, and it can never delete one.
GRANT UPDATE (
  revision_id, channel_rank, identity_rank, observed_at, received_at, source_id,
  provider, session_hash, model_actual, activity_at, surface, outcome,
  reasoning_effort, service_tier, speed, context_window_tokens, cache_write_ttl, token_state,
  input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens,
  reasoning_tokens, unclassified_tokens, observed_total_tokens,
  agent_key, agent_class, agent_name, agent_depth, parent_agent_key, agent_identity_basis,
  effective_project_basis, effective_project_key, project_provider, project_install_id, updated_at
) ON personal_hub.canonical_requests TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.canonical_requests FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.canonical_requests FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.canonical_requests FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
-- No DELETE grant and no DELETE policy.
