// Generates the projection migrations from lib/usage-canonical.ts, so no backfill's order or column list
// can drift from the application's.
//
// FROZEN, never rewritten: 20260922120000_canonical_requests_backfill.sql and
// 20260922150000_canonical_tool_invocations_backfill.sql are applied in production. Their text is what
// ran; regenerating them after lib/usage-canonical.ts gained a column would describe a migration that
// never happened. Pass --frozen to print what they would be today, for comparison only.
//
// WRITTEN: 20260923090200_tool_invocation_parent.sql, the migration that adds parent_invocation_key to
// canonical_tool_invocations, grants the application role UPDATE on it, and fills it for existing rows
// with toolColumnBackfill() (the same statement is the post-deploy recompute step; see the migration).
//
// A column added to the projection later gets its own new migration here, never an edit of an applied one.
//
//   node --import tsx scripts/generate-canonical-backfill.mjs
import { writeFileSync } from 'node:fs';
import { ADDED_TOOL_INVOCATION_COLUMNS, canonicalRequestsUpsert, canonicalToolUpsert, toolColumnBackfill } from '../lib/usage-canonical.ts';

const frozen = process.argv.includes('--frozen');
const write = (target, text) => {
  if (frozen) { process.stdout.write(`-- ${target}\n${text}\n`); return; }
  writeFileSync(target, text, 'utf8');
  console.log(`Wrote ${target}`);
};

const TARGET = 'supabase/migrations/20260922120000_canonical_requests_backfill.sql';

const header = `-- Backfill personal_hub.canonical_requests from the request ledger.
--
-- Deployed AFTER write-time maintenance is live, which is the ordering that removes any need for a
-- completeness gate: maintenance covers every key that lands from its deploy onward, and this one
-- statement covers everything before it. There is no moment at which a deployed reader can see a
-- partially built projection, because the read cutover ships after this has run.
--
-- The recompute below is generated from lib/usage-canonical.ts by scripts/generate-canonical-backfill.mjs
-- and must never be hand-edited. tests/usage-store.integration.test.ts asserts this file contains the
-- rank expressions that module exports, so a drift between the backfill's order and the application's
-- order fails in CI rather than silently serving a different revision.
--
-- It carries the SAME guard the ingest upsert uses, so an hourly upload landing while this runs
-- cannot have its newer winner overwritten by this statement's older snapshot. On an empty table the
-- guard never fires and every key is inserted.
--
-- REBUILD AFTER A LEDGER DELETE. Any migration that deletes ledger rows must re-run this recompute
-- with the guard replaced by an unconditional DO UPDATE, because a deleted winner must be allowed to
-- be replaced by a lower-ranked survivor, which the guard would refuse.
SET statement_timeout = '30min';
SET lock_timeout = '30s';

`;

const footer = `;

ANALYZE personal_hub.canonical_requests;

RESET lock_timeout;
RESET statement_timeout;
`;

if (frozen) write(TARGET, header + canonicalRequestsUpsert('').trim() + footer);

const TOOL_TARGET = 'supabase/migrations/20260922150000_canonical_tool_invocations_backfill.sql';
const toolHeader = `-- Backfill personal_hub.canonical_tool_invocations from the tool ledger.
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

`;
if (frozen) write(TOOL_TARGET, toolHeader + canonicalToolUpsert('').trim() + `;

ANALYZE personal_hub.canonical_tool_invocations;

RESET lock_timeout;
RESET statement_timeout;
`);

const PARENT_TARGET = 'supabase/migrations/20260923090200_tool_invocation_parent.sql';
const parentHeader = `-- The Codex exec a nested MCP call ran under (companion 2.2.0 emits those calls as tool.event rows whose
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
-- pre-deploy code upserted between \`supabase db push\` and the deploy did not carry the column. It is
-- idempotent (it writes only a differing row) and is exported as refreshAddedToolColumns().
SET statement_timeout = '30min';
SET lock_timeout = '30s';

`;
const columns = ADDED_TOOL_INVOCATION_COLUMNS.map(column => `ALTER TABLE personal_hub.canonical_tool_invocations
  ADD COLUMN ${column} text
  CHECK (${column} IS NULL OR ${column} ~ '^[a-f0-9]{64}$');
GRANT UPDATE (${column}) ON personal_hub.canonical_tool_invocations TO personal_hub_app;`).join('\n');
write(PARENT_TARGET, parentHeader + columns + `

-- Backfill: fill the column on existing rows from the invocation revision each row already holds.
${toolColumnBackfill()};

RESET lock_timeout;
RESET statement_timeout;
`);
