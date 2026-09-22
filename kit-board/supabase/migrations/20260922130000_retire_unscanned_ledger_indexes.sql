-- Retire four ledger indexes that nothing has ever scanned.
--
-- Measured on production 2026-09-22 from pg_stat_user_indexes, whose statistics were last reset on
-- 2026-08-25, so this is a month of real reads, during which sibling indexes on the same two tables
-- recorded 1,570,061 and 11,444,769 scans:
--
--   tool_events_caller_agent_join          25 MB   0 scans
--   tool_events_caller_request_join        25 MB   0 scans
--   tool_events_parent_invocation_join   8192 B    0 scans
--   activity_requests_parent_agent_join   2.2 MB   0 scans
--
-- They are also unreachable by code: nothing in lib/ filters a ledger on caller_agent_key,
-- caller_request_key, parent_invocation_key or parent_agent_key. The reads filter those columns on
-- the canonical projections and on temp tables, never on tool_events or activity_requests.
--
-- WHY NOW. The tool projection created next adds storage to a database already over its 477 MiB
-- free-tier quota. These 52 MB offset most of it. Every index also costs a write on every ledger
-- insert, so the hourly upload gets cheaper too.
--
-- Dropping an index unlinks its files, so the space returns immediately and nothing is rewritten. Each
-- DROP takes ACCESS EXCLUSIVE for the catalog edit only; lock_timeout keeps it from queueing behind an
-- hourly upload, and if it trips the whole file rolls back and can be rerun.
--
-- UNDO, if a read ever needs one back (each is its original definition from 20260913230451):
--   CREATE INDEX tool_events_caller_request_join ON personal_hub.tool_events
--     (account_id, caller_request_key, observed_at DESC) WHERE caller_request_key IS NOT NULL;
--   CREATE INDEX tool_events_caller_agent_join ON personal_hub.tool_events
--     (account_id, caller_agent_key, observed_at DESC) WHERE caller_agent_key IS NOT NULL;
--   CREATE INDEX tool_events_parent_invocation_join ON personal_hub.tool_events
--     (account_id, parent_invocation_key, observed_at DESC) WHERE parent_invocation_key IS NOT NULL;
--   CREATE INDEX activity_requests_parent_agent_join ON personal_hub.activity_requests
--     (account_id, parent_agent_key, activity_at DESC) WHERE parent_agent_key IS NOT NULL;
SET lock_timeout = '5s';
SET statement_timeout = '5min';

DROP INDEX IF EXISTS personal_hub.tool_events_caller_agent_join;
DROP INDEX IF EXISTS personal_hub.tool_events_caller_request_join;
DROP INDEX IF EXISTS personal_hub.tool_events_parent_invocation_join;
DROP INDEX IF EXISTS personal_hub.activity_requests_parent_agent_join;

RESET lock_timeout;
RESET statement_timeout;
