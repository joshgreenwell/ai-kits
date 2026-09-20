-- agent_events_semantic_time (20260918090000_usage_query_read_indexes.sql) repeated
-- agent_events_canonical (20260913230451_extend_usage_detail_contract.sql) column for
-- column: (account_id, semantic_key, observed_at DESC). Two identical B-trees double the
-- write and vacuum cost of the ledger and give the planner nothing the first cannot.
DROP INDEX IF EXISTS personal_hub.agent_events_semantic_time;

-- The other three indexes from 20260918090000 stay. Each shares its leading columns with
-- an older index but serves a different predicate, so none is a duplicate:
--   activity_requests_semantic_activity (account_id, semantic_key, activity_at)
--     overlaps activity_requests_canonical (account_id, semantic_key, observed_at DESC);
--   tool_events_kind_invocation (account_id, event_kind, invocation_key, observed_at DESC)
--     overlaps tool_events_invocation_join (account_id, invocation_key, observed_at DESC);
--   tool_events_kind_time (account_id, event_kind, observed_at DESC)
--     overlaps tool_events_time (account_id, observed_at DESC, event_kind).
-- tests/usage-store.integration.test.ts asserts that no two indexes on one personal_hub
-- table share an identical definition.
