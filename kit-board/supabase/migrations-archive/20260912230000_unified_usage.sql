-- Unified usage collection (envelope v2): companion installs, pairing, bindings, settings,
-- and four independent ledgers beside the untouched v1 tables. Existing tables change only
-- through two widened CHECK constraints, located by name because both were created inline.
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'personal_hub.usage_accounts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%provider%';
  EXECUTE format('ALTER TABLE personal_hub.usage_accounts DROP CONSTRAINT %I', c);
  ALTER TABLE personal_hub.usage_accounts ADD CONSTRAINT usage_accounts_provider_check
    CHECK (provider IN ('codex','claude','cursor','anthropic_api','openai_api'));
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'personal_hub.telemetry_sources'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%mode%';
  EXECUTE format('ALTER TABLE personal_hub.telemetry_sources DROP CONSTRAINT %I', c);
  ALTER TABLE personal_hub.telemetry_sources ADD CONSTRAINT telemetry_sources_mode_check CHECK (mode IN ('local','browser','companion'));
END $$;

CREATE TABLE personal_hub.collection_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  settings jsonb NOT NULL, settings_version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  latest_companion_version text, latest_companion_checked_at timestamptz,   -- written by the daily release check
  latest_companion_etag text
);

CREATE TABLE personal_hub.companion_installs (
  id uuid PRIMARY KEY, machine_label text NOT NULL,
  kind text NOT NULL DEFAULT 'companion' CHECK (kind IN ('companion','browser')),
  platform text NOT NULL CHECK (platform IN ('darwin','windows','linux','unknown')),
  arch text NOT NULL CHECK (arch IN ('arm64','amd64','unknown')),
  key_hash text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,          -- partial override of collection_settings.settings
  paused boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
  companion_version text,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, last_config_fetch_at timestamptz
);

CREATE TABLE personal_hub.companion_pairing_codes (
  code_hash text PRIMARY KEY, machine_label text NOT NULL,
  kind text NOT NULL DEFAULT 'companion' CHECK (kind IN ('companion','browser')),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  used_at timestamptz, install_id uuid REFERENCES personal_hub.companion_installs(id)
);

CREATE TABLE personal_hub.companion_bindings (
  id uuid PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  -- Every binding owns a v1 source row (mode 'companion') so hourly buckets keep flowing into the
  -- existing ledger and canonical query. That row's key_hash is random and never issued: only the
  -- install key authenticates, and only through /api/v1/usage.
  source_id uuid NOT NULL UNIQUE REFERENCES personal_hub.telemetry_sources(id),
  provider text NOT NULL CHECK (provider IN ('codex','claude','cursor','anthropic_api','openai_api')),
  identity_hash text, enabled boolean NOT NULL DEFAULT true,
  -- Set when the UI approves a re-confirmation: identity_hash is cleared and the binding refuses
  -- records until the install posts the new hash it observed.
  identity_reset_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (install_id, account_id)
);

