-- One row per (account_id, invocation_key): the canonical tool invocation and its latest result, each
-- decided at write time in the recency order lib/usage-canonical.ts defines, which is exactly the
-- order lib/usage-query.ts used to apply on every read.
--
-- THIS IS A PROJECTION, NOT A LEDGER. Every column is derived from personal_hub.tool_events and
-- personal_hub.companion_bindings, and the table can be rebuilt from them by re-running the backfill in
-- 20260922150000. That licenses GRANT UPDATE on it, exactly as for canonical_requests
-- (20260922110000). The seven ledgers keep no UPDATE and no DELETE, and this table gets no DELETE.
--
-- WHY IT EXISTS. After canonical_requests took the request side of the tools card from 31-50 s to
-- 3-6 s, measured on production 2026-09-22, the card still took 56-72 s for a month, 34-46 s of it in
-- one statement: an index lookup into tool_events per invocation, 64,745 of them, to find each one's
-- latest result. This table carries that result, so the card reads one row per invocation instead.
--
-- TWO REGISTERS, NOT ONE WINNER. The invocation (inv_*) and the latest result (res_*) arrive
-- independently: a result can land in a later envelope than its invocation, or an earlier one, and
-- either can be replayed. Each register has its own upsert with its own strict guard and writes only
-- its own columns, so each converges on its own and neither can overwrite the other. A row can
-- therefore hold a result whose invocation has not arrived yet; the read requires inv_revision_id.
--
-- EVERYTHING BUT THE KEY IS NULLABLE, because a register can be empty. That also means no statement
-- the ingest path runs against this table can be refused for a NULL, so a derived table can never
-- veto a ledger append.
CREATE TABLE personal_hub.canonical_tool_invocations (
  account_id     text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  invocation_key text NOT NULL,

  -- The invocation register: its winner, then what the tools card reads off it. source_id is
  -- denormalised from companion_bindings so the machine filter needs no join.
  inv_revision_id    uuid,
  inv_observed_at    timestamptz,
  inv_received_at    timestamptz,
  source_id          uuid REFERENCES personal_hub.telemetry_sources(id),
  tool_name          text,
  tool_namespace     text,
  tool_class         text,
  outcome            text,
  caller_request_key text,
  caller_agent_key   text,
  session_hash       text,

  -- The result register: its winner, then the outcome it reports. The read's final outcome is
  -- coalesce(res_outcome, outcome), exactly as it was.
  res_revision_id uuid,
  res_observed_at timestamptz,
  res_received_at timestamptz,
  res_outcome     text,

  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT canonical_tool_invocations_pkey PRIMARY KEY (account_id, invocation_key),
  CONSTRAINT canonical_tool_invocations_invocation_key_sha256_check CHECK (invocation_key ~ '^[a-f0-9]{64}$')
);

-- The read index. inv_observed_at is the SECOND column, so both range bounds are index boundary
-- conditions and a one-day read touches a day. The primary key serves the upserts' conflict target.
CREATE INDEX canonical_tool_invocations_activity
  ON personal_hub.canonical_tool_invocations (account_id, inv_observed_at DESC);

ALTER TABLE personal_hub.canonical_tool_invocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON personal_hub.canonical_tool_invocations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON personal_hub.canonical_tool_invocations TO personal_hub_app;
-- Column scoped, with the two key columns withheld: the app recomputes a register, it can never
-- re-key a row, and it can never delete one.
GRANT UPDATE (
  inv_revision_id, inv_observed_at, inv_received_at, source_id, tool_name, tool_namespace, tool_class,
  outcome, caller_request_key, caller_agent_key, session_hash,
  res_revision_id, res_observed_at, res_received_at, res_outcome, updated_at
) ON personal_hub.canonical_tool_invocations TO personal_hub_app;
CREATE POLICY app_read   ON personal_hub.canonical_tool_invocations FOR SELECT TO personal_hub_app USING (true);
CREATE POLICY app_insert ON personal_hub.canonical_tool_invocations FOR INSERT TO personal_hub_app WITH CHECK (true);
CREATE POLICY app_update ON personal_hub.canonical_tool_invocations FOR UPDATE TO personal_hub_app USING (true) WITH CHECK (true);
-- No DELETE grant and no DELETE policy.
