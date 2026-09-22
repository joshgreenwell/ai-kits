-- Backfill personal_hub.canonical_requests from the request ledger.
--
-- Deployed AFTER write-time maintenance is live, which is the ordering that removes any need for a
-- completeness gate: maintenance covers every key that lands from its deploy onward, and this one
-- statement covers everything before it. There is no moment at which a deployed reader can see a
-- partially built projection, because the read cutover ships after this has run.
--
-- The recompute below is generated from lib/usage-canonical.ts by scripts/generate-canonical-backfill.mjs
-- and must never be hand-edited. tests/usage-store.integration.test.ts asserts this file contains the
-- rank expressions that module exports, so a drift between the backfill's order and the application's
-- order fails in CI rather than silently serving a different revision.
--
-- It carries the SAME guard the ingest upsert uses, so an hourly upload landing while this runs
-- cannot have its newer winner overwritten by this statement's older snapshot. On an empty table the
-- guard never fires and every key is inserted.
--
-- REBUILD AFTER A LEDGER DELETE. Any migration that deletes ledger rows must re-run this recompute
-- with the guard replaced by an unconditional DO UPDATE, because a deleted winner must be allowed to
-- be replaced by a lower-ranked survivor, which the guard would refuse.
SET statement_timeout = '30min';
SET lock_timeout = '30s';

