-- The Codex exec a nested MCP call ran under (companion 2.2.0 emits those calls as tool.event rows whose
-- parent_invocation_key names the open exec). lib/usage-query.ts nests a call under its parent only when
-- that parent is a Codex exec; every other parent link, such as a Claude parent_tool_use_id, stays a
-- top-level row. The read finds parents by primary key, so there is no partial index; production is over
-- its storage quota.
--
-- Generated from lib/usage-canonical.ts by scripts/generate-canonical-backfill.mjs; never hand-edit it.
-- 20260922140000 and its backfill 20260922150000 are applied and are NOT edited: this migration adds the
-- column instead.
--
-- The CHECK is exactly the ledger column's own (tool_events_parent_invocation_key_sha256_check), so the
-- projection is never stricter than its source and maintenance cannot refuse an envelope the ledger accepted.
--
-- Without the column-scoped UPDATE grant below, the ingest upsert (which now assigns this column) fails
-- with 42501 on every envelope carrying a tool event. tests/usage-side-records.integration.test.ts asserts
-- every TOOL_INVOCATION_COLUMNS entry is grantable.
--
-- RECOMPUTE STEP. The same backfill statement must be re-run once after the application deploy: rows the
-- pre-deploy code upserted between `supabase db push` and the deploy did not carry the column. It is
-- idempotent (it writes only a differing row) and is exported as refreshAddedToolColumns().
SET statement_timeout = '30min';
SET lock_timeout = '30s';

ALTER TABLE personal_hub.canonical_tool_invocations
  ADD COLUMN parent_invocation_key text
  CHECK (parent_invocation_key IS NULL OR parent_invocation_key ~ '^[a-f0-9]{64}$');
GRANT UPDATE (parent_invocation_key) ON personal_hub.canonical_tool_invocations TO personal_hub_app;

-- Backfill: fill the column on existing rows from the invocation revision each row already holds.
UPDATE personal_hub.canonical_tool_invocations c
   SET parent_invocation_key = t.parent_invocation_key
  FROM personal_hub.tool_events t
 WHERE t.id = c.inv_revision_id AND c.account_id = t.account_id AND c.invocation_key = t.invocation_key
   AND t.parent_invocation_key IS NOT NULL
   AND c.parent_invocation_key IS DISTINCT FROM t.parent_invocation_key;

RESET lock_timeout;
RESET statement_timeout;
