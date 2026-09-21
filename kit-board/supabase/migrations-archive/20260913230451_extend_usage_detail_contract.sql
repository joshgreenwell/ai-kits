-- Additive envelope-v2 detail. Existing rows remain legacy rows: every new nullable
-- extension column is left NULL, and the original total_tokens column is preserved.
ALTER TABLE personal_hub.activity_requests
  ALTER COLUMN model_actual DROP NOT NULL,
  ADD COLUMN reported_total_tokens bigint,
  ADD COLUMN unclassified_tokens bigint,
  ADD COLUMN token_state text,
  ADD COLUMN reasoning_effort text,
  ADD COLUMN service_tier text,
  ADD COLUMN speed text,
  ADD COLUMN context_window_tokens bigint,
  ADD COLUMN cache_write_ttl text,
  ADD COLUMN agent_key text,
  ADD COLUMN agent_identity_basis text,
  ADD COLUMN parent_agent_key text,
  ADD COLUMN parent_agent_identity_basis text,
  ADD COLUMN agent_class text,
  ADD COLUMN agent_name text,
  ADD COLUMN agent_depth bigint,
  ADD COLUMN project_key text,
  ADD COLUMN project_basis text,
  ADD COLUMN activity_at timestamptz GENERATED ALWAYS AS
    (coalesce(ended_at, started_at, observed_at)) STORED,
  ADD COLUMN observed_total_tokens bigint GENERATED ALWAYS AS (
    coalesce(
      reported_total_tokens,
      CASE
        WHEN input_fresh_tokens IS NULL
          OR input_cached_tokens IS NULL
          OR input_cache_write_tokens IS NULL
          OR output_tokens IS NULL THEN NULL
        ELSE input_fresh_tokens + input_cached_tokens + input_cache_write_tokens + output_tokens
      END
    )
  ) STORED,
  ADD CONSTRAINT activity_requests_reported_total_tokens_check
    CHECK (reported_total_tokens IS NULL OR reported_total_tokens >= 0),
  ADD CONSTRAINT activity_requests_unclassified_tokens_check
    CHECK (unclassified_tokens IS NULL OR unclassified_tokens >= 0),
  ADD CONSTRAINT activity_requests_token_state_check
    CHECK (token_state IS NULL OR token_state IN ('complete','partial','inconsistent','unknown')),
  ADD CONSTRAINT activity_requests_token_accounting_presence_check
    CHECK (token_state IS NOT NULL OR (reported_total_tokens IS NULL AND unclassified_tokens IS NULL)),
  ADD CONSTRAINT activity_requests_token_accounting_check CHECK (
    token_state IS NULL OR (CASE token_state
      WHEN 'complete' THEN
        num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) = 4
        AND (
          (reported_total_tokens IS NULL AND unclassified_tokens IS NULL)
          OR (
            reported_total_tokens >=
              input_fresh_tokens::numeric + input_cached_tokens::numeric
              + input_cache_write_tokens::numeric + output_tokens::numeric
            AND (reasoning_tokens IS NULL OR reasoning_tokens <= reported_total_tokens)
            AND unclassified_tokens = reported_total_tokens::numeric
              - input_fresh_tokens::numeric - input_cached_tokens::numeric
              - input_cache_write_tokens::numeric - output_tokens::numeric
          )
        )
      WHEN 'partial' THEN
        num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) < 4
        AND (
          num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) > 0
          OR reported_total_tokens IS NOT NULL
          OR reasoning_tokens IS NOT NULL
        )
        AND (
          (reported_total_tokens IS NULL AND unclassified_tokens IS NULL)
          OR (
            reported_total_tokens IS NOT NULL
            AND coalesce(input_fresh_tokens, 0)::numeric + coalesce(input_cached_tokens, 0)::numeric
              + coalesce(input_cache_write_tokens, 0)::numeric
              + coalesce(output_tokens, reasoning_tokens, 0)::numeric
              <= reported_total_tokens
            AND unclassified_tokens = reported_total_tokens::numeric
              - coalesce(input_fresh_tokens, 0)::numeric - coalesce(input_cached_tokens, 0)::numeric
              - coalesce(input_cache_write_tokens, 0)::numeric - coalesce(output_tokens, 0)::numeric
          )
        )
      WHEN 'inconsistent' THEN
        reported_total_tokens IS NOT NULL
        AND (
          coalesce(input_fresh_tokens, 0)::numeric + coalesce(input_cached_tokens, 0)::numeric
            + coalesce(input_cache_write_tokens, 0)::numeric
            + coalesce(output_tokens, reasoning_tokens, 0)::numeric
            > reported_total_tokens
        )
        AND unclassified_tokens IS NULL
      WHEN 'unknown' THEN
        num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) = 0
        AND reasoning_tokens IS NULL
        AND reported_total_tokens IS NULL
        AND unclassified_tokens IS NULL
      ELSE false
    END) IS TRUE
  ),
  ADD CONSTRAINT activity_requests_reasoning_effort_check
    CHECK (reasoning_effort IS NULL OR reasoning_effort ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT activity_requests_service_tier_check
    CHECK (service_tier IS NULL OR service_tier ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT activity_requests_speed_check
    CHECK (speed IS NULL OR speed ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT activity_requests_context_window_tokens_check
    CHECK (context_window_tokens IS NULL OR context_window_tokens >= 0),
  ADD CONSTRAINT activity_requests_cache_write_ttl_check
    CHECK (cache_write_ttl IS NULL OR cache_write_ttl ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT activity_requests_semantic_key_sha256_check
    CHECK (semantic_key ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_session_hash_sha256_check
    CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_parent_session_hash_sha256_check
    CHECK (parent_session_hash IS NULL OR parent_session_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_content_hash_sha256_check
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_project_hash_sha256_check
    CHECK (project_hash IS NULL OR project_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_agent_key_sha256_check
    CHECK (agent_key IS NULL OR agent_key ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_parent_agent_key_sha256_check
    CHECK (parent_agent_key IS NULL OR parent_agent_key ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_project_key_sha256_check
    CHECK (project_key IS NULL OR project_key ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT activity_requests_agent_identity_basis_check
    CHECK (agent_identity_basis IS NULL OR agent_identity_basis IN ('provider','derived','synthetic','unknown')),
  ADD CONSTRAINT activity_requests_parent_agent_identity_basis_check
    CHECK (parent_agent_identity_basis IS NULL OR parent_agent_identity_basis IN ('provider','derived','synthetic','none','unknown')),
  ADD CONSTRAINT activity_requests_agent_class_check
    CHECK (agent_class IS NULL OR agent_class IN ('main','builtin','custom','unknown')),
  ADD CONSTRAINT activity_requests_agent_name_check
    CHECK (agent_name IS NULL OR agent_name ~ '^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$'),
  ADD CONSTRAINT activity_requests_agent_depth_check
    CHECK (agent_depth IS NULL OR agent_depth >= 0),
  ADD CONSTRAINT activity_requests_agent_block_presence_check CHECK (
    (
      agent_identity_basis IS NULL
      AND agent_key IS NULL
      AND parent_agent_key IS NULL
      AND parent_agent_identity_basis IS NULL
      AND agent_class IS NULL
      AND agent_name IS NULL
      AND agent_depth IS NULL
    )
    OR (
      agent_identity_basis IS NOT NULL
      AND parent_agent_identity_basis IS NOT NULL
      AND agent_class IS NOT NULL
    )
  ),
  ADD CONSTRAINT activity_requests_agent_key_basis_check CHECK (
    agent_identity_basis IS NULL
    OR ((agent_identity_basis = 'unknown') = (agent_key IS NULL))
  ),
  ADD CONSTRAINT activity_requests_parent_agent_key_basis_check CHECK (
    parent_agent_identity_basis IS NULL
    OR ((parent_agent_identity_basis IN ('none','unknown')) = (parent_agent_key IS NULL))
  ),
  ADD CONSTRAINT activity_requests_project_basis_check
    CHECK (project_basis IS NULL OR project_basis IN ('native','working_directory','none','unknown')),
  ADD CONSTRAINT activity_requests_project_key_basis_check CHECK ((
      (project_basis IS NULL AND project_key IS NULL)
      OR (project_basis IN ('native','working_directory') AND project_key IS NOT NULL)
      OR (project_basis IN ('none','unknown') AND project_key IS NULL)
    ) IS TRUE),
  ADD CONSTRAINT activity_requests_project_alias_check CHECK (
    project_basis IS NULL
    OR (project_basis = 'working_directory' AND project_hash IS NOT NULL AND project_key = project_hash)
    OR (project_basis IN ('native','none','unknown') AND project_hash IS NULL)
  );

CREATE INDEX activity_requests_activity_time
  ON personal_hub.activity_requests (account_id, activity_at DESC, model_actual);
CREATE INDEX activity_requests_agent_join
  ON personal_hub.activity_requests (account_id, agent_key, activity_at DESC)
  WHERE agent_key IS NOT NULL;
CREATE INDEX activity_requests_parent_agent_join
  ON personal_hub.activity_requests (account_id, parent_agent_key, activity_at DESC)
  WHERE parent_agent_key IS NOT NULL;
CREATE INDEX activity_requests_project_join
  ON personal_hub.activity_requests (account_id, project_key, activity_at DESC)
  WHERE project_key IS NOT NULL;

ALTER TABLE personal_hub.account_usage_buckets
  ADD COLUMN reasoning_effort text,
  ADD COLUMN service_tier text,
  ADD COLUMN speed text,
  ADD COLUMN context_window_tokens bigint,
  ADD COLUMN cache_write_ttl text,
  ADD COLUMN unclassified_tokens bigint,
  ADD COLUMN token_state text,
  ADD CONSTRAINT account_usage_buckets_requests_check
    CHECK (requests IS NULL OR requests >= 0),
  ADD CONSTRAINT account_usage_buckets_input_tokens_check
    CHECK (input_tokens IS NULL OR input_tokens >= 0),
  ADD CONSTRAINT account_usage_buckets_cached_tokens_check
    CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  ADD CONSTRAINT account_usage_buckets_cache_write_tokens_check
    CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  ADD CONSTRAINT account_usage_buckets_output_tokens_check
    CHECK (output_tokens IS NULL OR output_tokens >= 0),
  ADD CONSTRAINT account_usage_buckets_reasoning_tokens_check
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  ADD CONSTRAINT account_usage_buckets_total_tokens_check
    CHECK (total_tokens IS NULL OR total_tokens >= 0),
  ADD CONSTRAINT account_usage_buckets_unclassified_tokens_check
    CHECK (unclassified_tokens IS NULL OR unclassified_tokens >= 0),
  -- The original bucket ledger accepted reasoning above output. Keep those historical
  -- rows readable during upgrade while enforcing the subset rule on every new write.
  ADD CONSTRAINT account_usage_buckets_reasoning_subset_check
    CHECK (reasoning_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens <= output_tokens) NOT VALID,
  ADD CONSTRAINT account_usage_buckets_token_state_check
    CHECK (token_state IS NULL OR token_state IN ('complete','partial','inconsistent','unknown')),
  ADD CONSTRAINT account_usage_buckets_token_accounting_presence_check
    CHECK (token_state IS NOT NULL OR unclassified_tokens IS NULL),
  ADD CONSTRAINT account_usage_buckets_token_accounting_check CHECK (
    token_state IS NULL OR (CASE token_state
      WHEN 'complete' THEN
        num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) = 4
        AND (
          (total_tokens IS NULL AND unclassified_tokens IS NULL)
          OR (
            total_tokens >= input_tokens::numeric + cached_tokens::numeric
              + cache_write_tokens::numeric + output_tokens::numeric
            AND (reasoning_tokens IS NULL OR reasoning_tokens <= total_tokens)
            AND unclassified_tokens = total_tokens::numeric
              - input_tokens::numeric - cached_tokens::numeric
              - cache_write_tokens::numeric - output_tokens::numeric
          )
        )
      WHEN 'partial' THEN
        num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) < 4
        AND (
          num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) > 0
          OR total_tokens IS NOT NULL
          OR reasoning_tokens IS NOT NULL
        )
        AND (
          (total_tokens IS NULL AND unclassified_tokens IS NULL)
          OR (
            total_tokens IS NOT NULL
            AND coalesce(input_tokens, 0)::numeric + coalesce(cached_tokens, 0)::numeric
              + coalesce(cache_write_tokens, 0)::numeric
              + coalesce(output_tokens, reasoning_tokens, 0)::numeric <= total_tokens
            AND unclassified_tokens = total_tokens::numeric
              - coalesce(input_tokens, 0)::numeric - coalesce(cached_tokens, 0)::numeric
              - coalesce(cache_write_tokens, 0)::numeric - coalesce(output_tokens, 0)::numeric
          )
        )
      WHEN 'inconsistent' THEN
        total_tokens IS NOT NULL
        AND (
          coalesce(input_tokens, 0)::numeric + coalesce(cached_tokens, 0)::numeric
            + coalesce(cache_write_tokens, 0)::numeric
            + coalesce(output_tokens, reasoning_tokens, 0)::numeric > total_tokens
        )
        AND unclassified_tokens IS NULL
      WHEN 'unknown' THEN
        num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) = 0
        AND reasoning_tokens IS NULL
        AND total_tokens IS NULL
        AND unclassified_tokens IS NULL
      ELSE false
    END) IS TRUE
  ),
  ADD CONSTRAINT account_usage_buckets_reasoning_effort_check
    CHECK (reasoning_effort IS NULL OR reasoning_effort ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT account_usage_buckets_service_tier_check
    CHECK (service_tier IS NULL OR service_tier ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT account_usage_buckets_speed_check
    CHECK (speed IS NULL OR speed ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT account_usage_buckets_context_window_tokens_check
    CHECK (context_window_tokens IS NULL OR context_window_tokens >= 0),
  ADD CONSTRAINT account_usage_buckets_cache_write_ttl_check
    CHECK (cache_write_ttl IS NULL OR cache_write_ttl ~ '^[a-z0-9_.:-]{1,64}$'),
  ADD CONSTRAINT account_usage_buckets_dimensions_hash_sha256_check
    CHECK (dimensions_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT account_usage_buckets_user_ref_sha256_check
    CHECK (user_ref IS NULL OR user_ref ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT account_usage_buckets_workspace_ref_sha256_check
    CHECK (workspace_ref IS NULL OR workspace_ref ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT account_usage_buckets_api_key_ref_sha256_check
    CHECK (api_key_ref IS NULL OR api_key_ref ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT account_usage_buckets_content_hash_sha256_check
    CHECK (content_hash ~ '^[a-f0-9]{64}$');

-- Agent, tool, and resource facts are independent append-only ledgers. Their semantic
-- keys are indexed for joins but deliberately have no cross-ledger foreign keys, so an
-- orphan event remains valid evidence when its parent or token record is unavailable.
CREATE TABLE personal_hub.agent_events (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL,
  adapter text NOT NULL,
  channel text NOT NULL,
  record_id uuid NOT NULL,
  semantic_key text NOT NULL,
  event_kind text NOT NULL,
  session_hash text,
  agent_key text,
  agent_identity_basis text NOT NULL,
  parent_agent_key text,
  parent_agent_identity_basis text NOT NULL,
  agent_class text NOT NULL,
  agent_name text,
  agent_depth bigint,
  tool_invocation_key text,
  outcome text NOT NULL,
  basis text NOT NULL,
  observed_at timestamptz NOT NULL,
  parser_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  CONSTRAINT agent_events_provider_check
    CHECK (provider IN ('claude','codex','cursor','anthropic_api','openai_api')),
  CONSTRAINT agent_events_adapter_check
    CHECK (adapter IN ('claude_execution','claude_account','codex_execution','codex_account','cursor_account','cursor_execution','anthropic_api','openai_api','claude_browser','codex_browser','cursor_browser')),
  CONSTRAINT agent_events_channel_check
    CHECK (channel IN ('local_file','local_db','app_server','provider_api','hook_snapshot','browser_session')),
  CONSTRAINT agent_events_semantic_key_sha256_check
    CHECK (semantic_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT agent_events_session_hash_sha256_check
    CHECK (session_hash IS NULL OR session_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT agent_events_agent_key_sha256_check
    CHECK (agent_key IS NULL OR agent_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT agent_events_parent_agent_key_sha256_check
    CHECK (parent_agent_key IS NULL OR parent_agent_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT agent_events_tool_invocation_key_sha256_check
    CHECK (tool_invocation_key IS NULL OR tool_invocation_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT agent_events_content_hash_sha256_check
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT agent_events_event_kind_check
    CHECK (event_kind IN ('spawn','start','resume','finish')),
  CONSTRAINT agent_events_agent_identity_basis_check
    CHECK (agent_identity_basis IN ('provider','derived','synthetic','unknown')),
  CONSTRAINT agent_events_parent_agent_identity_basis_check
    CHECK (parent_agent_identity_basis IN ('provider','derived','synthetic','none','unknown')),
  CONSTRAINT agent_events_agent_class_check
    CHECK (agent_class IN ('main','builtin','custom','unknown')),
  CONSTRAINT agent_events_agent_name_check
    CHECK (agent_name IS NULL OR agent_name ~ '^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$'),
  CONSTRAINT agent_events_agent_depth_check
    CHECK (agent_depth IS NULL OR agent_depth >= 0),
  CONSTRAINT agent_events_agent_key_basis_check
    CHECK ((agent_identity_basis = 'unknown') = (agent_key IS NULL)),
  CONSTRAINT agent_events_parent_agent_key_basis_check
    CHECK ((parent_agent_identity_basis IN ('none','unknown')) = (parent_agent_key IS NULL)),
  CONSTRAINT agent_events_observed_agent_check
    CHECK ((event_kind = 'spawn' AND outcome <> 'succeeded') OR agent_key IS NOT NULL),
  CONSTRAINT agent_events_outcome_check
    CHECK (outcome IN ('succeeded','failed','denied','cancelled','unknown')),
  CONSTRAINT agent_events_basis_check
    CHECK (basis IN ('exact','reported','estimated','unknown'))
);

CREATE UNIQUE INDEX agent_events_revision
  ON personal_hub.agent_events (account_id, semantic_key, channel, content_hash);
CREATE INDEX agent_events_canonical
  ON personal_hub.agent_events (account_id, semantic_key, observed_at DESC);
CREATE INDEX agent_events_time
  ON personal_hub.agent_events (account_id, observed_at DESC, event_kind);
CREATE INDEX agent_events_agent_join
  ON personal_hub.agent_events (account_id, agent_key, observed_at DESC)
  WHERE agent_key IS NOT NULL;
CREATE INDEX agent_events_parent_join
  ON personal_hub.agent_events (account_id, parent_agent_key, observed_at DESC)
  WHERE parent_agent_key IS NOT NULL;
CREATE INDEX agent_events_tool_join
  ON personal_hub.agent_events (account_id, tool_invocation_key, observed_at DESC)
  WHERE tool_invocation_key IS NOT NULL;

CREATE TABLE personal_hub.tool_events (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL,
  adapter text NOT NULL,
  channel text NOT NULL,
  record_id uuid NOT NULL,
  semantic_key text NOT NULL,
  invocation_key text NOT NULL,
  event_kind text NOT NULL,
  session_hash text,
  caller_request_key text,
  caller_agent_key text,
  parent_invocation_key text,
  tool_name text,
  tool_namespace text,
  tool_class text NOT NULL,
  outcome text NOT NULL,
  basis text NOT NULL,
  observed_at timestamptz NOT NULL,
  parser_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  CONSTRAINT tool_events_provider_check
    CHECK (provider IN ('claude','codex','cursor','anthropic_api','openai_api')),
  CONSTRAINT tool_events_adapter_check
    CHECK (adapter IN ('claude_execution','claude_account','codex_execution','codex_account','cursor_account','cursor_execution','anthropic_api','openai_api','claude_browser','codex_browser','cursor_browser')),
  CONSTRAINT tool_events_channel_check
    CHECK (channel IN ('local_file','local_db','app_server','provider_api','hook_snapshot','browser_session')),
  CONSTRAINT tool_events_semantic_key_sha256_check
    CHECK (semantic_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_events_invocation_key_sha256_check
    CHECK (invocation_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_events_session_hash_sha256_check
    CHECK (session_hash IS NULL OR session_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_events_caller_request_key_sha256_check
    CHECK (caller_request_key IS NULL OR caller_request_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_events_caller_agent_key_sha256_check
    CHECK (caller_agent_key IS NULL OR caller_agent_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_events_parent_invocation_key_sha256_check
    CHECK (parent_invocation_key IS NULL OR parent_invocation_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_events_content_hash_sha256_check
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_events_event_kind_check
    CHECK (event_kind IN ('invocation','result')),
  CONSTRAINT tool_events_invocation_identity_check CHECK (
    (event_kind = 'invocation' AND semantic_key = invocation_key)
    OR (event_kind = 'result' AND semantic_key <> invocation_key)
  ),
  CONSTRAINT tool_events_tool_name_check
    CHECK (tool_name IS NULL OR tool_name ~ '^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$'),
  CONSTRAINT tool_events_tool_namespace_check
    CHECK (tool_namespace IS NULL OR tool_namespace ~ '^[a-z0-9_.:-]{1,64}$'),
  CONSTRAINT tool_events_tool_class_check
    CHECK (tool_class IN ('builtin','mcp','function','custom','unknown')),
  CONSTRAINT tool_events_outcome_check
    CHECK (outcome IN ('succeeded','failed','denied','cancelled','unknown')),
  CONSTRAINT tool_events_basis_check
    CHECK (basis IN ('exact','reported','estimated','unknown'))
);

CREATE UNIQUE INDEX tool_events_revision
  ON personal_hub.tool_events (account_id, semantic_key, channel, content_hash);
CREATE INDEX tool_events_canonical
  ON personal_hub.tool_events (account_id, semantic_key, observed_at DESC);
CREATE INDEX tool_events_time
  ON personal_hub.tool_events (account_id, observed_at DESC, event_kind);
CREATE INDEX tool_events_invocation_join
  ON personal_hub.tool_events (account_id, invocation_key, observed_at DESC);
CREATE INDEX tool_events_caller_request_join
  ON personal_hub.tool_events (account_id, caller_request_key, observed_at DESC)
  WHERE caller_request_key IS NOT NULL;
CREATE INDEX tool_events_caller_agent_join
  ON personal_hub.tool_events (account_id, caller_agent_key, observed_at DESC)
  WHERE caller_agent_key IS NOT NULL;
CREATE INDEX tool_events_parent_invocation_join
  ON personal_hub.tool_events (account_id, parent_invocation_key, observed_at DESC)
  WHERE parent_invocation_key IS NOT NULL;

CREATE TABLE personal_hub.resource_accesses (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL,
  adapter text NOT NULL,
  channel text NOT NULL,
  record_id uuid NOT NULL,
  semantic_key text NOT NULL,
  invocation_key text NOT NULL,
  resource_key text NOT NULL,
  configuration_version text,
  access_kind text NOT NULL,
  evidence_basis text NOT NULL,
  outcome text NOT NULL,
  basis text NOT NULL,
  observed_at timestamptz NOT NULL,
  parser_version text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  CONSTRAINT resource_accesses_provider_check
    CHECK (provider IN ('claude','codex','cursor','anthropic_api','openai_api')),
  CONSTRAINT resource_accesses_adapter_check
    CHECK (adapter IN ('claude_execution','claude_account','codex_execution','codex_account','cursor_account','cursor_execution','anthropic_api','openai_api','claude_browser','codex_browser','cursor_browser')),
  CONSTRAINT resource_accesses_channel_check
    CHECK (channel IN ('local_file','local_db','app_server','provider_api','hook_snapshot','browser_session')),
  CONSTRAINT resource_accesses_semantic_key_sha256_check
    CHECK (semantic_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT resource_accesses_invocation_key_sha256_check
    CHECK (invocation_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT resource_accesses_content_hash_sha256_check
    CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT resource_accesses_resource_key_check
    CHECK (resource_key ~ '^[a-z0-9_.:-]{1,64}$'),
  CONSTRAINT resource_accesses_configuration_version_check
    CHECK (configuration_version IS NULL OR configuration_version ~ '^[a-z0-9_.:-]{1,64}$'),
  CONSTRAINT resource_accesses_access_kind_check
    CHECK (access_kind IN ('read','search','write','unknown')),
  CONSTRAINT resource_accesses_evidence_basis_check
    CHECK (evidence_basis IN ('explicit_argument','connector','indirect_shell','unknown')),
  CONSTRAINT resource_accesses_outcome_check
    CHECK (outcome IN ('succeeded','failed','denied','cancelled','unknown')),
  CONSTRAINT resource_accesses_basis_check
    CHECK (basis IN ('exact','reported','estimated','unknown'))
);

CREATE UNIQUE INDEX resource_accesses_revision
  ON personal_hub.resource_accesses (account_id, semantic_key, channel, content_hash);
CREATE INDEX resource_accesses_canonical
  ON personal_hub.resource_accesses (account_id, semantic_key, observed_at DESC);
CREATE INDEX resource_accesses_time
  ON personal_hub.resource_accesses (account_id, observed_at DESC, access_kind);
CREATE INDEX resource_accesses_invocation_join
  ON personal_hub.resource_accesses (account_id, invocation_key, observed_at DESC);
CREATE INDEX resource_accesses_resource_join
  ON personal_hub.resource_accesses (account_id, resource_key, configuration_version, observed_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['agent_events','tool_events','resource_accesses'] LOOP
    EXECUTE format('ALTER TABLE personal_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON personal_hub.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON personal_hub.%I TO personal_hub_app', t);
    EXECUTE format('CREATE POLICY app_read ON personal_hub.%I FOR SELECT TO personal_hub_app USING (true)', t);
    EXECUTE format('CREATE POLICY app_insert ON personal_hub.%I FOR INSERT TO personal_hub_app WITH CHECK (true)', t);
  END LOOP;
END $$;