CREATE TABLE personal_hub.companion_runs (
  id uuid PRIMARY KEY, install_id uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  run_id uuid NOT NULL UNIQUE, started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
  companion_version text NOT NULL, settings_version integer NOT NULL,
  coverage jsonb NOT NULL,                                 -- validated adapterCoverageSchema[]
  accepted_buckets integer NOT NULL, accepted_records integer NOT NULL, rejected_records integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companion_runs_recent ON personal_hub.companion_runs (install_id, finished_at DESC);

-- Ledger 1: request activity. One row per observation; canonical selection at read time.
CREATE TABLE personal_hub.activity_requests (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL, channel text NOT NULL,
  record_id uuid NOT NULL, semantic_key text NOT NULL,
  product text NOT NULL, surface text NOT NULL, execution_host text NOT NULL,
  session_hash text NOT NULL, session_identity text NOT NULL CHECK (session_identity IN ('provider','derived','synthetic')),
  parent_session_hash text, model_requested text, model_actual text NOT NULL,
  started_at timestamptz, ended_at timestamptz, observed_at timestamptz NOT NULL,
  input_fresh_tokens bigint CHECK (input_fresh_tokens >= 0), input_cached_tokens bigint CHECK (input_cached_tokens >= 0),
  input_cache_write_tokens bigint CHECK (input_cache_write_tokens >= 0), output_tokens bigint CHECK (output_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  total_tokens bigint GENERATED ALWAYS AS (
    CASE WHEN input_fresh_tokens IS NULL OR input_cached_tokens IS NULL OR input_cache_write_tokens IS NULL OR output_tokens IS NULL THEN NULL
         ELSE input_fresh_tokens + input_cached_tokens + input_cache_write_tokens + output_tokens END) STORED,
  basis text NOT NULL CHECK (basis IN ('exact','reported','estimated','unknown')),
  tool_calls integer, tools jsonb, project_hash text, client_version text, latency_ms integer,
  outcome text NOT NULL CHECK (outcome IN ('completed','failed','cancelled','unknown')),
  parser_version text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL,
  CHECK (reasoning_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens <= output_tokens),
  UNIQUE (account_id, semantic_key, channel, content_hash)
);
CREATE INDEX activity_requests_canonical ON personal_hub.activity_requests (account_id, semantic_key, observed_at DESC);
CREATE INDEX activity_requests_time ON personal_hub.activity_requests (account_id, observed_at DESC, model_actual);

-- Ledger 2: provider-reported account usage. Revisable within its exact scope; never joined into ledger 1.
CREATE TABLE personal_hub.account_usage_buckets (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL, report_source text NOT NULL,
  bucket_start timestamptz NOT NULL, bucket_end timestamptz NOT NULL, provider_timezone text,
  model text, product text, client text, user_ref text, workspace_ref text, api_key_ref text,
  dimensions_hash text NOT NULL,                           -- sha256 of the six dimension columns
  requests bigint, input_tokens bigint, cached_tokens bigint, cache_write_tokens bigint,
  output_tokens bigint, reasoning_tokens bigint, total_tokens bigint,
  provider_event_id text, provider_refreshed_at timestamptz,
  basis text NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  CHECK (bucket_end > bucket_start)
);
CREATE UNIQUE INDEX account_usage_revision ON personal_hub.account_usage_buckets
  (account_id, report_source, bucket_start, bucket_end, dimensions_hash, coalesce(provider_event_id, ''), content_hash);
CREATE INDEX account_usage_current ON personal_hub.account_usage_buckets (account_id, report_source, bucket_start DESC, dimensions_hash, provider_refreshed_at DESC NULLS LAST, observed_at DESC);

-- Ledger 3: typed allowance readings. Coexists with v1 quota_samples through a compatibility view.
CREATE TABLE personal_hub.allowance_readings (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL, reader text NOT NULL,
  meter_key text NOT NULL, label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent_used','count_remaining','credits_remaining','currency_allowance','unlimited','unavailable')),
  value double precision, unit text, capacity double precision,
  window_minutes integer CHECK (window_minutes > 0), window_started_at timestamptz, resets_at timestamptz,
  raw_window_id text, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL,
  CHECK (kind <> 'percent_used' OR (value BETWEEN 0 AND 100)),
  CHECK (resets_at IS NULL OR resets_at > observed_at),
  UNIQUE (account_id, meter_key, reader, observed_at)
);
CREATE INDEX allowance_history ON personal_hub.allowance_readings (account_id, meter_key, observed_at DESC);

-- Percent windows from both ledgers, excluding disabled sources and bindings, keyed by the shared
-- window key. `source_id` and `received_at` let the existing readers keep their freshness joins.
CREATE VIEW personal_hub.allowance_percent_view WITH (security_invoker = true) AS
  SELECT q.id, q.account_id, q.source_id, q.window_key, q.label, q.observed_at, q.received_at, q.used_percent, q.resets_at, q.window_minutes,
         'quota_samples'::text AS origin, 'v1'::text AS reader
    FROM personal_hub.quota_samples q JOIN personal_hub.telemetry_sources s ON s.id = q.source_id AND NOT s.disabled
  UNION ALL
  SELECT r.id, r.account_id, b.source_id, r.meter_key, r.label, r.observed_at, r.received_at, r.value, r.resets_at, r.window_minutes,
         'allowance_readings'::text, r.reader
    FROM personal_hub.allowance_readings r JOIN personal_hub.companion_bindings b ON b.id = r.binding_id AND b.enabled
    JOIN personal_hub.companion_installs i ON i.id = b.install_id AND NOT i.disabled
   WHERE r.kind = 'percent_used' AND r.resets_at IS NOT NULL AND r.window_minutes IS NOT NULL;

-- Ledger 4: money. Append-only; estimates and provider charges are different entry kinds.
CREATE TABLE personal_hub.money_entries (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('estimate','included_usage','metered_charge','credit_grant','credit_consumption','adjustment','invoice_line')),
  amount numeric(18,6) NOT NULL, unit text NOT NULL CHECK (unit IN ('USD','credits')), source_unit text,
  price_basis text NOT NULL, period_start timestamptz, period_end timestamptz,
  reference_kind text NOT NULL CHECK (reference_kind IN ('activity_request','usage_bucket','provider_event','none')), reference_key text,
  sku text, model text, basis text NOT NULL,
  observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL
);
CREATE UNIQUE INDEX money_entry_revision ON personal_hub.money_entries
  (account_id, entry_kind, reference_kind, coalesce(reference_key, ''), content_hash);
CREATE INDEX money_period ON personal_hub.money_entries (account_id, period_start DESC, entry_kind);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['collection_settings','companion_installs','companion_pairing_codes','companion_bindings','companion_runs',
                           'activity_requests','account_usage_buckets','allowance_readings','money_entries'] LOOP
    EXECUTE format('ALTER TABLE personal_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON personal_hub.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON personal_hub.%I TO personal_hub_app', t);
    EXECUTE format('CREATE POLICY app_read ON personal_hub.%I FOR SELECT TO personal_hub_app USING (true)', t);
    EXECUTE format('CREATE POLICY app_insert ON personal_hub.%I FOR INSERT TO personal_hub_app WITH CHECK (true)', t);
  END LOOP;
  -- The four settings tables plus companion_runs, whose counts accumulate across the envelopes of one run.
  FOREACH t IN ARRAY ARRAY['collection_settings','companion_installs','companion_bindings','companion_pairing_codes','companion_runs'] LOOP
    EXECUTE format('GRANT UPDATE ON personal_hub.%I TO personal_hub_app', t);
    EXECUTE format('CREATE POLICY app_update ON personal_hub.%I FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
REVOKE ALL ON personal_hub.allowance_percent_view FROM PUBLIC, anon, authenticated;
GRANT SELECT ON personal_hub.allowance_percent_view TO personal_hub_app;
INSERT INTO personal_hub.collection_settings (id, settings) VALUES (1, '{}'::jsonb);   -- defaults applied in code