WITH ranked AS (
  SELECT r.account_id, r.semantic_key, r.id AS revision_id,
    (CASE r.channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END)::smallint AS channel_rank,
    (CASE r.session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END)::smallint AS identity_rank,
    r.observed_at, r.received_at, b.source_id,
    r.provider, r.session_hash, r.model_actual, r.activity_at, r.surface, r.outcome, r.reasoning_effort, r.service_tier, r.speed, r.context_window_tokens, r.cache_write_ttl, r.token_state, r.input_fresh_tokens, r.input_cached_tokens, r.input_cache_write_tokens, r.output_tokens, r.reasoning_tokens, r.unclassified_tokens, r.observed_total_tokens, r.agent_key, r.agent_class, r.agent_name, r.agent_depth, r.parent_agent_key, r.agent_identity_basis,
    first_value(CASE
  WHEN r.project_basis IN ('native','working_directory') AND r.project_key IS NOT NULL THEN r.project_basis
  WHEN r.project_basis = 'none' THEN 'none'
  WHEN r.project_basis IS NULL AND r.project_key IS NULL AND r.project_hash IS NOT NULL THEN 'working_directory'
  ELSE 'unknown' END) OVER project_order AS effective_project_basis,
    first_value(CASE
  WHEN r.project_basis IN ('native','working_directory') AND r.project_key IS NOT NULL THEN r.project_key
  WHEN r.project_basis IS NULL AND r.project_key IS NULL AND r.project_hash IS NOT NULL THEN r.project_hash
  ELSE NULL END)   OVER project_order AS effective_project_key,
    first_value(r.provider)           OVER project_order AS project_provider,
    first_value(b.install_id)         OVER project_order AS project_install_id,
    row_number() OVER (PARTITION BY r.account_id, r.semantic_key ORDER BY CASE r.channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END, CASE r.session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END, r.observed_at DESC, r.received_at DESC, r.id DESC) AS rank
  FROM personal_hub.activity_requests r
  
  JOIN personal_hub.companion_bindings b ON b.id = r.binding_id
  WINDOW project_order AS (PARTITION BY r.account_id, r.semantic_key ORDER BY CASE (CASE
  WHEN r.project_basis IN ('native','working_directory') AND r.project_key IS NOT NULL THEN r.project_basis
  WHEN r.project_basis = 'none' THEN 'none'
  WHEN r.project_basis IS NULL AND r.project_key IS NULL AND r.project_hash IS NOT NULL THEN 'working_directory'
  ELSE 'unknown' END) WHEN 'native' THEN 0 WHEN 'working_directory' THEN 1 WHEN 'none' THEN 2 ELSE 3 END, CASE r.channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END, CASE r.session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END, r.observed_at DESC, r.received_at DESC, r.id DESC))
  INSERT INTO personal_hub.canonical_requests AS c
    (account_id, semantic_key, revision_id, channel_rank, identity_rank, observed_at, received_at, source_id, provider, session_hash, model_actual, activity_at, surface, outcome, reasoning_effort, service_tier, speed, context_window_tokens, cache_write_ttl, token_state, input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens, reasoning_tokens, unclassified_tokens, observed_total_tokens, agent_key, agent_class, agent_name, agent_depth, parent_agent_key, agent_identity_basis, effective_project_basis, effective_project_key, project_provider, project_install_id, updated_at)
  SELECT account_id, semantic_key, revision_id, channel_rank, identity_rank, observed_at, received_at, source_id, provider, session_hash, model_actual, activity_at, surface, outcome, reasoning_effort, service_tier, speed, context_window_tokens, cache_write_ttl, token_state, input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens, reasoning_tokens, unclassified_tokens, observed_total_tokens, agent_key, agent_class, agent_name, agent_depth, parent_agent_key, agent_identity_basis, effective_project_basis, effective_project_key, project_provider, project_install_id, now()
  FROM ranked WHERE rank = 1
  ORDER BY account_id, semantic_key
  ON CONFLICT (account_id, semantic_key) DO UPDATE SET
    revision_id = EXCLUDED.revision_id, channel_rank = EXCLUDED.channel_rank, identity_rank = EXCLUDED.identity_rank, observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at, source_id = EXCLUDED.source_id, provider = EXCLUDED.provider, session_hash = EXCLUDED.session_hash, model_actual = EXCLUDED.model_actual, activity_at = EXCLUDED.activity_at, surface = EXCLUDED.surface, outcome = EXCLUDED.outcome, reasoning_effort = EXCLUDED.reasoning_effort, service_tier = EXCLUDED.service_tier, speed = EXCLUDED.speed, context_window_tokens = EXCLUDED.context_window_tokens, cache_write_ttl = EXCLUDED.cache_write_ttl, token_state = EXCLUDED.token_state, input_fresh_tokens = EXCLUDED.input_fresh_tokens, input_cached_tokens = EXCLUDED.input_cached_tokens, input_cache_write_tokens = EXCLUDED.input_cache_write_tokens, output_tokens = EXCLUDED.output_tokens, reasoning_tokens = EXCLUDED.reasoning_tokens, unclassified_tokens = EXCLUDED.unclassified_tokens, observed_total_tokens = EXCLUDED.observed_total_tokens, agent_key = EXCLUDED.agent_key, agent_class = EXCLUDED.agent_class, agent_name = EXCLUDED.agent_name, agent_depth = EXCLUDED.agent_depth, parent_agent_key = EXCLUDED.parent_agent_key, agent_identity_basis = EXCLUDED.agent_identity_basis, effective_project_basis = EXCLUDED.effective_project_basis, effective_project_key = EXCLUDED.effective_project_key, project_provider = EXCLUDED.project_provider, project_install_id = EXCLUDED.project_install_id,
    updated_at = now()
  WHERE (
    (-EXCLUDED.channel_rank, -EXCLUDED.identity_rank, EXCLUDED.observed_at, EXCLUDED.received_at, EXCLUDED.revision_id)
      > (-c.channel_rank, -c.identity_rank, c.observed_at, c.received_at, c.revision_id)
    OR (EXCLUDED.revision_id = c.revision_id
        AND (EXCLUDED.effective_project_basis, EXCLUDED.effective_project_key, EXCLUDED.project_provider, EXCLUDED.project_install_id)
            IS DISTINCT FROM (c.effective_project_basis, c.effective_project_key, c.project_provider, c.project_install_id)));

ANALYZE personal_hub.canonical_requests;

RESET lock_timeout;
RESET statement_timeout;
