CREATE TABLE personal_hub.usage_accounts (
  id text PRIMARY KEY, provider text NOT NULL CHECK(provider IN ('codex','claude')),
  label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE personal_hub.telemetry_sources (
  id uuid PRIMARY KEY, account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  machine_label text NOT NULL, mode text NOT NULL CHECK(mode IN ('local','browser')),
  key_hash text NOT NULL UNIQUE, disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, coverage jsonb
);
CREATE TABLE personal_hub.token_bucket_revisions (
  id uuid PRIMARY KEY, account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  source_id uuid NOT NULL REFERENCES personal_hub.telemetry_sources(id), session_hash text NOT NULL,
  hour timestamptz NOT NULL, model text NOT NULL, observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL,
  input_tokens bigint NOT NULL CHECK(input_tokens >= 0), cached_tokens bigint NOT NULL CHECK(cached_tokens >= 0),
  cache_write_tokens bigint NOT NULL CHECK(cache_write_tokens >= 0), output_tokens bigint NOT NULL CHECK(output_tokens >= 0),
  total_tokens bigint NOT NULL CHECK(total_tokens = input_tokens + cached_tokens + cache_write_tokens + output_tokens),
  calls bigint NOT NULL CHECK(calls >= 0),
  UNIQUE(account_id, session_hash, hour, model, content_hash)
);
CREATE INDEX token_bucket_current ON personal_hub.token_bucket_revisions(account_id, hour DESC, session_hash, model, observed_at DESC);
CREATE TABLE personal_hub.quota_samples (
  id uuid PRIMARY KEY, account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  source_id uuid NOT NULL REFERENCES personal_hub.telemetry_sources(id), content_hash text NOT NULL,
  window_key text NOT NULL, label text NOT NULL, observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), used_percent double precision NOT NULL CHECK(used_percent BETWEEN 0 AND 100),
  resets_at timestamptz NOT NULL, window_minutes integer NOT NULL CHECK(window_minutes > 0),
  UNIQUE(account_id, content_hash)
);
CREATE INDEX quota_sample_history ON personal_hub.quota_samples(account_id, window_key, observed_at DESC);
CREATE TABLE personal_hub.reset_feed_state (
  source text PRIMARY KEY, checked_at timestamptz, succeeded_at timestamptz,
  next_check_at timestamptz, error text, etag text, last_modified text, current_hash text
);
CREATE TABLE personal_hub.reset_feed_revisions (
  source text NOT NULL REFERENCES personal_hub.reset_feed_state(source), content_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), payload jsonb NOT NULL,
  PRIMARY KEY(source, content_hash)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['usage_accounts','telemetry_sources','token_bucket_revisions','quota_samples','reset_feed_state','reset_feed_revisions'] LOOP
    EXECUTE format('ALTER TABLE personal_hub.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON personal_hub.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT ON personal_hub.%I TO personal_hub_app', t);
    EXECUTE format('CREATE POLICY app_read ON personal_hub.%I FOR SELECT TO personal_hub_app USING (true)', t);
    EXECUTE format('CREATE POLICY app_insert ON personal_hub.%I FOR INSERT TO personal_hub_app WITH CHECK (true)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['telemetry_sources','reset_feed_state'] LOOP
    EXECUTE format('GRANT UPDATE ON personal_hub.%I TO personal_hub_app', t);
    EXECUTE format('CREATE POLICY app_update ON personal_hub.%I FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
