// Regenerates the two projection backfills from lib/usage-canonical.ts, so neither backfill's revision
// order can drift from the application's:
//   supabase/migrations/20260922120000_canonical_requests_backfill.sql
//   supabase/migrations/20260922150000_canonical_tool_invocations_backfill.sql
//
// The migration is checked in and must not be hand-edited. Run this only if lib/usage-canonical.ts
// changes AND the projection has not yet been built in production; once it has, a changed rank order
// is a data change, not a regeneration, and needs its own migration that rebuilds the table.
//
//   node --import tsx scripts/generate-canonical-backfill.mjs
import { writeFileSync } from 'node:fs';
import { canonicalRequestsUpsert, canonicalToolUpsert } from '../lib/usage-canonical.ts';

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

writeFileSync(TARGET, header + canonicalRequestsUpsert('').trim() + footer, 'utf8');
console.log(`Wrote ${TARGET}`);

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
writeFileSync(TOOL_TARGET, toolHeader + canonicalToolUpsert('').trim() + `;

ANALYZE personal_hub.canonical_tool_invocations;

RESET lock_timeout;
RESET statement_timeout;
`, 'utf8');
console.log(`Wrote ${TOOL_TARGET}`);
