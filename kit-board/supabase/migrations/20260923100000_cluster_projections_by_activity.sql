-- Physically order both canonical projections by the index their range reads use.
--
-- Measured on production 2026-09-23: the Tokens agent map scanned canonical_requests_activity for a
-- month and hit 70,404 shared buffers for about 74,000 rows, one buffer per row, about 6.5 s of a 30 s
-- section budget. The aggregation after it was 1,199 groups in 793 kB of memory, so the cost was
-- entirely heap fetches. The backfills wrote each projection in primary-key order ((account_id,
-- semantic_key) and (account_id, invocation_key)), which is effectively random with respect to time,
-- so every range read on activity_at or inv_observed_at touches one heap page per row. The same holds
-- for the requests section, the tool caller build, and the tool invocation build.
--
-- CLUSTER rewrites each table in index order, so a month's rows sit on contiguous pages: roughly 13x
-- fewer buffer touches for a month, more for a day. Rows written later arrive for recent activity and
-- are appended in roughly time order, so the ordering degrades slowly; re-running this CLUSTER is
-- always safe. Postgres records each index as the table's clustering index, so a bare
-- `CLUSTER personal_hub.canonical_requests` repeats it.
--
-- CLUSTER takes ACCESS EXCLUSIVE on each projection while it rewrites it, which for these sizes is
-- seconds. An hourly upload that lands meanwhile waits on its own lock_timeout (3 s) and retries from the
-- companion's outbox on the next run; a Tokens read waiting behind it is bounded by the section
-- budget. Nothing is lost: the projections are derived tables, and no ledger is touched.
SET lock_timeout = '30s';
SET statement_timeout = '15min';

CLUSTER personal_hub.canonical_requests USING canonical_requests_activity;
CLUSTER personal_hub.canonical_tool_invocations USING canonical_tool_invocations_activity;

ANALYZE personal_hub.canonical_requests;
ANALYZE personal_hub.canonical_tool_invocations;

RESET statement_timeout;
RESET lock_timeout;
