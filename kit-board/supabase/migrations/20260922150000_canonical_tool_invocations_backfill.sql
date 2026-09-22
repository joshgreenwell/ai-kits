-- Backfill personal_hub.canonical_tool_invocations from the tool ledger.
--
-- Order of operations. supabase db push applies this together with the table migration, before the code
-- that maintains and reads the table is deployed, because code that writes a missing table would refuse
-- every envelope. Invocations ingested by the old code between this backfill and that deploy are
-- therefore missing until one guarded recompute runs after the deploy; it is idempotent, so running it
-- is always safe. canonical_requests was brought up the same way on 2026-09-22.
--
-- Generated from lib/usage-canonical.ts by scripts/generate-canonical-backfill.mjs; never hand-edit it.
-- tests/usage-store.integration.test.ts asserts it ranks by the recency order that module exports.
--
-- One statement, the same one the ingest path runs, with each register behind its own guard, so an hourly
-- upload landing while this runs cannot have a newer register overwritten by this statement's older
-- snapshot. On an empty table every row is inserted.
SET statement_timeout = '30min';
SET lock_timeout = '30s';

WITH inv AS (
    SELECT t.account_id, t.invocation_key, t.id AS inv_revision_id, t.observed_at AS inv_observed_at, t.received_at AS inv_received_at,
      b.source_id, t.tool_name, t.tool_namespace, t.tool_class, t.outcome, t.caller_request_key, t.caller_agent_key, t.session_hash,
      row_number() OVER (PARTITION BY t.account_id, t.invocation_key ORDER BY t.observed_at DESC, t.received_at DESC, t.id DESC) AS rank
    FROM personal_hub.tool_events t
    
    JOIN personal_hub.companion_bindings b ON b.id = t.binding_id
    WHERE t.event_kind = 'invocation'
  ), res AS (
    SELECT t.account_id, t.invocation_key, t.id AS res_revision_id, t.observed_at AS res_observed_at, t.received_at AS res_received_at,
      t.outcome AS res_outcome,
      row_number() OVER (PARTITION BY t.account_id, t.invocation_key ORDER BY t.observed_at DESC, t.received_at DESC, t.id DESC) AS rank
    FROM personal_hub.tool_events t
    
    WHERE t.event_kind = 'result'
  ), merged AS (
    SELECT coalesce(i.account_id, r.account_id) AS account_id, coalesce(i.invocation_key, r.invocation_key) AS invocation_key,
      i.inv_revision_id, i.inv_observed_at, i.inv_received_at, i.source_id, i.tool_name, i.tool_namespace, i.tool_class, i.outcome, i.caller_request_key, i.caller_agent_key, i.session_hash,
      r.res_revision_id, r.res_observed_at, r.res_received_at, r.res_outcome
    FROM (SELECT * FROM inv WHERE rank = 1) i
    FULL OUTER JOIN (SELECT * FROM res WHERE rank = 1) r ON r.account_id = i.account_id AND r.invocation_key = i.invocation_key
  )
  INSERT INTO personal_hub.canonical_tool_invocations AS c (account_id, invocation_key, inv_revision_id, inv_observed_at, inv_received_at, source_id, tool_name, tool_namespace, tool_class, outcome, caller_request_key, caller_agent_key, session_hash, res_revision_id, res_observed_at, res_received_at, res_outcome, updated_at)
  SELECT account_id, invocation_key, inv_revision_id, inv_observed_at, inv_received_at, source_id, tool_name, tool_namespace, tool_class, outcome, caller_request_key, caller_agent_key, session_hash, res_revision_id, res_observed_at, res_received_at, res_outcome, now()
  FROM merged
  ORDER BY account_id, invocation_key
  ON CONFLICT (account_id, invocation_key) DO UPDATE SET
    inv_revision_id = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.inv_revision_id ELSE c.inv_revision_id END,
    inv_observed_at = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.inv_observed_at ELSE c.inv_observed_at END,
    inv_received_at = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.inv_received_at ELSE c.inv_received_at END,
    source_id = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.source_id ELSE c.source_id END,
    tool_name = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.tool_name ELSE c.tool_name END,
    tool_namespace = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.tool_namespace ELSE c.tool_namespace END,
    tool_class = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.tool_class ELSE c.tool_class END,
    outcome = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.outcome ELSE c.outcome END,
    caller_request_key = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.caller_request_key ELSE c.caller_request_key END,
    caller_agent_key = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.caller_agent_key ELSE c.caller_agent_key END,
    session_hash = CASE WHEN coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.session_hash ELSE c.session_hash END,
    res_revision_id = CASE WHEN coalesce((EXCLUDED.res_observed_at, EXCLUDED.res_received_at, EXCLUDED.res_revision_id)
      > (coalesce(c.res_observed_at, '-infinity'::timestamptz), coalesce(c.res_received_at, '-infinity'::timestamptz), coalesce(c.res_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.res_revision_id ELSE c.res_revision_id END,
    res_observed_at = CASE WHEN coalesce((EXCLUDED.res_observed_at, EXCLUDED.res_received_at, EXCLUDED.res_revision_id)
      > (coalesce(c.res_observed_at, '-infinity'::timestamptz), coalesce(c.res_received_at, '-infinity'::timestamptz), coalesce(c.res_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.res_observed_at ELSE c.res_observed_at END,
    res_received_at = CASE WHEN coalesce((EXCLUDED.res_observed_at, EXCLUDED.res_received_at, EXCLUDED.res_revision_id)
      > (coalesce(c.res_observed_at, '-infinity'::timestamptz), coalesce(c.res_received_at, '-infinity'::timestamptz), coalesce(c.res_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.res_received_at ELSE c.res_received_at END,
    res_outcome = CASE WHEN coalesce((EXCLUDED.res_observed_at, EXCLUDED.res_received_at, EXCLUDED.res_revision_id)
      > (coalesce(c.res_observed_at, '-infinity'::timestamptz), coalesce(c.res_received_at, '-infinity'::timestamptz), coalesce(c.res_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) THEN EXCLUDED.res_outcome ELSE c.res_outcome END,
    updated_at = now()
  WHERE coalesce((EXCLUDED.inv_observed_at, EXCLUDED.inv_received_at, EXCLUDED.inv_revision_id)
      > (coalesce(c.inv_observed_at, '-infinity'::timestamptz), coalesce(c.inv_received_at, '-infinity'::timestamptz), coalesce(c.inv_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false) OR coalesce((EXCLUDED.res_observed_at, EXCLUDED.res_received_at, EXCLUDED.res_revision_id)
      > (coalesce(c.res_observed_at, '-infinity'::timestamptz), coalesce(c.res_received_at, '-infinity'::timestamptz), coalesce(c.res_revision_id, '00000000-0000-0000-0000-000000000000'::uuid)), false);

ANALYZE personal_hub.canonical_tool_invocations;

RESET lock_timeout;
RESET statement_timeout;
