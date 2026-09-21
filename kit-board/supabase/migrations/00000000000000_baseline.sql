-- Baseline schema for personal_hub. Squashed on September 22, 2026.
--
-- PRODUCTION WAS NOT BUILT FROM THIS FILE. The live database was built by running the
-- seventeen migrations dated 2026-09-08 through 2026-09-21 in sequence; they are kept
-- verbatim in ../migrations-archive/ with their own README. This baseline recreates the
-- state those seventeen leave behind and exists only so a NEW database (the AWS Aurora
-- Serverless v2 cluster, a disposable test database, a local container) can reach that
-- state in one step. Never apply it to a database that already ran the archived sequence.
--
-- It was derived, not hand-written: the seventeen archived files were applied in order to
-- a throwaway PostgreSQL 17 database and the result was dumped with
-- `pg_dump --schema-only --no-owner`. A database built from this file alone and a database
-- built from the archived sequence produce byte-identical dumps under those flags, and
-- their catalogs agree on every table, column, index, constraint, view, policy and grant.
--
-- Three deliberate differences from a raw dump of that source database:
--
--   1. `CREATE ROLE personal_hub_app` is guarded. The archived role migration issues it
--      bare, which fails on any cluster where the login role already exists (Aurora, or a
--      container that has hosted this schema before). The guard leaves an existing role
--      untouched; its password and login attributes are managed outside migrations.
--   2. The archived migrations also `REVOKE ... FROM anon, authenticated`, the two Supabase
--      browser roles. Those roles do not exist on Aurora and the statements would fail
--      there. They were no-ops for the resulting ACLs in any case: neither role was ever
--      granted anything, so the dump of the source database does not mention them either.
--      Every table here still starts with no privileges for PUBLIC and grants only the
--      narrow set `personal_hub_app` needs.
--   3. `SET transaction_timeout` and the other pg_dump timeout preamble lines are dropped.
--      `transaction_timeout` is PostgreSQL 17 only and would fail on a 16 cluster; none of
--      them describe the schema.
--
-- One constraint is intentionally `NOT VALID`:
-- `account_usage_buckets_reasoning_subset_check`. It enforces the subset rule for every new
-- write but has never been validated against the rows production accepted before it existed.
-- A new database has no such rows, so it could be validated there, but leaving it NOT VALID
-- keeps this file an exact description of the schema the application is tested against.
--
-- Future changes go in their own timestamped migration beside this one. This file is a
-- starting point and is not edited again.

-- The application login role is cluster-level, not schema-level, so it may already exist.
DO $baseline_role$
BEGIN
  CREATE ROLE personal_hub_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'role personal_hub_app already exists; leaving its attributes alone';
