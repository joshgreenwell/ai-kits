-- Tokens reads rank only keys that appear in the selected range, then look up
-- those keys' revisions. These indexes make that two-step plan an index range
-- scan instead of a window over the whole ledger.
CREATE INDEX IF NOT EXISTS activity_requests_semantic_activity
  ON personal_hub.activity_requests (account_id, semantic_key, activity_at);
CREATE INDEX IF NOT EXISTS tool_events_kind_time
  ON personal_hub.tool_events (account_id, event_kind, observed_at DESC);
CREATE INDEX IF NOT EXISTS tool_events_kind_invocation
  ON personal_hub.tool_events (account_id, event_kind, invocation_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS agent_events_semantic_time
  ON personal_hub.agent_events (account_id, semantic_key, observed_at DESC);
