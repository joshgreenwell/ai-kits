CREATE TABLE personal_hub.agent_routing_events (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES personal_hub.telemetry_sources(id),
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  provider text NOT NULL CHECK (provider IN ('codex', 'claude')),
  event_id uuid NOT NULL,
  task_id uuid NOT NULL,
  attempt_id uuid,
  sequence bigint NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL CHECK (event_type IN ('task.registered', 'route.decided', 'attempt.started', 'attempt.finished', 'outcome.recorded')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  content_hash text NOT NULL,
  UNIQUE (source_id, event_id),
  UNIQUE (source_id, task_id, sequence)
);
CREATE INDEX agent_routing_events_task_history ON personal_hub.agent_routing_events (source_id, task_id, sequence, received_at);
CREATE INDEX agent_routing_events_account_time ON personal_hub.agent_routing_events (account_id, occurred_at DESC);
ALTER TABLE personal_hub.agent_routing_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.agent_routing_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON personal_hub.agent_routing_events TO personal_hub_app;
CREATE POLICY app_read ON personal_hub.agent_routing_events FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_append ON personal_hub.agent_routing_events FOR INSERT TO personal_hub_app WITH CHECK (true);