END
$baseline_role$;
--
-- One more note on how the text was produced: pg_dump prints `x BETWEEN 1 AND 80 AND y` as
-- `((x >= 1) AND (x <= 80)) AND (y)`, and re-parsing that flattens the two ANDs into one
-- three-armed AND. The predicate is the same either way, but the stored expression is not,
-- so the two `..._label_check` constraints keep the `BETWEEN` form the archived migrations
-- used. With those two lines the dumps match exactly, with no diff to explain away.

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: personal_hub; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS personal_hub;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_usage_buckets; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.account_usage_buckets (
    id uuid NOT NULL,
    account_id text NOT NULL,
    binding_id uuid NOT NULL,
    provider text NOT NULL,
    adapter text NOT NULL,
    report_source text NOT NULL,
    bucket_start timestamp with time zone NOT NULL,
    bucket_end timestamp with time zone NOT NULL,
    provider_timezone text,
    model text,
    product text,
    client text,
    user_ref text,
    workspace_ref text,
    api_key_ref text,
    dimensions_hash text NOT NULL,
    requests bigint,
    input_tokens bigint,
    cached_tokens bigint,
    cache_write_tokens bigint,
    output_tokens bigint,
    reasoning_tokens bigint,
    total_tokens bigint,
    provider_event_id text,
    provider_refreshed_at timestamp with time zone,
    basis text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    reasoning_effort text,
    service_tier text,
    speed text,
    context_window_tokens bigint,
    cache_write_ttl text,
    unclassified_tokens bigint,
    token_state text,
    CONSTRAINT account_usage_buckets_api_key_ref_sha256_check CHECK (((api_key_ref IS NULL) OR (api_key_ref ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT account_usage_buckets_cache_write_tokens_check CHECK (((cache_write_tokens IS NULL) OR (cache_write_tokens >= 0))),
    CONSTRAINT account_usage_buckets_cache_write_ttl_check CHECK (((cache_write_ttl IS NULL) OR (cache_write_ttl ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT account_usage_buckets_cached_tokens_check CHECK (((cached_tokens IS NULL) OR (cached_tokens >= 0))),
    CONSTRAINT account_usage_buckets_check CHECK ((bucket_end > bucket_start)),
    CONSTRAINT account_usage_buckets_content_hash_sha256_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT account_usage_buckets_context_window_tokens_check CHECK (((context_window_tokens IS NULL) OR (context_window_tokens >= 0))),
    CONSTRAINT account_usage_buckets_dimensions_hash_sha256_check CHECK ((dimensions_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT account_usage_buckets_input_tokens_check CHECK (((input_tokens IS NULL) OR (input_tokens >= 0))),
    CONSTRAINT account_usage_buckets_output_tokens_check CHECK (((output_tokens IS NULL) OR (output_tokens >= 0))),
    CONSTRAINT account_usage_buckets_reasoning_effort_check CHECK (((reasoning_effort IS NULL) OR (reasoning_effort ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT account_usage_buckets_reasoning_tokens_check CHECK (((reasoning_tokens IS NULL) OR (reasoning_tokens >= 0))),
    CONSTRAINT account_usage_buckets_requests_check CHECK (((requests IS NULL) OR (requests >= 0))),
    CONSTRAINT account_usage_buckets_service_tier_check CHECK (((service_tier IS NULL) OR (service_tier ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT account_usage_buckets_speed_check CHECK (((speed IS NULL) OR (speed ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT account_usage_buckets_token_accounting_check CHECK (((token_state IS NULL) OR (
CASE token_state
    WHEN 'complete'::text THEN ((num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) = 4) AND (((total_tokens IS NULL) AND (unclassified_tokens IS NULL)) OR (((total_tokens)::numeric >= ((((input_tokens)::numeric + (cached_tokens)::numeric) + (cache_write_tokens)::numeric) + (output_tokens)::numeric)) AND ((reasoning_tokens IS NULL) OR (reasoning_tokens <= total_tokens)) AND ((unclassified_tokens)::numeric = (((((total_tokens)::numeric - (input_tokens)::numeric) - (cached_tokens)::numeric) - (cache_write_tokens)::numeric) - (output_tokens)::numeric)))))
    WHEN 'partial'::text THEN ((num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) < 4) AND ((num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) > 0) OR (total_tokens IS NOT NULL) OR (reasoning_tokens IS NOT NULL)) AND (((total_tokens IS NULL) AND (unclassified_tokens IS NULL)) OR ((total_tokens IS NOT NULL) AND (((((COALESCE(input_tokens, (0)::bigint))::numeric + (COALESCE(cached_tokens, (0)::bigint))::numeric) + (COALESCE(cache_write_tokens, (0)::bigint))::numeric) + (COALESCE(output_tokens, reasoning_tokens, (0)::bigint))::numeric) <= (total_tokens)::numeric) AND ((unclassified_tokens)::numeric = (((((total_tokens)::numeric - (COALESCE(input_tokens, (0)::bigint))::numeric) - (COALESCE(cached_tokens, (0)::bigint))::numeric) - (COALESCE(cache_write_tokens, (0)::bigint))::numeric) - (COALESCE(output_tokens, (0)::bigint))::numeric)))))
    WHEN 'inconsistent'::text THEN ((total_tokens IS NOT NULL) AND (((((COALESCE(input_tokens, (0)::bigint))::numeric + (COALESCE(cached_tokens, (0)::bigint))::numeric) + (COALESCE(cache_write_tokens, (0)::bigint))::numeric) + (COALESCE(output_tokens, reasoning_tokens, (0)::bigint))::numeric) > (total_tokens)::numeric) AND (unclassified_tokens IS NULL))
    WHEN 'unknown'::text THEN ((num_nonnulls(input_tokens, cached_tokens, cache_write_tokens, output_tokens) = 0) AND (reasoning_tokens IS NULL) AND (total_tokens IS NULL) AND (unclassified_tokens IS NULL))
    ELSE false
END IS TRUE))),
    CONSTRAINT account_usage_buckets_token_accounting_presence_check CHECK (((token_state IS NOT NULL) OR (unclassified_tokens IS NULL))),
    CONSTRAINT account_usage_buckets_token_state_check CHECK (((token_state IS NULL) OR (token_state = ANY (ARRAY['complete'::text, 'partial'::text, 'inconsistent'::text, 'unknown'::text])))),
    CONSTRAINT account_usage_buckets_total_tokens_check CHECK (((total_tokens IS NULL) OR (total_tokens >= 0))),
    CONSTRAINT account_usage_buckets_unclassified_tokens_check CHECK (((unclassified_tokens IS NULL) OR (unclassified_tokens >= 0))),
    CONSTRAINT account_usage_buckets_user_ref_sha256_check CHECK (((user_ref IS NULL) OR (user_ref ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT account_usage_buckets_workspace_ref_sha256_check CHECK (((workspace_ref IS NULL) OR (workspace_ref ~ '^[a-f0-9]{64}$'::text)))
);


--
-- Name: activity_requests; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.activity_requests (
    id uuid NOT NULL,
    account_id text NOT NULL,
    binding_id uuid NOT NULL,
    provider text NOT NULL,
    adapter text NOT NULL,
    channel text NOT NULL,
    record_id uuid NOT NULL,
    semantic_key text NOT NULL,
    product text NOT NULL,
    surface text NOT NULL,
    execution_host text NOT NULL,
    session_hash text NOT NULL,
    session_identity text NOT NULL,
    parent_session_hash text,
    model_requested text,
    model_actual text,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    observed_at timestamp with time zone NOT NULL,
    input_fresh_tokens bigint,
    input_cached_tokens bigint,
    input_cache_write_tokens bigint,
    output_tokens bigint,
    reasoning_tokens bigint,
    total_tokens bigint GENERATED ALWAYS AS (
CASE
    WHEN ((input_fresh_tokens IS NULL) OR (input_cached_tokens IS NULL) OR (input_cache_write_tokens IS NULL) OR (output_tokens IS NULL)) THEN NULL::bigint
    ELSE (((input_fresh_tokens + input_cached_tokens) + input_cache_write_tokens) + output_tokens)
END) STORED,
    basis text NOT NULL,
    tool_calls integer,
    tools jsonb,
    project_hash text,
    client_version text,
    latency_ms integer,
    outcome text NOT NULL,
    parser_version text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    reported_total_tokens bigint,
    unclassified_tokens bigint,
    token_state text,
    reasoning_effort text,
    service_tier text,
    speed text,
    context_window_tokens bigint,
    cache_write_ttl text,
    agent_key text,
    agent_identity_basis text,
    parent_agent_key text,
    parent_agent_identity_basis text,
    agent_class text,
    agent_name text,
    agent_depth bigint,
    project_key text,
    project_basis text,
    activity_at timestamp with time zone GENERATED ALWAYS AS (COALESCE(ended_at, started_at, observed_at)) STORED,
    observed_total_tokens bigint GENERATED ALWAYS AS (COALESCE(reported_total_tokens,
CASE
    WHEN ((input_fresh_tokens IS NULL) OR (input_cached_tokens IS NULL) OR (input_cache_write_tokens IS NULL) OR (output_tokens IS NULL)) THEN NULL::bigint
    ELSE (((input_fresh_tokens + input_cached_tokens) + input_cache_write_tokens) + output_tokens)
END)) STORED,
    CONSTRAINT activity_requests_agent_block_presence_check CHECK ((((agent_identity_basis IS NULL) AND (agent_key IS NULL) AND (parent_agent_key IS NULL) AND (parent_agent_identity_basis IS NULL) AND (agent_class IS NULL) AND (agent_name IS NULL) AND (agent_depth IS NULL)) OR ((agent_identity_basis IS NOT NULL) AND (parent_agent_identity_basis IS NOT NULL) AND (agent_class IS NOT NULL)))),
    CONSTRAINT activity_requests_agent_class_check CHECK (((agent_class IS NULL) OR (agent_class = ANY (ARRAY['main'::text, 'builtin'::text, 'custom'::text, 'unknown'::text])))),
    CONSTRAINT activity_requests_agent_depth_check CHECK (((agent_depth IS NULL) OR (agent_depth >= 0))),
    CONSTRAINT activity_requests_agent_identity_basis_check CHECK (((agent_identity_basis IS NULL) OR (agent_identity_basis = ANY (ARRAY['provider'::text, 'derived'::text, 'synthetic'::text, 'unknown'::text])))),
    CONSTRAINT activity_requests_agent_key_basis_check CHECK (((agent_identity_basis IS NULL) OR ((agent_identity_basis = 'unknown'::text) = (agent_key IS NULL)))),
    CONSTRAINT activity_requests_agent_key_sha256_check CHECK (((agent_key IS NULL) OR (agent_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT activity_requests_agent_name_check CHECK (((agent_name IS NULL) OR (agent_name ~ '^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$'::text))),
    CONSTRAINT activity_requests_basis_check CHECK ((basis = ANY (ARRAY['exact'::text, 'reported'::text, 'estimated'::text, 'unknown'::text]))),
    CONSTRAINT activity_requests_cache_write_ttl_check CHECK (((cache_write_ttl IS NULL) OR (cache_write_ttl ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT activity_requests_check CHECK (((reasoning_tokens IS NULL) OR (output_tokens IS NULL) OR (reasoning_tokens <= output_tokens))),
    CONSTRAINT activity_requests_content_hash_sha256_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT activity_requests_context_window_tokens_check CHECK (((context_window_tokens IS NULL) OR (context_window_tokens >= 0))),
    CONSTRAINT activity_requests_input_cache_write_tokens_check CHECK ((input_cache_write_tokens >= 0)),
    CONSTRAINT activity_requests_input_cached_tokens_check CHECK ((input_cached_tokens >= 0)),
    CONSTRAINT activity_requests_input_fresh_tokens_check CHECK ((input_fresh_tokens >= 0)),
    CONSTRAINT activity_requests_outcome_check CHECK ((outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'unknown'::text]))),
    CONSTRAINT activity_requests_output_tokens_check CHECK ((output_tokens >= 0)),
    CONSTRAINT activity_requests_parent_agent_identity_basis_check CHECK (((parent_agent_identity_basis IS NULL) OR (parent_agent_identity_basis = ANY (ARRAY['provider'::text, 'derived'::text, 'synthetic'::text, 'none'::text, 'unknown'::text])))),
    CONSTRAINT activity_requests_parent_agent_key_basis_check CHECK (((parent_agent_identity_basis IS NULL) OR ((parent_agent_identity_basis = ANY (ARRAY['none'::text, 'unknown'::text])) = (parent_agent_key IS NULL)))),
    CONSTRAINT activity_requests_parent_agent_key_sha256_check CHECK (((parent_agent_key IS NULL) OR (parent_agent_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT activity_requests_parent_session_hash_sha256_check CHECK (((parent_session_hash IS NULL) OR (parent_session_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT activity_requests_project_alias_check CHECK (((project_basis IS NULL) OR ((project_basis = 'working_directory'::text) AND (project_hash IS NOT NULL) AND (project_key = project_hash)) OR ((project_basis = ANY (ARRAY['native'::text, 'none'::text, 'unknown'::text])) AND (project_hash IS NULL)))),
    CONSTRAINT activity_requests_project_basis_check CHECK (((project_basis IS NULL) OR (project_basis = ANY (ARRAY['native'::text, 'working_directory'::text, 'none'::text, 'unknown'::text])))),
    CONSTRAINT activity_requests_project_hash_sha256_check CHECK (((project_hash IS NULL) OR (project_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT activity_requests_project_key_basis_check CHECK (((((project_basis IS NULL) AND (project_key IS NULL)) OR ((project_basis = ANY (ARRAY['native'::text, 'working_directory'::text])) AND (project_key IS NOT NULL)) OR ((project_basis = ANY (ARRAY['none'::text, 'unknown'::text])) AND (project_key IS NULL))) IS TRUE)),
    CONSTRAINT activity_requests_project_key_sha256_check CHECK (((project_key IS NULL) OR (project_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT activity_requests_reasoning_effort_check CHECK (((reasoning_effort IS NULL) OR (reasoning_effort ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT activity_requests_reasoning_tokens_check CHECK ((reasoning_tokens >= 0)),
    CONSTRAINT activity_requests_reported_total_tokens_check CHECK (((reported_total_tokens IS NULL) OR (reported_total_tokens >= 0))),
    CONSTRAINT activity_requests_semantic_key_sha256_check CHECK ((semantic_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT activity_requests_service_tier_check CHECK (((service_tier IS NULL) OR (service_tier ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT activity_requests_session_hash_sha256_check CHECK ((session_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT activity_requests_session_identity_check CHECK ((session_identity = ANY (ARRAY['provider'::text, 'derived'::text, 'synthetic'::text]))),
    CONSTRAINT activity_requests_speed_check CHECK (((speed IS NULL) OR (speed ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT activity_requests_token_accounting_check CHECK (((token_state IS NULL) OR (
CASE token_state
    WHEN 'complete'::text THEN ((num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) = 4) AND (((reported_total_tokens IS NULL) AND (unclassified_tokens IS NULL)) OR (((reported_total_tokens)::numeric >= ((((input_fresh_tokens)::numeric + (input_cached_tokens)::numeric) + (input_cache_write_tokens)::numeric) + (output_tokens)::numeric)) AND ((reasoning_tokens IS NULL) OR (reasoning_tokens <= reported_total_tokens)) AND ((unclassified_tokens)::numeric = (((((reported_total_tokens)::numeric - (input_fresh_tokens)::numeric) - (input_cached_tokens)::numeric) - (input_cache_write_tokens)::numeric) - (output_tokens)::numeric)))))
    WHEN 'partial'::text THEN ((num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) < 4) AND ((num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) > 0) OR (reported_total_tokens IS NOT NULL) OR (reasoning_tokens IS NOT NULL)) AND (((reported_total_tokens IS NULL) AND (unclassified_tokens IS NULL)) OR ((reported_total_tokens IS NOT NULL) AND (((((COALESCE(input_fresh_tokens, (0)::bigint))::numeric + (COALESCE(input_cached_tokens, (0)::bigint))::numeric) + (COALESCE(input_cache_write_tokens, (0)::bigint))::numeric) + (COALESCE(output_tokens, reasoning_tokens, (0)::bigint))::numeric) <= (reported_total_tokens)::numeric) AND ((unclassified_tokens)::numeric = (((((reported_total_tokens)::numeric - (COALESCE(input_fresh_tokens, (0)::bigint))::numeric) - (COALESCE(input_cached_tokens, (0)::bigint))::numeric) - (COALESCE(input_cache_write_tokens, (0)::bigint))::numeric) - (COALESCE(output_tokens, (0)::bigint))::numeric)))))
    WHEN 'inconsistent'::text THEN ((reported_total_tokens IS NOT NULL) AND (((((COALESCE(input_fresh_tokens, (0)::bigint))::numeric + (COALESCE(input_cached_tokens, (0)::bigint))::numeric) + (COALESCE(input_cache_write_tokens, (0)::bigint))::numeric) + (COALESCE(output_tokens, reasoning_tokens, (0)::bigint))::numeric) > (reported_total_tokens)::numeric) AND (unclassified_tokens IS NULL))
    WHEN 'unknown'::text THEN ((num_nonnulls(input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens) = 0) AND (reasoning_tokens IS NULL) AND (reported_total_tokens IS NULL) AND (unclassified_tokens IS NULL))
    ELSE false
END IS TRUE))),
    CONSTRAINT activity_requests_token_accounting_presence_check CHECK (((token_state IS NOT NULL) OR ((reported_total_tokens IS NULL) AND (unclassified_tokens IS NULL)))),
    CONSTRAINT activity_requests_token_state_check CHECK (((token_state IS NULL) OR (token_state = ANY (ARRAY['complete'::text, 'partial'::text, 'inconsistent'::text, 'unknown'::text])))),
    CONSTRAINT activity_requests_unclassified_tokens_check CHECK (((unclassified_tokens IS NULL) OR (unclassified_tokens >= 0)))
);


--
-- Name: companion_bindings; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.companion_bindings (
    id uuid NOT NULL,
    install_id uuid NOT NULL,
    account_id text NOT NULL,
    source_id uuid NOT NULL,
    provider text NOT NULL,
    identity_hash text,
    enabled boolean DEFAULT true NOT NULL,
    identity_reset_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT companion_bindings_provider_check CHECK ((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'cursor'::text, 'anthropic_api'::text, 'openai_api'::text])))
);


--
-- Name: usage_project_identities; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_project_identities (
    id uuid NOT NULL,
    basis text NOT NULL,
    evidence_key text NOT NULL,
    install_id uuid,
    account_id text,
    provider text,
    first_seen timestamp with time zone NOT NULL,
    last_seen timestamp with time zone NOT NULL,
    CONSTRAINT usage_project_identities_basis_check CHECK ((basis = ANY (ARRAY['native'::text, 'working_directory'::text]))),
    CONSTRAINT usage_project_identities_check CHECK ((last_seen >= first_seen)),
    CONSTRAINT usage_project_identities_check1 CHECK ((((basis = 'working_directory'::text) AND (install_id IS NOT NULL) AND (account_id IS NULL) AND (provider IS NULL)) OR ((basis = 'native'::text) AND (install_id IS NULL) AND (account_id IS NOT NULL) AND (provider IS NOT NULL)))),
    CONSTRAINT usage_project_identities_evidence_key_check CHECK ((evidence_key ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: usage_project_mapping_revisions; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_project_mapping_revisions (
    id uuid NOT NULL,
    revision_order bigint NOT NULL,
    identity_id uuid NOT NULL,
    project_id uuid,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: usage_projects; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_projects (
    id uuid NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_projects_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label))
);


--
-- Name: activity_request_project_resolution; Type: VIEW; Schema: personal_hub; Owner: -
--

CREATE VIEW personal_hub.activity_request_project_resolution WITH (security_invoker='true') AS
 WITH normalized AS (
         SELECT r_1.id,
            r_1.account_id,
            r_1.binding_id,
            r_1.provider,
            r_1.adapter,
            r_1.channel,
            r_1.record_id,
            r_1.semantic_key,
            r_1.product,
            r_1.surface,
            r_1.execution_host,
            r_1.session_hash,
            r_1.session_identity,
            r_1.parent_session_hash,
            r_1.model_requested,
            r_1.model_actual,
            r_1.started_at,
            r_1.ended_at,
            r_1.observed_at,
            r_1.input_fresh_tokens,
            r_1.input_cached_tokens,
            r_1.input_cache_write_tokens,
            r_1.output_tokens,
            r_1.reasoning_tokens,
            r_1.total_tokens,
            r_1.basis,
            r_1.tool_calls,
            r_1.tools,
            r_1.project_hash,
            r_1.client_version,
            r_1.latency_ms,
            r_1.outcome,
            r_1.parser_version,
            r_1.received_at,
            r_1.content_hash,
            r_1.reported_total_tokens,
            r_1.unclassified_tokens,
            r_1.token_state,
            r_1.reasoning_effort,
            r_1.service_tier,
            r_1.speed,
            r_1.context_window_tokens,
            r_1.cache_write_ttl,
            r_1.agent_key,
            r_1.agent_identity_basis,
            r_1.parent_agent_key,
            r_1.parent_agent_identity_basis,
            r_1.agent_class,
            r_1.agent_name,
            r_1.agent_depth,
            r_1.project_key,
            r_1.project_basis,
            r_1.activity_at,
            r_1.observed_total_tokens,
                CASE
                    WHEN ((r_1.project_basis = ANY (ARRAY['native'::text, 'working_directory'::text])) AND (r_1.project_key IS NOT NULL)) THEN r_1.project_basis
                    WHEN (r_1.project_basis = 'none'::text) THEN 'none'::text
                    WHEN ((r_1.project_basis IS NULL) AND (r_1.project_key IS NULL) AND (r_1.project_hash IS NOT NULL)) THEN 'working_directory'::text
                    ELSE 'unknown'::text
                END AS effective_project_basis,
                CASE
                    WHEN ((r_1.project_basis = ANY (ARRAY['native'::text, 'working_directory'::text])) AND (r_1.project_key IS NOT NULL)) THEN r_1.project_key
                    WHEN ((r_1.project_basis IS NULL) AND (r_1.project_key IS NULL) AND (r_1.project_hash IS NOT NULL)) THEN r_1.project_hash
                    ELSE NULL::text
                END AS effective_project_key
           FROM personal_hub.activity_requests r_1
        ), canonical AS (
         SELECT normalized.id,
            normalized.account_id,
            normalized.binding_id,
            normalized.provider,
            normalized.adapter,
            normalized.channel,
            normalized.record_id,
            normalized.semantic_key,
            normalized.product,
            normalized.surface,
            normalized.execution_host,
            normalized.session_hash,
            normalized.session_identity,
            normalized.parent_session_hash,
            normalized.model_requested,
            normalized.model_actual,
            normalized.started_at,
            normalized.ended_at,
            normalized.observed_at,
            normalized.input_fresh_tokens,
            normalized.input_cached_tokens,
            normalized.input_cache_write_tokens,
            normalized.output_tokens,
            normalized.reasoning_tokens,
            normalized.total_tokens,
            normalized.basis,
            normalized.tool_calls,
            normalized.tools,
            normalized.project_hash,
            normalized.client_version,
            normalized.latency_ms,
            normalized.outcome,
            normalized.parser_version,
            normalized.received_at,
            normalized.content_hash,
            normalized.reported_total_tokens,
            normalized.unclassified_tokens,
            normalized.token_state,
            normalized.reasoning_effort,
            normalized.service_tier,
            normalized.speed,
            normalized.context_window_tokens,
            normalized.cache_write_ttl,
            normalized.agent_key,
            normalized.agent_identity_basis,
            normalized.parent_agent_key,
            normalized.parent_agent_identity_basis,
            normalized.agent_class,
            normalized.agent_name,
            normalized.agent_depth,
            normalized.project_key,
            normalized.project_basis,
            normalized.activity_at,
            normalized.observed_total_tokens,
            normalized.effective_project_basis,
            normalized.effective_project_key,
            row_number() OVER (PARTITION BY normalized.account_id, normalized.semantic_key ORDER BY
                CASE normalized.effective_project_basis
                    WHEN 'native'::text THEN 0
                    WHEN 'working_directory'::text THEN 1
                    WHEN 'none'::text THEN 2
                    ELSE 3
                END,
                CASE normalized.channel
                    WHEN 'provider_api'::text THEN 0
                    WHEN 'app_server'::text THEN 1
                    WHEN 'local_file'::text THEN 2
                    WHEN 'local_db'::text THEN 2
                    ELSE 3
                END,
                CASE normalized.session_identity
                    WHEN 'provider'::text THEN 0
                    WHEN 'derived'::text THEN 1
                    ELSE 2
                END, normalized.observed_at DESC, normalized.received_at DESC, normalized.id DESC) AS project_revision_rank
           FROM normalized
        )
 SELECT r.id AS request_id,
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
            WHEN (r.effective_project_basis = 'none'::text) THEN 'no_project'::text
            WHEN (r.effective_project_basis = 'unknown'::text) THEN 'unknown'::text
            WHEN (i.id IS NULL) THEN 'unknown'::text
            WHEN (m.project_id IS NULL) THEN 'unassigned'::text
            ELSE 'project'::text
        END AS project_state
   FROM ((((canonical r
     JOIN personal_hub.companion_bindings b ON ((b.id = r.binding_id)))
     LEFT JOIN personal_hub.usage_project_identities i ON ((((r.effective_project_basis = 'working_directory'::text) AND (i.basis = 'working_directory'::text) AND (i.install_id = b.install_id) AND (i.evidence_key = r.effective_project_key)) OR ((r.effective_project_basis = 'native'::text) AND (i.basis = 'native'::text) AND (i.account_id = r.account_id) AND (i.provider = r.provider) AND (i.evidence_key = r.effective_project_key)))))
     LEFT JOIN LATERAL ( SELECT revision.project_id
           FROM personal_hub.usage_project_mapping_revisions revision
          WHERE (revision.identity_id = i.id)
          ORDER BY revision.revision_order DESC
         LIMIT 1) m ON (true))
     LEFT JOIN personal_hub.usage_projects p ON ((p.id = m.project_id)))
  WHERE (r.project_revision_rank = 1);


--
-- Name: agent_events; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.agent_events (
    id uuid NOT NULL,
    account_id text NOT NULL,
    binding_id uuid NOT NULL,
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
    observed_at timestamp with time zone NOT NULL,
    parser_version text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT agent_events_adapter_check CHECK ((adapter = ANY (ARRAY['claude_execution'::text, 'claude_account'::text, 'codex_execution'::text, 'codex_account'::text, 'cursor_account'::text, 'cursor_execution'::text, 'anthropic_api'::text, 'openai_api'::text, 'claude_browser'::text, 'codex_browser'::text, 'cursor_browser'::text]))),
    CONSTRAINT agent_events_agent_class_check CHECK ((agent_class = ANY (ARRAY['main'::text, 'builtin'::text, 'custom'::text, 'unknown'::text]))),
    CONSTRAINT agent_events_agent_depth_check CHECK (((agent_depth IS NULL) OR (agent_depth >= 0))),
    CONSTRAINT agent_events_agent_identity_basis_check CHECK ((agent_identity_basis = ANY (ARRAY['provider'::text, 'derived'::text, 'synthetic'::text, 'unknown'::text]))),
    CONSTRAINT agent_events_agent_key_basis_check CHECK (((agent_identity_basis = 'unknown'::text) = (agent_key IS NULL))),
    CONSTRAINT agent_events_agent_key_sha256_check CHECK (((agent_key IS NULL) OR (agent_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT agent_events_agent_name_check CHECK (((agent_name IS NULL) OR (agent_name ~ '^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$'::text))),
    CONSTRAINT agent_events_basis_check CHECK ((basis = ANY (ARRAY['exact'::text, 'reported'::text, 'estimated'::text, 'unknown'::text]))),
    CONSTRAINT agent_events_channel_check CHECK ((channel = ANY (ARRAY['local_file'::text, 'local_db'::text, 'app_server'::text, 'provider_api'::text, 'hook_snapshot'::text, 'browser_session'::text]))),
    CONSTRAINT agent_events_content_hash_sha256_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT agent_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['spawn'::text, 'start'::text, 'resume'::text, 'finish'::text]))),
    CONSTRAINT agent_events_observed_agent_check CHECK ((((event_kind = 'spawn'::text) AND (outcome <> 'succeeded'::text)) OR (agent_key IS NOT NULL))),
    CONSTRAINT agent_events_outcome_check CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'denied'::text, 'cancelled'::text, 'unknown'::text]))),
    CONSTRAINT agent_events_parent_agent_identity_basis_check CHECK ((parent_agent_identity_basis = ANY (ARRAY['provider'::text, 'derived'::text, 'synthetic'::text, 'none'::text, 'unknown'::text]))),
    CONSTRAINT agent_events_parent_agent_key_basis_check CHECK (((parent_agent_identity_basis = ANY (ARRAY['none'::text, 'unknown'::text])) = (parent_agent_key IS NULL))),
    CONSTRAINT agent_events_parent_agent_key_sha256_check CHECK (((parent_agent_key IS NULL) OR (parent_agent_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT agent_events_provider_check CHECK ((provider = ANY (ARRAY['claude'::text, 'codex'::text, 'cursor'::text, 'anthropic_api'::text, 'openai_api'::text]))),
    CONSTRAINT agent_events_semantic_key_sha256_check CHECK ((semantic_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT agent_events_session_hash_sha256_check CHECK (((session_hash IS NULL) OR (session_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT agent_events_tool_invocation_key_sha256_check CHECK (((tool_invocation_key IS NULL) OR (tool_invocation_key ~ '^[a-f0-9]{64}$'::text)))
);


--
-- Name: agent_routing_events; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.agent_routing_events (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    account_id text NOT NULL,
    provider text NOT NULL,
    event_id uuid NOT NULL,
    task_id uuid NOT NULL,
    attempt_id uuid,
    sequence bigint NOT NULL,
    event_type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    payload jsonb NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT agent_routing_events_event_type_check CHECK ((event_type = ANY (ARRAY['task.registered'::text, 'route.decided'::text, 'attempt.started'::text, 'attempt.finished'::text, 'outcome.recorded'::text]))),
    CONSTRAINT agent_routing_events_provider_check CHECK ((provider = ANY (ARRAY['codex'::text, 'claude'::text]))),
    CONSTRAINT agent_routing_events_sequence_check CHECK ((sequence >= 1))
);


--
-- Name: allowance_readings; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.allowance_readings (
    id uuid NOT NULL,
    account_id text NOT NULL,
    binding_id uuid NOT NULL,
    provider text NOT NULL,
    adapter text NOT NULL,
    reader text NOT NULL,
    meter_key text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    value double precision,
    unit text,
    capacity double precision,
    window_minutes integer,
    window_started_at timestamp with time zone,
    resets_at timestamp with time zone,
    raw_window_id text,
    observed_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    basis text DEFAULT 'reported'::text NOT NULL,
    CONSTRAINT allowance_readings_basis_check CHECK ((basis = ANY (ARRAY['exact'::text, 'reported'::text, 'estimated'::text, 'unknown'::text]))),
    CONSTRAINT allowance_readings_check CHECK (((kind <> 'percent_used'::text) OR ((value >= (0)::double precision) AND (value <= (100)::double precision)))),
    CONSTRAINT allowance_readings_check1 CHECK (((resets_at IS NULL) OR (resets_at > observed_at))),
    CONSTRAINT allowance_readings_kind_check CHECK ((kind = ANY (ARRAY['percent_used'::text, 'count_remaining'::text, 'credits_remaining'::text, 'currency_allowance'::text, 'unlimited'::text, 'unavailable'::text]))),
    CONSTRAINT allowance_readings_window_minutes_check CHECK ((window_minutes > 0))
);


--
-- Name: companion_installs; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.companion_installs (
    id uuid NOT NULL,
    machine_label text NOT NULL,
    kind text DEFAULT 'companion'::text NOT NULL,
    platform text NOT NULL,
    arch text NOT NULL,
    key_hash text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    companion_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    last_config_fetch_at timestamp with time zone,
    capabilities jsonb,
    capabilities_digest text,
    capabilities_previous_digest text,
    capabilities_reported_at timestamp with time zone,
    capabilities_changed_at timestamp with time zone,
    CONSTRAINT companion_installs_arch_check CHECK ((arch = ANY (ARRAY['arm64'::text, 'amd64'::text, 'unknown'::text]))),
    CONSTRAINT companion_installs_capabilities_digest_check CHECK (((capabilities_digest IS NULL) OR (capabilities_digest ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT companion_installs_capabilities_previous_digest_check CHECK (((capabilities_previous_digest IS NULL) OR (capabilities_previous_digest ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT companion_installs_kind_check CHECK ((kind = ANY (ARRAY['companion'::text, 'browser'::text]))),
    CONSTRAINT companion_installs_platform_check CHECK ((platform = ANY (ARRAY['darwin'::text, 'windows'::text, 'linux'::text, 'unknown'::text])))
);


--
-- Name: quota_samples; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.quota_samples (
    id uuid NOT NULL,
    account_id text NOT NULL,
    source_id uuid NOT NULL,
    content_hash text NOT NULL,
    window_key text NOT NULL,
    label text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    used_percent double precision NOT NULL,
    resets_at timestamp with time zone NOT NULL,
    window_minutes integer NOT NULL,
    CONSTRAINT quota_samples_used_percent_check CHECK (((used_percent >= (0)::double precision) AND (used_percent <= (100)::double precision))),
    CONSTRAINT quota_samples_window_minutes_check CHECK ((window_minutes > 0))
);


--
-- Name: telemetry_sources; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.telemetry_sources (
    id uuid NOT NULL,
    account_id text NOT NULL,
    machine_label text NOT NULL,
    mode text NOT NULL,
    key_hash text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    coverage jsonb,
    CONSTRAINT telemetry_sources_mode_check CHECK ((mode = ANY (ARRAY['local'::text, 'browser'::text, 'companion'::text])))
);


--
-- Name: allowance_percent_view; Type: VIEW; Schema: personal_hub; Owner: -
--

CREATE VIEW personal_hub.allowance_percent_view WITH (security_invoker='true') AS
 SELECT q.id,
    q.account_id,
    q.source_id,
    q.window_key,
    q.label,
    q.observed_at,
    q.received_at,
    q.used_percent,
    q.resets_at,
    q.window_minutes,
    'quota_samples'::text AS origin,
    'v1'::text AS reader,
    'reported'::text AS basis,
    s.disabled AS history_only
   FROM (personal_hub.quota_samples q
     JOIN personal_hub.telemetry_sources s ON ((s.id = q.source_id)))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM ((personal_hub.allowance_readings r
             JOIN personal_hub.companion_bindings rb ON ((rb.id = r.binding_id)))
             JOIN personal_hub.companion_installs ri ON ((ri.id = rb.install_id)))
          WHERE ((r.account_id = q.account_id) AND (r.meter_key = q.window_key) AND (r.observed_at = q.observed_at) AND (r.kind = 'percent_used'::text) AND (r.value = q.used_percent) AND (r.resets_at = q.resets_at) AND (r.window_minutes IS NOT NULL) AND (s.disabled OR (rb.enabled AND (NOT ri.disabled)))))))
UNION ALL
 SELECT r.id,
    r.account_id,
    b.source_id,
    r.meter_key AS window_key,
    r.label,
    r.observed_at,
    r.received_at,
    r.value AS used_percent,
    r.resets_at,
    r.window_minutes,
    'allowance_readings'::text AS origin,
    r.reader,
    r.basis,
    ((NOT b.enabled) OR i.disabled) AS history_only
   FROM ((personal_hub.allowance_readings r
     JOIN personal_hub.companion_bindings b ON ((b.id = r.binding_id)))
     JOIN personal_hub.companion_installs i ON ((i.id = b.install_id)))
  WHERE ((r.kind = 'percent_used'::text) AND (r.resets_at IS NOT NULL) AND (r.window_minutes IS NOT NULL));


--
-- Name: collection_settings; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.collection_settings (
    id smallint NOT NULL,
    settings jsonb NOT NULL,
    settings_version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    latest_companion_version text,
    latest_companion_checked_at timestamp with time zone,
    latest_companion_etag text,
    CONSTRAINT collection_settings_id_check CHECK ((id = 1))
);


--
-- Name: companion_pairing_codes; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.companion_pairing_codes (
    code_hash text NOT NULL,
    machine_label text NOT NULL,
    kind text DEFAULT 'companion'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    install_id uuid,
    CONSTRAINT companion_pairing_codes_kind_check CHECK ((kind = ANY (ARRAY['companion'::text, 'browser'::text])))
);


--
-- Name: companion_runs; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.companion_runs (
    id uuid NOT NULL,
    install_id uuid NOT NULL,
    run_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    companion_version text NOT NULL,
    settings_version integer NOT NULL,
    coverage jsonb NOT NULL,
    accepted_buckets integer NOT NULL,
    accepted_records integer NOT NULL,
    rejected_records integer NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_by_type jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: login_limits; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.login_limits (
    bucket text NOT NULL,
    attempts integer NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: money_entries; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.money_entries (
    id uuid NOT NULL,
    account_id text NOT NULL,
    binding_id uuid NOT NULL,
    provider text NOT NULL,
    adapter text NOT NULL,
    entry_kind text NOT NULL,
    amount numeric(18,6) NOT NULL,
    unit text NOT NULL,
    source_unit text,
    price_basis text NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    reference_kind text NOT NULL,
    reference_key text,
    sku text,
    model text,
    basis text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT money_entries_entry_kind_check CHECK ((entry_kind = ANY (ARRAY['estimate'::text, 'included_usage'::text, 'metered_charge'::text, 'credit_grant'::text, 'credit_consumption'::text, 'adjustment'::text, 'invoice_line'::text]))),
    CONSTRAINT money_entries_reference_kind_check CHECK ((reference_kind = ANY (ARRAY['activity_request'::text, 'usage_bucket'::text, 'provider_event'::text, 'none'::text]))),
    CONSTRAINT money_entries_unit_check CHECK ((unit = ANY (ARRAY['USD'::text, 'credits'::text])))
);


--
-- Name: report_assets; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.report_assets (
    report_id uuid NOT NULL,
    asset_key text NOT NULL,
    filename text NOT NULL,
    media_type text NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT report_assets_asset_key_check CHECK ((asset_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT report_assets_content_check CHECK ((octet_length(content) <= 4000000)),
    CONSTRAINT report_assets_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT report_assets_filename_check CHECK ((filename ~ '^[A-Za-z0-9._-]{1,200}$'::text)),
    CONSTRAINT report_assets_media_type_check CHECK ((media_type = ANY (ARRAY['application/json'::text, 'text/csv'::text, 'text/markdown'::text, 'text/plain'::text, 'text/html'::text])))
);


--
-- Name: report_revisions; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.report_revisions (
    id uuid NOT NULL,
    kind text NOT NULL,
    period_key text NOT NULL,
    subject_key text NOT NULL,
    producer_id text NOT NULL,
    idempotency_key text NOT NULL,
    title text NOT NULL,
    produced_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    status text NOT NULL,
    schema_version integer NOT NULL,
    coverage jsonb NOT NULL,
    payload jsonb NOT NULL,
    html text,
    content_hash text NOT NULL,
    CONSTRAINT report_revisions_kind_check CHECK ((kind = ANY (ARRAY['usage'::text, 'tasks'::text, 'standup'::text, 'readings'::text, 'audit'::text]))),
    CONSTRAINT report_revisions_status_check CHECK ((status = ANY (ARRAY['complete'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: reset_feed_revisions; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.reset_feed_revisions (
    source text NOT NULL,
    content_hash text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    payload jsonb NOT NULL
);


--
-- Name: reset_feed_state; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.reset_feed_state (
    source text NOT NULL,
    checked_at timestamp with time zone,
    succeeded_at timestamp with time zone,
    next_check_at timestamp with time zone,
    error text,
    etag text,
    last_modified text,
    current_hash text
);


--
-- Name: resource_accesses; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.resource_accesses (
    id uuid NOT NULL,
    account_id text NOT NULL,
    binding_id uuid NOT NULL,
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
    observed_at timestamp with time zone NOT NULL,
    parser_version text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT resource_accesses_access_kind_check CHECK ((access_kind = ANY (ARRAY['read'::text, 'search'::text, 'write'::text, 'unknown'::text]))),
    CONSTRAINT resource_accesses_adapter_check CHECK ((adapter = ANY (ARRAY['claude_execution'::text, 'claude_account'::text, 'codex_execution'::text, 'codex_account'::text, 'cursor_account'::text, 'cursor_execution'::text, 'anthropic_api'::text, 'openai_api'::text, 'claude_browser'::text, 'codex_browser'::text, 'cursor_browser'::text]))),
    CONSTRAINT resource_accesses_basis_check CHECK ((basis = ANY (ARRAY['exact'::text, 'reported'::text, 'estimated'::text, 'unknown'::text]))),
    CONSTRAINT resource_accesses_channel_check CHECK ((channel = ANY (ARRAY['local_file'::text, 'local_db'::text, 'app_server'::text, 'provider_api'::text, 'hook_snapshot'::text, 'browser_session'::text]))),
    CONSTRAINT resource_accesses_configuration_version_check CHECK (((configuration_version IS NULL) OR (configuration_version ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT resource_accesses_content_hash_sha256_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT resource_accesses_evidence_basis_check CHECK ((evidence_basis = ANY (ARRAY['explicit_argument'::text, 'connector'::text, 'indirect_shell'::text, 'unknown'::text]))),
    CONSTRAINT resource_accesses_invocation_key_sha256_check CHECK ((invocation_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT resource_accesses_outcome_check CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'denied'::text, 'cancelled'::text, 'unknown'::text]))),
    CONSTRAINT resource_accesses_provider_check CHECK ((provider = ANY (ARRAY['claude'::text, 'codex'::text, 'cursor'::text, 'anthropic_api'::text, 'openai_api'::text]))),
    CONSTRAINT resource_accesses_resource_key_check CHECK ((resource_key ~ '^[a-z0-9_.:-]{1,64}$'::text)),
    CONSTRAINT resource_accesses_semantic_key_sha256_check CHECK ((semantic_key ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: usage_knowledge_source_identities; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_knowledge_source_identities (
    id uuid NOT NULL,
    install_id uuid NOT NULL,
    resource_key text NOT NULL,
    configuration_version text,
    first_seen timestamp with time zone NOT NULL,
    last_seen timestamp with time zone NOT NULL,
    CONSTRAINT usage_knowledge_source_identities_check CHECK ((last_seen >= first_seen)),
    CONSTRAINT usage_knowledge_source_identities_configuration_version_check CHECK (((configuration_version IS NULL) OR (configuration_version ~ '^[a-z0-9_.:-]{1,64}$'::text))),
    CONSTRAINT usage_knowledge_source_identities_resource_key_check CHECK ((resource_key ~ '^[a-z0-9_.:-]{1,64}$'::text))
);


--
-- Name: usage_knowledge_source_mapping_revisions; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_knowledge_source_mapping_revisions (
    id uuid NOT NULL,
    revision_order bigint NOT NULL,
    identity_id uuid NOT NULL,
    source_id uuid,
    changed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);


--
-- Name: usage_knowledge_sources; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_knowledge_sources (
    id uuid NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_knowledge_sources_label_check CHECK (char_length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label))
);


--
-- Name: resource_access_source_resolution; Type: VIEW; Schema: personal_hub; Owner: -
--

CREATE VIEW personal_hub.resource_access_source_resolution WITH (security_invoker='true') AS
 WITH canonical AS (
         SELECT r_1.id,
            r_1.account_id,
            r_1.binding_id,
            r_1.provider,
            r_1.adapter,
            r_1.channel,
            r_1.record_id,
            r_1.semantic_key,
            r_1.invocation_key,
            r_1.resource_key,
            r_1.configuration_version,
            r_1.access_kind,
            r_1.evidence_basis,
            r_1.outcome,
            r_1.basis,
            r_1.observed_at,
            r_1.parser_version,
            r_1.received_at,
            r_1.content_hash,
            row_number() OVER (PARTITION BY r_1.account_id, r_1.semantic_key ORDER BY r_1.observed_at DESC, r_1.received_at DESC, r_1.id DESC) AS access_revision_rank
           FROM personal_hub.resource_accesses r_1
        )
 SELECT r.id AS access_id,
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
            WHEN (i.id IS NULL) THEN 'unknown'::text
            WHEN (m.source_id IS NULL) THEN 'unassigned'::text
            ELSE 'source'::text
        END AS source_state,
    (NOT (r.configuration_version IS DISTINCT FROM i.configuration_version)) AS current_configuration
   FROM ((((canonical r
     JOIN personal_hub.companion_bindings b ON ((b.id = r.binding_id)))
     LEFT JOIN personal_hub.usage_knowledge_source_identities i ON (((i.install_id = b.install_id) AND (i.resource_key = r.resource_key))))
     LEFT JOIN LATERAL ( SELECT revision.source_id
           FROM personal_hub.usage_knowledge_source_mapping_revisions revision
          WHERE (revision.identity_id = i.id)
          ORDER BY revision.revision_order DESC
         LIMIT 1) m ON (true))
     LEFT JOIN personal_hub.usage_knowledge_sources s ON ((s.id = m.source_id)))
  WHERE (r.access_revision_rank = 1);


--
-- Name: token_bucket_revisions; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.token_bucket_revisions (
    id uuid NOT NULL,
    account_id text NOT NULL,
    source_id uuid NOT NULL,
    session_hash text NOT NULL,
    hour timestamp with time zone NOT NULL,
    model text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    input_tokens bigint NOT NULL,
    cached_tokens bigint NOT NULL,
    cache_write_tokens bigint NOT NULL,
    output_tokens bigint NOT NULL,
    total_tokens bigint NOT NULL,
    calls bigint NOT NULL,
    CONSTRAINT token_bucket_revisions_cache_write_tokens_check CHECK ((cache_write_tokens >= 0)),
    CONSTRAINT token_bucket_revisions_cached_tokens_check CHECK ((cached_tokens >= 0)),
    CONSTRAINT token_bucket_revisions_calls_check CHECK ((calls >= 0)),
    CONSTRAINT token_bucket_revisions_check CHECK ((total_tokens = (((input_tokens + cached_tokens) + cache_write_tokens) + output_tokens))),
    CONSTRAINT token_bucket_revisions_input_tokens_check CHECK ((input_tokens >= 0)),
    CONSTRAINT token_bucket_revisions_output_tokens_check CHECK ((output_tokens >= 0))
);


--
-- Name: token_bucket_canonical; Type: VIEW; Schema: personal_hub; Owner: -
--

CREATE VIEW personal_hub.token_bucket_canonical WITH (security_invoker='true') AS
 SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.id,
    t.account_id,
    t.source_id,
    t.session_hash,
    t.hour,
    t.model,
    t.observed_at,
    t.received_at,
    t.content_hash,
    t.input_tokens,
    t.cached_tokens,
    t.cache_write_tokens,
    t.output_tokens,
    t.total_tokens,
    t.calls,
    s.mode AS source_mode,
    s.disabled AS source_disabled
   FROM (personal_hub.token_bucket_revisions t
     JOIN personal_hub.telemetry_sources s ON ((s.id = t.source_id)))
  ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC, t.id DESC;


--
-- Name: tool_events; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.tool_events (
    id uuid NOT NULL,
    account_id text NOT NULL,
    binding_id uuid NOT NULL,
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
    observed_at timestamp with time zone NOT NULL,
    parser_version text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    content_hash text NOT NULL,
    CONSTRAINT tool_events_adapter_check CHECK ((adapter = ANY (ARRAY['claude_execution'::text, 'claude_account'::text, 'codex_execution'::text, 'codex_account'::text, 'cursor_account'::text, 'cursor_execution'::text, 'anthropic_api'::text, 'openai_api'::text, 'claude_browser'::text, 'codex_browser'::text, 'cursor_browser'::text]))),
    CONSTRAINT tool_events_basis_check CHECK ((basis = ANY (ARRAY['exact'::text, 'reported'::text, 'estimated'::text, 'unknown'::text]))),
    CONSTRAINT tool_events_caller_agent_key_sha256_check CHECK (((caller_agent_key IS NULL) OR (caller_agent_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tool_events_caller_request_key_sha256_check CHECK (((caller_request_key IS NULL) OR (caller_request_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tool_events_channel_check CHECK ((channel = ANY (ARRAY['local_file'::text, 'local_db'::text, 'app_server'::text, 'provider_api'::text, 'hook_snapshot'::text, 'browser_session'::text]))),
    CONSTRAINT tool_events_content_hash_sha256_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT tool_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['invocation'::text, 'result'::text]))),
    CONSTRAINT tool_events_invocation_identity_check CHECK ((((event_kind = 'invocation'::text) AND (semantic_key = invocation_key)) OR ((event_kind = 'result'::text) AND (semantic_key <> invocation_key)))),
    CONSTRAINT tool_events_invocation_key_sha256_check CHECK ((invocation_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT tool_events_outcome_check CHECK ((outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'denied'::text, 'cancelled'::text, 'unknown'::text]))),
    CONSTRAINT tool_events_parent_invocation_key_sha256_check CHECK (((parent_invocation_key IS NULL) OR (parent_invocation_key ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tool_events_provider_check CHECK ((provider = ANY (ARRAY['claude'::text, 'codex'::text, 'cursor'::text, 'anthropic_api'::text, 'openai_api'::text]))),
    CONSTRAINT tool_events_semantic_key_sha256_check CHECK ((semantic_key ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT tool_events_session_hash_sha256_check CHECK (((session_hash IS NULL) OR (session_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT tool_events_tool_class_check CHECK ((tool_class = ANY (ARRAY['builtin'::text, 'mcp'::text, 'function'::text, 'custom'::text, 'unknown'::text]))),
    CONSTRAINT tool_events_tool_name_check CHECK (((tool_name IS NULL) OR (tool_name ~ '^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$'::text))),
    CONSTRAINT tool_events_tool_namespace_check CHECK (((tool_namespace IS NULL) OR (tool_namespace ~ '^[a-z0-9_.:-]{1,64}$'::text)))
);


--
-- Name: usage_accounts; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_accounts (
    id text NOT NULL,
    provider text NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_accounts_provider_check CHECK ((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'cursor'::text, 'anthropic_api'::text, 'openai_api'::text])))
);


--
-- Name: usage_calibrations; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_calibrations (
    id uuid NOT NULL,
    account_id text NOT NULL,
    window_key text NOT NULL,
    window_minutes integer NOT NULL,
    start_sample_id uuid NOT NULL,
    end_sample_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone NOT NULL,
    local_tokens double precision NOT NULL,
    percent_delta double precision NOT NULL,
    tokens_per_point double precision NOT NULL,
    method_version text NOT NULL,
    confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT usage_calibrations_check CHECK ((((window_key = 'five_hour'::text) AND (window_minutes = 300)) OR ((window_key = 'seven_day'::text) AND (window_minutes = 10080)))),
    CONSTRAINT usage_calibrations_check1 CHECK ((ended_at >= (started_at + '02:00:00'::interval))),
    CONSTRAINT usage_calibrations_check2 CHECK ((end_sample_id <> start_sample_id)),
    CONSTRAINT usage_calibrations_local_tokens_check CHECK (((local_tokens > (0)::double precision) AND (local_tokens < 'Infinity'::double precision))),
    CONSTRAINT usage_calibrations_method_version_check CHECK ((method_version = 'local-equivalent-v1-prorated-hours'::text)),
    CONSTRAINT usage_calibrations_percent_delta_check CHECK (((percent_delta >= (3)::double precision) AND (percent_delta <= (100)::double precision))),
    CONSTRAINT usage_calibrations_tokens_per_point_check CHECK (((tokens_per_point > (0)::double precision) AND (tokens_per_point < 'Infinity'::double precision))),
    CONSTRAINT usage_calibrations_window_key_check CHECK ((window_key = ANY (ARRAY['five_hour'::text, 'seven_day'::text])))
);


--
-- Name: usage_knowledge_source_mapping_revisions_revision_order_seq; Type: SEQUENCE; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_knowledge_source_mapping_revisions ALTER COLUMN revision_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME personal_hub.usage_knowledge_source_mapping_revisions_revision_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: usage_project_mapping_revisions_revision_order_seq; Type: SEQUENCE; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_project_mapping_revisions ALTER COLUMN revision_order ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME personal_hub.usage_project_mapping_revisions_revision_order_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: usage_report_subjects; Type: TABLE; Schema: personal_hub; Owner: -
--

CREATE TABLE personal_hub.usage_report_subjects (
    subject_key text NOT NULL,
    account_id text,
    source_timezone text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_report_subjects_source_timezone_check CHECK (((source_timezone IS NULL) OR (source_timezone ~ '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$'::text))),
    CONSTRAINT usage_report_subjects_subject_key_check CHECK ((subject_key ~ '^[a-zA-Z0-9._-]{1,80}$'::text))
);


--
-- Name: account_usage_buckets account_usage_buckets_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.account_usage_buckets
    ADD CONSTRAINT account_usage_buckets_pkey PRIMARY KEY (id);


--
-- Name: account_usage_buckets account_usage_buckets_reasoning_subset_check; Type: CHECK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.account_usage_buckets
    ADD CONSTRAINT account_usage_buckets_reasoning_subset_check CHECK (((reasoning_tokens IS NULL) OR (output_tokens IS NULL) OR (reasoning_tokens <= output_tokens))) NOT VALID;


--
-- Name: activity_requests activity_requests_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.activity_requests
    ADD CONSTRAINT activity_requests_pkey PRIMARY KEY (id);


--
-- Name: activity_requests activity_requests_revision; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.activity_requests
    ADD CONSTRAINT activity_requests_revision UNIQUE (account_id, semantic_key, channel, content_hash);


--
-- Name: agent_events agent_events_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_events
    ADD CONSTRAINT agent_events_pkey PRIMARY KEY (id);


--
-- Name: agent_routing_events agent_routing_events_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_routing_events
    ADD CONSTRAINT agent_routing_events_pkey PRIMARY KEY (id);


--
-- Name: agent_routing_events agent_routing_events_source_id_event_id_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_routing_events
    ADD CONSTRAINT agent_routing_events_source_id_event_id_key UNIQUE (source_id, event_id);


--
-- Name: agent_routing_events agent_routing_events_source_id_task_id_sequence_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_routing_events
    ADD CONSTRAINT agent_routing_events_source_id_task_id_sequence_key UNIQUE (source_id, task_id, sequence);


--
-- Name: allowance_readings allowance_readings_account_id_meter_key_reader_observed_at_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.allowance_readings
    ADD CONSTRAINT allowance_readings_account_id_meter_key_reader_observed_at_key UNIQUE (account_id, meter_key, reader, observed_at);


--
-- Name: allowance_readings allowance_readings_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.allowance_readings
    ADD CONSTRAINT allowance_readings_pkey PRIMARY KEY (id);


--
-- Name: collection_settings collection_settings_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.collection_settings
    ADD CONSTRAINT collection_settings_pkey PRIMARY KEY (id);


--
-- Name: companion_bindings companion_bindings_install_id_account_id_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_bindings
    ADD CONSTRAINT companion_bindings_install_id_account_id_key UNIQUE (install_id, account_id);


--
-- Name: companion_bindings companion_bindings_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_bindings
    ADD CONSTRAINT companion_bindings_pkey PRIMARY KEY (id);


--
-- Name: companion_bindings companion_bindings_source_id_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_bindings
    ADD CONSTRAINT companion_bindings_source_id_key UNIQUE (source_id);


--
-- Name: companion_installs companion_installs_key_hash_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_installs
    ADD CONSTRAINT companion_installs_key_hash_key UNIQUE (key_hash);


--
-- Name: companion_installs companion_installs_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_installs
    ADD CONSTRAINT companion_installs_pkey PRIMARY KEY (id);


--
-- Name: companion_pairing_codes companion_pairing_codes_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_pairing_codes
    ADD CONSTRAINT companion_pairing_codes_pkey PRIMARY KEY (code_hash);


--
-- Name: companion_runs companion_runs_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_runs
    ADD CONSTRAINT companion_runs_pkey PRIMARY KEY (id);


--
-- Name: companion_runs companion_runs_run_id_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_runs
    ADD CONSTRAINT companion_runs_run_id_key UNIQUE (run_id);


--
-- Name: login_limits login_limits_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.login_limits
    ADD CONSTRAINT login_limits_pkey PRIMARY KEY (bucket);


--
-- Name: money_entries money_entries_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.money_entries
    ADD CONSTRAINT money_entries_pkey PRIMARY KEY (id);


--
-- Name: quota_samples quota_samples_account_id_content_hash_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.quota_samples
    ADD CONSTRAINT quota_samples_account_id_content_hash_key UNIQUE (account_id, content_hash);


--
-- Name: quota_samples quota_samples_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.quota_samples
    ADD CONSTRAINT quota_samples_pkey PRIMARY KEY (id);


--
-- Name: report_assets report_assets_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.report_assets
    ADD CONSTRAINT report_assets_pkey PRIMARY KEY (report_id, asset_key);


--
-- Name: report_revisions report_revisions_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.report_revisions
    ADD CONSTRAINT report_revisions_pkey PRIMARY KEY (id);


--
-- Name: report_revisions report_revisions_producer_id_kind_idempotency_key_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.report_revisions
    ADD CONSTRAINT report_revisions_producer_id_kind_idempotency_key_key UNIQUE (producer_id, kind, idempotency_key);


--
-- Name: reset_feed_revisions reset_feed_revisions_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.reset_feed_revisions
    ADD CONSTRAINT reset_feed_revisions_pkey PRIMARY KEY (source, content_hash);


--
-- Name: reset_feed_state reset_feed_state_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.reset_feed_state
    ADD CONSTRAINT reset_feed_state_pkey PRIMARY KEY (source);


--
-- Name: resource_accesses resource_accesses_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.resource_accesses
    ADD CONSTRAINT resource_accesses_pkey PRIMARY KEY (id);


--
-- Name: telemetry_sources telemetry_sources_key_hash_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.telemetry_sources
    ADD CONSTRAINT telemetry_sources_key_hash_key UNIQUE (key_hash);


--
-- Name: telemetry_sources telemetry_sources_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.telemetry_sources
    ADD CONSTRAINT telemetry_sources_pkey PRIMARY KEY (id);


--
-- Name: token_bucket_revisions token_bucket_revisions_account_id_session_hash_hour_model_c_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.token_bucket_revisions
    ADD CONSTRAINT token_bucket_revisions_account_id_session_hash_hour_model_c_key UNIQUE (account_id, session_hash, hour, model, content_hash);


--
-- Name: token_bucket_revisions token_bucket_revisions_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.token_bucket_revisions
    ADD CONSTRAINT token_bucket_revisions_pkey PRIMARY KEY (id);


--
-- Name: tool_events tool_events_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.tool_events
    ADD CONSTRAINT tool_events_pkey PRIMARY KEY (id);


--
-- Name: usage_accounts usage_accounts_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_accounts
    ADD CONSTRAINT usage_accounts_pkey PRIMARY KEY (id);


--
-- Name: usage_calibrations usage_calibrations_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_calibrations
    ADD CONSTRAINT usage_calibrations_pkey PRIMARY KEY (id);


--
-- Name: usage_knowledge_source_identities usage_knowledge_source_identities_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_source_identities
    ADD CONSTRAINT usage_knowledge_source_identities_pkey PRIMARY KEY (id);


--
-- Name: usage_knowledge_source_identities usage_knowledge_source_identity_scope; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_source_identities
    ADD CONSTRAINT usage_knowledge_source_identity_scope UNIQUE (install_id, resource_key);


--
-- Name: usage_knowledge_source_mapping_revisions usage_knowledge_source_mapping_revisions_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_source_mapping_revisions
    ADD CONSTRAINT usage_knowledge_source_mapping_revisions_pkey PRIMARY KEY (id);


--
-- Name: usage_knowledge_source_mapping_revisions usage_knowledge_source_mapping_revisions_revision_order_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_source_mapping_revisions
    ADD CONSTRAINT usage_knowledge_source_mapping_revisions_revision_order_key UNIQUE (revision_order);


--
-- Name: usage_knowledge_sources usage_knowledge_sources_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_sources
    ADD CONSTRAINT usage_knowledge_sources_pkey PRIMARY KEY (id);


--
-- Name: usage_project_identities usage_project_identities_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_project_identities
    ADD CONSTRAINT usage_project_identities_pkey PRIMARY KEY (id);


--
-- Name: usage_project_mapping_revisions usage_project_mapping_revisions_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_project_mapping_revisions
    ADD CONSTRAINT usage_project_mapping_revisions_pkey PRIMARY KEY (id);


--
-- Name: usage_project_mapping_revisions usage_project_mapping_revisions_revision_order_key; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_project_mapping_revisions
    ADD CONSTRAINT usage_project_mapping_revisions_revision_order_key UNIQUE (revision_order);


--
-- Name: usage_projects usage_projects_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_projects
    ADD CONSTRAINT usage_projects_pkey PRIMARY KEY (id);


--
-- Name: usage_report_subjects usage_report_subjects_pkey; Type: CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_report_subjects
    ADD CONSTRAINT usage_report_subjects_pkey PRIMARY KEY (subject_key);


--
-- Name: account_usage_current; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX account_usage_current ON personal_hub.account_usage_buckets USING btree (account_id, report_source, bucket_start DESC, dimensions_hash, provider_refreshed_at DESC NULLS LAST, observed_at DESC);


--
-- Name: account_usage_revision; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX account_usage_revision ON personal_hub.account_usage_buckets USING btree (account_id, report_source, bucket_start, bucket_end, dimensions_hash, COALESCE(provider_event_id, ''::text), content_hash);


--
-- Name: activity_requests_activity_time; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_activity_time ON personal_hub.activity_requests USING btree (account_id, activity_at DESC, model_actual);


--
-- Name: activity_requests_agent_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_agent_join ON personal_hub.activity_requests USING btree (account_id, agent_key, activity_at DESC) WHERE (agent_key IS NOT NULL);


--
-- Name: activity_requests_binding_recent; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_binding_recent ON personal_hub.activity_requests USING btree (binding_id, observed_at DESC);


--
-- Name: activity_requests_canonical; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_canonical ON personal_hub.activity_requests USING btree (account_id, semantic_key, observed_at DESC);


--
-- Name: activity_requests_parent_agent_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_parent_agent_join ON personal_hub.activity_requests USING btree (account_id, parent_agent_key, activity_at DESC) WHERE (parent_agent_key IS NOT NULL);


--
-- Name: activity_requests_project_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_project_join ON personal_hub.activity_requests USING btree (account_id, project_key, activity_at DESC) WHERE (project_key IS NOT NULL);


--
-- Name: activity_requests_semantic_activity; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_semantic_activity ON personal_hub.activity_requests USING btree (account_id, semantic_key, activity_at);


--
-- Name: activity_requests_time; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX activity_requests_time ON personal_hub.activity_requests USING btree (account_id, observed_at DESC, model_actual);


--
-- Name: agent_events_agent_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX agent_events_agent_join ON personal_hub.agent_events USING btree (account_id, agent_key, observed_at DESC) WHERE (agent_key IS NOT NULL);


--
-- Name: agent_events_canonical; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX agent_events_canonical ON personal_hub.agent_events USING btree (account_id, semantic_key, observed_at DESC);


--
-- Name: agent_events_parent_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX agent_events_parent_join ON personal_hub.agent_events USING btree (account_id, parent_agent_key, observed_at DESC) WHERE (parent_agent_key IS NOT NULL);


--
-- Name: agent_events_revision; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX agent_events_revision ON personal_hub.agent_events USING btree (account_id, semantic_key, channel, content_hash);


--
-- Name: agent_events_time; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX agent_events_time ON personal_hub.agent_events USING btree (account_id, observed_at DESC, event_kind);


--
-- Name: agent_events_tool_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX agent_events_tool_join ON personal_hub.agent_events USING btree (account_id, tool_invocation_key, observed_at DESC) WHERE (tool_invocation_key IS NOT NULL);


--
-- Name: agent_routing_events_account_time; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX agent_routing_events_account_time ON personal_hub.agent_routing_events USING btree (account_id, occurred_at DESC);


--
-- Name: agent_routing_events_task_history; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX agent_routing_events_task_history ON personal_hub.agent_routing_events USING btree (source_id, task_id, sequence, received_at);


--
-- Name: allowance_history; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX allowance_history ON personal_hub.allowance_readings USING btree (account_id, meter_key, observed_at DESC);


--
-- Name: allowance_readings_binding_recent; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX allowance_readings_binding_recent ON personal_hub.allowance_readings USING btree (binding_id, observed_at DESC);


--
-- Name: companion_runs_recent; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX companion_runs_recent ON personal_hub.companion_runs USING btree (install_id, finished_at DESC);


--
-- Name: money_entry_revision; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX money_entry_revision ON personal_hub.money_entries USING btree (account_id, entry_kind, reference_kind, COALESCE(reference_key, ''::text), content_hash);


--
-- Name: money_period; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX money_period ON personal_hub.money_entries USING btree (account_id, period_start DESC, entry_kind);


--
-- Name: quota_sample_history; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX quota_sample_history ON personal_hub.quota_samples USING btree (account_id, window_key, observed_at DESC);


--
-- Name: report_current; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX report_current ON personal_hub.report_revisions USING btree (kind, period_key, subject_key, produced_at DESC);


--
-- Name: report_history; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX report_history ON personal_hub.report_revisions USING btree (kind, period_key DESC, produced_at DESC);


--
-- Name: resource_accesses_canonical; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX resource_accesses_canonical ON personal_hub.resource_accesses USING btree (account_id, semantic_key, observed_at DESC);


--
-- Name: resource_accesses_invocation_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX resource_accesses_invocation_join ON personal_hub.resource_accesses USING btree (account_id, invocation_key, observed_at DESC);


--
-- Name: resource_accesses_resource_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX resource_accesses_resource_join ON personal_hub.resource_accesses USING btree (account_id, resource_key, configuration_version, observed_at DESC);


--
-- Name: resource_accesses_revision; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX resource_accesses_revision ON personal_hub.resource_accesses USING btree (account_id, semantic_key, channel, content_hash);


--
-- Name: resource_accesses_time; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX resource_accesses_time ON personal_hub.resource_accesses USING btree (account_id, observed_at DESC, access_kind);


--
-- Name: token_bucket_current; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX token_bucket_current ON personal_hub.token_bucket_revisions USING btree (account_id, hour DESC, session_hash, model, observed_at DESC);


--
-- Name: tool_events_caller_agent_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_caller_agent_join ON personal_hub.tool_events USING btree (account_id, caller_agent_key, observed_at DESC) WHERE (caller_agent_key IS NOT NULL);


--
-- Name: tool_events_caller_request_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_caller_request_join ON personal_hub.tool_events USING btree (account_id, caller_request_key, observed_at DESC) WHERE (caller_request_key IS NOT NULL);


--
-- Name: tool_events_canonical; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_canonical ON personal_hub.tool_events USING btree (account_id, semantic_key, observed_at DESC);


--
-- Name: tool_events_invocation_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_invocation_join ON personal_hub.tool_events USING btree (account_id, invocation_key, observed_at DESC);


--
-- Name: tool_events_kind_invocation; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_kind_invocation ON personal_hub.tool_events USING btree (account_id, event_kind, invocation_key, observed_at DESC);


--
-- Name: tool_events_kind_time; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_kind_time ON personal_hub.tool_events USING btree (account_id, event_kind, observed_at DESC);


--
-- Name: tool_events_parent_invocation_join; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_parent_invocation_join ON personal_hub.tool_events USING btree (account_id, parent_invocation_key, observed_at DESC) WHERE (parent_invocation_key IS NOT NULL);


--
-- Name: tool_events_revision; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX tool_events_revision ON personal_hub.tool_events USING btree (account_id, semantic_key, channel, content_hash);


--
-- Name: tool_events_time; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX tool_events_time ON personal_hub.tool_events USING btree (account_id, observed_at DESC, event_kind);


--
-- Name: usage_calibration_active; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX usage_calibration_active ON personal_hub.usage_calibrations USING btree (account_id, confirmed_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: usage_calibration_end; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX usage_calibration_end ON personal_hub.usage_calibrations USING btree (end_sample_id);


--
-- Name: usage_calibration_receipt; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX usage_calibration_receipt ON personal_hub.usage_calibrations USING btree (account_id, start_sample_id, end_sample_id, method_version) WHERE (revoked_at IS NULL);


--
-- Name: usage_calibration_start; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX usage_calibration_start ON personal_hub.usage_calibrations USING btree (start_sample_id);


--
-- Name: usage_knowledge_source_mapping_history; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX usage_knowledge_source_mapping_history ON personal_hub.usage_knowledge_source_mapping_revisions USING btree (identity_id, revision_order DESC);


--
-- Name: usage_project_identity_native; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX usage_project_identity_native ON personal_hub.usage_project_identities USING btree (account_id, provider, evidence_key) WHERE (basis = 'native'::text);


--
-- Name: usage_project_identity_working_directory; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE UNIQUE INDEX usage_project_identity_working_directory ON personal_hub.usage_project_identities USING btree (install_id, evidence_key) WHERE (basis = 'working_directory'::text);


--
-- Name: usage_project_mapping_history; Type: INDEX; Schema: personal_hub; Owner: -
--

CREATE INDEX usage_project_mapping_history ON personal_hub.usage_project_mapping_revisions USING btree (identity_id, revision_order DESC);


--
-- Name: account_usage_buckets account_usage_buckets_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.account_usage_buckets
    ADD CONSTRAINT account_usage_buckets_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: account_usage_buckets account_usage_buckets_binding_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.account_usage_buckets
    ADD CONSTRAINT account_usage_buckets_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES personal_hub.companion_bindings(id);


--
-- Name: activity_requests activity_requests_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.activity_requests
    ADD CONSTRAINT activity_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: activity_requests activity_requests_binding_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.activity_requests
    ADD CONSTRAINT activity_requests_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES personal_hub.companion_bindings(id);


--
-- Name: agent_events agent_events_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_events
    ADD CONSTRAINT agent_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: agent_events agent_events_binding_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_events
    ADD CONSTRAINT agent_events_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES personal_hub.companion_bindings(id);


--
-- Name: agent_routing_events agent_routing_events_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_routing_events
    ADD CONSTRAINT agent_routing_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: agent_routing_events agent_routing_events_source_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.agent_routing_events
    ADD CONSTRAINT agent_routing_events_source_id_fkey FOREIGN KEY (source_id) REFERENCES personal_hub.telemetry_sources(id);


--
-- Name: allowance_readings allowance_readings_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.allowance_readings
    ADD CONSTRAINT allowance_readings_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: allowance_readings allowance_readings_binding_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.allowance_readings
    ADD CONSTRAINT allowance_readings_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES personal_hub.companion_bindings(id);


--
-- Name: companion_bindings companion_bindings_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_bindings
    ADD CONSTRAINT companion_bindings_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: companion_bindings companion_bindings_install_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_bindings
    ADD CONSTRAINT companion_bindings_install_id_fkey FOREIGN KEY (install_id) REFERENCES personal_hub.companion_installs(id);


--
-- Name: companion_bindings companion_bindings_source_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_bindings
    ADD CONSTRAINT companion_bindings_source_id_fkey FOREIGN KEY (source_id) REFERENCES personal_hub.telemetry_sources(id);


--
-- Name: companion_pairing_codes companion_pairing_codes_install_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_pairing_codes
    ADD CONSTRAINT companion_pairing_codes_install_id_fkey FOREIGN KEY (install_id) REFERENCES personal_hub.companion_installs(id);


--
-- Name: companion_runs companion_runs_install_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.companion_runs
    ADD CONSTRAINT companion_runs_install_id_fkey FOREIGN KEY (install_id) REFERENCES personal_hub.companion_installs(id);


--
-- Name: money_entries money_entries_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.money_entries
    ADD CONSTRAINT money_entries_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: money_entries money_entries_binding_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.money_entries
    ADD CONSTRAINT money_entries_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES personal_hub.companion_bindings(id);


--
-- Name: quota_samples quota_samples_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.quota_samples
    ADD CONSTRAINT quota_samples_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: quota_samples quota_samples_source_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.quota_samples
    ADD CONSTRAINT quota_samples_source_id_fkey FOREIGN KEY (source_id) REFERENCES personal_hub.telemetry_sources(id);


--
-- Name: report_assets report_assets_report_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.report_assets
    ADD CONSTRAINT report_assets_report_id_fkey FOREIGN KEY (report_id) REFERENCES personal_hub.report_revisions(id);


--
-- Name: reset_feed_revisions reset_feed_revisions_source_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.reset_feed_revisions
    ADD CONSTRAINT reset_feed_revisions_source_fkey FOREIGN KEY (source) REFERENCES personal_hub.reset_feed_state(source);


--
-- Name: resource_accesses resource_accesses_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.resource_accesses
    ADD CONSTRAINT resource_accesses_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: resource_accesses resource_accesses_binding_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.resource_accesses
    ADD CONSTRAINT resource_accesses_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES personal_hub.companion_bindings(id);


--
-- Name: telemetry_sources telemetry_sources_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.telemetry_sources
    ADD CONSTRAINT telemetry_sources_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: token_bucket_revisions token_bucket_revisions_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.token_bucket_revisions
    ADD CONSTRAINT token_bucket_revisions_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: token_bucket_revisions token_bucket_revisions_source_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.token_bucket_revisions
    ADD CONSTRAINT token_bucket_revisions_source_id_fkey FOREIGN KEY (source_id) REFERENCES personal_hub.telemetry_sources(id);


--
-- Name: tool_events tool_events_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.tool_events
    ADD CONSTRAINT tool_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: tool_events tool_events_binding_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.tool_events
    ADD CONSTRAINT tool_events_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES personal_hub.companion_bindings(id);


--
-- Name: usage_calibrations usage_calibrations_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_calibrations
    ADD CONSTRAINT usage_calibrations_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: usage_calibrations usage_calibrations_end_sample_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_calibrations
    ADD CONSTRAINT usage_calibrations_end_sample_id_fkey FOREIGN KEY (end_sample_id) REFERENCES personal_hub.quota_samples(id);


--
-- Name: usage_calibrations usage_calibrations_start_sample_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_calibrations
    ADD CONSTRAINT usage_calibrations_start_sample_id_fkey FOREIGN KEY (start_sample_id) REFERENCES personal_hub.quota_samples(id);


--
-- Name: usage_knowledge_source_identities usage_knowledge_source_identities_install_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_source_identities
    ADD CONSTRAINT usage_knowledge_source_identities_install_id_fkey FOREIGN KEY (install_id) REFERENCES personal_hub.companion_installs(id);


--
-- Name: usage_knowledge_source_mapping_revisions usage_knowledge_source_mapping_revisions_identity_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_source_mapping_revisions
    ADD CONSTRAINT usage_knowledge_source_mapping_revisions_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES personal_hub.usage_knowledge_source_identities(id);


--
-- Name: usage_knowledge_source_mapping_revisions usage_knowledge_source_mapping_revisions_source_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_knowledge_source_mapping_revisions
    ADD CONSTRAINT usage_knowledge_source_mapping_revisions_source_id_fkey FOREIGN KEY (source_id) REFERENCES personal_hub.usage_knowledge_sources(id);


--
-- Name: usage_project_identities usage_project_identities_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_project_identities
    ADD CONSTRAINT usage_project_identities_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: usage_project_identities usage_project_identities_install_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_project_identities
    ADD CONSTRAINT usage_project_identities_install_id_fkey FOREIGN KEY (install_id) REFERENCES personal_hub.companion_installs(id);


--
-- Name: usage_project_mapping_revisions usage_project_mapping_revisions_identity_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_project_mapping_revisions
    ADD CONSTRAINT usage_project_mapping_revisions_identity_id_fkey FOREIGN KEY (identity_id) REFERENCES personal_hub.usage_project_identities(id);


--
-- Name: usage_project_mapping_revisions usage_project_mapping_revisions_project_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_project_mapping_revisions
    ADD CONSTRAINT usage_project_mapping_revisions_project_id_fkey FOREIGN KEY (project_id) REFERENCES personal_hub.usage_projects(id);


--
-- Name: usage_report_subjects usage_report_subjects_account_id_fkey; Type: FK CONSTRAINT; Schema: personal_hub; Owner: -
--

ALTER TABLE ONLY personal_hub.usage_report_subjects
    ADD CONSTRAINT usage_report_subjects_account_id_fkey FOREIGN KEY (account_id) REFERENCES personal_hub.usage_accounts(id);


--
-- Name: account_usage_buckets; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.account_usage_buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: activity_requests; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.activity_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_events; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.agent_events ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_routing_events; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.agent_routing_events ENABLE ROW LEVEL SECURITY;

--
-- Name: allowance_readings; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.allowance_readings ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_routing_events app_append; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_append ON personal_hub.agent_routing_events FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: report_assets app_append_report_assets; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_append_report_assets ON personal_hub.report_assets FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: report_revisions app_append_reports; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_append_reports ON personal_hub.report_revisions FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: account_usage_buckets app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.account_usage_buckets FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: activity_requests app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.activity_requests FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: agent_events app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.agent_events FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: allowance_readings app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.allowance_readings FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: collection_settings app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.collection_settings FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: companion_bindings app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.companion_bindings FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: companion_installs app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.companion_installs FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: companion_pairing_codes app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.companion_pairing_codes FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: companion_runs app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.companion_runs FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: money_entries app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.money_entries FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: quota_samples app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.quota_samples FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: reset_feed_revisions app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.reset_feed_revisions FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: reset_feed_state app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.reset_feed_state FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: resource_accesses app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.resource_accesses FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: telemetry_sources app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.telemetry_sources FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: token_bucket_revisions app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.token_bucket_revisions FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: tool_events app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.tool_events FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_accounts app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_accounts FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_calibrations app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_calibrations FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_knowledge_source_identities app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_knowledge_source_identities FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_knowledge_source_mapping_revisions app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_knowledge_source_mapping_revisions FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_knowledge_sources app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_knowledge_sources FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_project_identities app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_project_identities FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_project_mapping_revisions app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_project_mapping_revisions FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_projects app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_projects FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: usage_report_subjects app_insert; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert ON personal_hub.usage_report_subjects FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: login_limits app_insert_limits; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_insert_limits ON personal_hub.login_limits FOR INSERT TO personal_hub_app WITH CHECK (true);


--
-- Name: account_usage_buckets app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.account_usage_buckets FOR SELECT TO personal_hub_app USING (true);


--
-- Name: activity_requests app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.activity_requests FOR SELECT TO personal_hub_app USING (true);


--
-- Name: agent_events app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.agent_events FOR SELECT TO personal_hub_app USING (true);


--
-- Name: agent_routing_events app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.agent_routing_events FOR SELECT TO personal_hub_app USING (true);


--
-- Name: allowance_readings app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.allowance_readings FOR SELECT TO personal_hub_app USING (true);


--
-- Name: collection_settings app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.collection_settings FOR SELECT TO personal_hub_app USING (true);


--
-- Name: companion_bindings app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.companion_bindings FOR SELECT TO personal_hub_app USING (true);


--
-- Name: companion_installs app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.companion_installs FOR SELECT TO personal_hub_app USING (true);


--
-- Name: companion_pairing_codes app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.companion_pairing_codes FOR SELECT TO personal_hub_app USING (true);


--
-- Name: companion_runs app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.companion_runs FOR SELECT TO personal_hub_app USING (true);


--
-- Name: money_entries app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.money_entries FOR SELECT TO personal_hub_app USING (true);


--
-- Name: quota_samples app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.quota_samples FOR SELECT TO personal_hub_app USING (true);


--
-- Name: reset_feed_revisions app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.reset_feed_revisions FOR SELECT TO personal_hub_app USING (true);


--
-- Name: reset_feed_state app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.reset_feed_state FOR SELECT TO personal_hub_app USING (true);


--
-- Name: resource_accesses app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.resource_accesses FOR SELECT TO personal_hub_app USING (true);


--
-- Name: telemetry_sources app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.telemetry_sources FOR SELECT TO personal_hub_app USING (true);


--
-- Name: token_bucket_revisions app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.token_bucket_revisions FOR SELECT TO personal_hub_app USING (true);


--
-- Name: tool_events app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.tool_events FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_accounts app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_accounts FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_calibrations app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_calibrations FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_knowledge_source_identities app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_knowledge_source_identities FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_knowledge_source_mapping_revisions app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_knowledge_source_mapping_revisions FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_knowledge_sources app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_knowledge_sources FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_project_identities app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_project_identities FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_project_mapping_revisions app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_project_mapping_revisions FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_projects app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_projects FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_report_subjects app_read; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read ON personal_hub.usage_report_subjects FOR SELECT TO personal_hub_app USING (true);


--
-- Name: login_limits app_read_limits; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read_limits ON personal_hub.login_limits FOR SELECT TO personal_hub_app USING (true);


--
-- Name: report_assets app_read_report_assets; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read_report_assets ON personal_hub.report_assets FOR SELECT TO personal_hub_app USING (true);


--
-- Name: report_revisions app_read_reports; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_read_reports ON personal_hub.report_revisions FOR SELECT TO personal_hub_app USING (true);


--
-- Name: usage_calibrations app_revoke; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_revoke ON personal_hub.usage_calibrations FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: collection_settings app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.collection_settings FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: companion_bindings app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.companion_bindings FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: companion_installs app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.companion_installs FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: companion_pairing_codes app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.companion_pairing_codes FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: companion_runs app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.companion_runs FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: reset_feed_state app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.reset_feed_state FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: telemetry_sources app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.telemetry_sources FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: usage_knowledge_source_identities app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.usage_knowledge_source_identities FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: usage_knowledge_sources app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.usage_knowledge_sources FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: usage_project_identities app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.usage_project_identities FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: usage_projects app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.usage_projects FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: usage_report_subjects app_update; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update ON personal_hub.usage_report_subjects FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: login_limits app_update_limits; Type: POLICY; Schema: personal_hub; Owner: -
--

CREATE POLICY app_update_limits ON personal_hub.login_limits FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);


--
-- Name: collection_settings; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.collection_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: companion_bindings; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.companion_bindings ENABLE ROW LEVEL SECURITY;

--
-- Name: companion_installs; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.companion_installs ENABLE ROW LEVEL SECURITY;

--
-- Name: companion_pairing_codes; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.companion_pairing_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: companion_runs; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.companion_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: login_limits; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.login_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: money_entries; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.money_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: quota_samples; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.quota_samples ENABLE ROW LEVEL SECURITY;

--
-- Name: report_assets; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.report_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: report_revisions; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.report_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: reset_feed_revisions; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.reset_feed_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: reset_feed_state; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.reset_feed_state ENABLE ROW LEVEL SECURITY;

--
-- Name: resource_accesses; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.resource_accesses ENABLE ROW LEVEL SECURITY;

--
-- Name: telemetry_sources; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.telemetry_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: token_bucket_revisions; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.token_bucket_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: tool_events; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.tool_events ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_accounts; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_calibrations; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_calibrations ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_knowledge_source_identities; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_knowledge_source_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_knowledge_source_mapping_revisions; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_knowledge_source_mapping_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_knowledge_sources; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_knowledge_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_project_identities; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_project_identities ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_project_mapping_revisions; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_project_mapping_revisions ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_projects; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_projects ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_report_subjects; Type: ROW SECURITY; Schema: personal_hub; Owner: -
--

ALTER TABLE personal_hub.usage_report_subjects ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA personal_hub; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA personal_hub TO personal_hub_app;


--
-- Name: TABLE account_usage_buckets; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.account_usage_buckets TO personal_hub_app;


--
-- Name: TABLE activity_requests; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.activity_requests TO personal_hub_app;


--
-- Name: TABLE companion_bindings; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.companion_bindings TO personal_hub_app;


--
-- Name: TABLE usage_project_identities; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_project_identities TO personal_hub_app;


--
-- Name: COLUMN usage_project_identities.first_seen; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(first_seen) ON TABLE personal_hub.usage_project_identities TO personal_hub_app;


--
-- Name: COLUMN usage_project_identities.last_seen; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(last_seen) ON TABLE personal_hub.usage_project_identities TO personal_hub_app;


--
-- Name: TABLE usage_project_mapping_revisions; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_project_mapping_revisions TO personal_hub_app;


--
-- Name: TABLE usage_projects; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_projects TO personal_hub_app;


--
-- Name: COLUMN usage_projects.label; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(label) ON TABLE personal_hub.usage_projects TO personal_hub_app;


--
-- Name: COLUMN usage_projects.updated_at; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE personal_hub.usage_projects TO personal_hub_app;


--
-- Name: TABLE activity_request_project_resolution; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT ON TABLE personal_hub.activity_request_project_resolution TO personal_hub_app;


--
-- Name: TABLE agent_events; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.agent_events TO personal_hub_app;


--
-- Name: TABLE agent_routing_events; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.agent_routing_events TO personal_hub_app;


--
-- Name: TABLE allowance_readings; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.allowance_readings TO personal_hub_app;


--
-- Name: TABLE companion_installs; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.companion_installs TO personal_hub_app;


--
-- Name: TABLE quota_samples; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.quota_samples TO personal_hub_app;


--
-- Name: TABLE telemetry_sources; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.telemetry_sources TO personal_hub_app;


--
-- Name: TABLE allowance_percent_view; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT ON TABLE personal_hub.allowance_percent_view TO personal_hub_app;


--
-- Name: TABLE collection_settings; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.collection_settings TO personal_hub_app;


--
-- Name: TABLE companion_pairing_codes; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.companion_pairing_codes TO personal_hub_app;


--
-- Name: TABLE companion_runs; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.companion_runs TO personal_hub_app;


--
-- Name: TABLE login_limits; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.login_limits TO personal_hub_app;


--
-- Name: TABLE money_entries; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.money_entries TO personal_hub_app;


--
-- Name: TABLE report_assets; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.report_assets TO personal_hub_app;


--
-- Name: TABLE report_revisions; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.report_revisions TO personal_hub_app;


--
-- Name: TABLE reset_feed_revisions; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.reset_feed_revisions TO personal_hub_app;


--
-- Name: TABLE reset_feed_state; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.reset_feed_state TO personal_hub_app;


--
-- Name: TABLE resource_accesses; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.resource_accesses TO personal_hub_app;


--
-- Name: TABLE usage_knowledge_source_identities; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_knowledge_source_identities TO personal_hub_app;


--
-- Name: COLUMN usage_knowledge_source_identities.configuration_version; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(configuration_version) ON TABLE personal_hub.usage_knowledge_source_identities TO personal_hub_app;


--
-- Name: COLUMN usage_knowledge_source_identities.first_seen; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(first_seen) ON TABLE personal_hub.usage_knowledge_source_identities TO personal_hub_app;


--
-- Name: COLUMN usage_knowledge_source_identities.last_seen; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(last_seen) ON TABLE personal_hub.usage_knowledge_source_identities TO personal_hub_app;


--
-- Name: TABLE usage_knowledge_source_mapping_revisions; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_knowledge_source_mapping_revisions TO personal_hub_app;


--
-- Name: TABLE usage_knowledge_sources; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_knowledge_sources TO personal_hub_app;


--
-- Name: COLUMN usage_knowledge_sources.label; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(label) ON TABLE personal_hub.usage_knowledge_sources TO personal_hub_app;


--
-- Name: COLUMN usage_knowledge_sources.updated_at; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE personal_hub.usage_knowledge_sources TO personal_hub_app;


--
-- Name: TABLE resource_access_source_resolution; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT ON TABLE personal_hub.resource_access_source_resolution TO personal_hub_app;


--
-- Name: TABLE token_bucket_revisions; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.token_bucket_revisions TO personal_hub_app;


--
-- Name: TABLE token_bucket_canonical; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT ON TABLE personal_hub.token_bucket_canonical TO personal_hub_app;


--
-- Name: TABLE tool_events; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.tool_events TO personal_hub_app;


--
-- Name: TABLE usage_accounts; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_accounts TO personal_hub_app;


--
-- Name: TABLE usage_calibrations; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT ON TABLE personal_hub.usage_calibrations TO personal_hub_app;


--
-- Name: COLUMN usage_calibrations.revoked_at; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT UPDATE(revoked_at) ON TABLE personal_hub.usage_calibrations TO personal_hub_app;


--
-- Name: SEQUENCE usage_knowledge_source_mapping_revisions_revision_order_seq; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE personal_hub.usage_knowledge_source_mapping_revisions_revision_order_seq TO personal_hub_app;


--
-- Name: SEQUENCE usage_project_mapping_revisions_revision_order_seq; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE personal_hub.usage_project_mapping_revisions_revision_order_seq TO personal_hub_app;


--
-- Name: TABLE usage_report_subjects; Type: ACL; Schema: personal_hub; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE personal_hub.usage_report_subjects TO personal_hub_app;

--
-- Name: collection_settings; Type: SEED DATA; Schema: personal_hub; Owner: -
--
-- The one seeded row the archived sequence leaves behind. `collection_settings` is a
-- singleton the application reads on every collection request; the defaults live in code,
-- so the row is empty JSON. Every other INSERT in the archived migrations backfilled
-- registry identities from ledger rows and does nothing on an empty database.

INSERT INTO personal_hub.collection_settings (id, settings)
  VALUES (1, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;
