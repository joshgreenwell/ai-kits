# USG-011: Reconcile historical usage and preserve history when sources are disabled

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P0
Scope: Core
Stage: 3. Read models
Dependencies: [USG-002](usg-002-preserve-history-and-recover-publication.md), [USG-003](usg-003-extend-detail-contract-and-storage.md)
Created: 2026-09-13

## Outcome

Keep old usage visible and avoid double counting when request detail and v2 allowances arrive.

## Current gap

Significant v1 hourly history has no verified equivalent, and the allowance view hides stored observations when sources are disabled.

## Acceptance criteria

1. Implement a repeatable dry-run/import or canonical-read reconciliation using explicit source mappings, original timestamps, identity, provenance, and logical deduplication.
2. Investigate and account for the audit's v1-only hourly keys and pending outboxes using current evidence; preserve coarse rows when finer supported facts are unavailable.
3. Retain full monthly envelopes and historical pricing/environmental assumptions. Do not expand monthly/daily aggregates into invented requests, tools, agents, projects, or hours.
4. Preserve historical allowances after disabling a source without reviving them as current account capacity; migrate or select old/new copies once.
5. Produce before/after comparisons by account/window/period/model and demonstrate rerun idempotency and recovery against the private restorable baseline.

## Verification

Verify canonical parity, disabled-source history, migrated duplicate selection, unknown mappings, interrupted imports, read permissions, and a second run producing no additional logical facts.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-v1-retirement.md](<../../docs/usage-v1-retirement.md>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [lib/telemetry-store.ts](<../../lib/telemetry-store.ts>)
- [supabase/migrations](<../../supabase/migrations>)
- [tests/usage-history.test.ts](<../../tests/usage-history.test.ts>)
- [tests/usage-store.integration.test.ts](<../../tests/usage-store.integration.test.ts>)

## Execution record

Completed on `main` on September 14, 2026. Evidence: [historical reconciliation evidence](../usage-evidence/usg-011-2026-09-14.md).

- Decisions: reconciliation is a canonical read, not a copy. The retired v1 ledgers (`token_bucket_revisions` rows from `local` sources, `quota_samples`) stay where they are with their source identity, observation times, and hashes; nothing is migrated into `allowance_readings`, so no binding is fabricated and no reading pretends to come from the companion. Disabling a source, binding, or install means "stop new uploads" only: `allowance_percent_view` now keeps those rows and flags them `history_only`, and one rule everywhere (`quotaOutlook`, the estimate, the current-selection query) uses them for cycle history and never as the current reading. Old and new copies of one observation (the v1 hook and the companion hook read the same inbox) are shown once, as the v2 reading, by an exact match on account, meter, observation time, value, and reset anchor, and only when that v2 copy is exposed by the view and is live or the v1 source is disabled too, so a disabled binding never demotes an enabled browser source's observation. The hourly nonregressing rule is stated once in `token_bucket_canonical` and inlined where a query must run before the migration is applied.
- Server: migration `20260914030000_reconcile_historical_ledgers.sql` (new `token_bucket_canonical` view, `allowance_percent_view` replaced with `history_only` and the once-only rule, security invoker and grants restated, no table change). `lib/telemetry-store.ts` reads `history_only` and tolerates the pre-migration view; `lib/telemetry-contract.ts` `quotaOutlook` selects the active cycle and pace from live samples only; `lib/cloud-estimate.ts` ignores history-only readings; `components/telemetry-shared.tsx` carries the flag.
- Reconciliation: `lib/usage-reconciliation.ts` returns the before/after matrix (hourly keys by account, month, and model as v1-only, v2-only, shared with equal/larger split, and the v1-only keys inside companion-observed hours; canonical calls and tokens with and without the retired rows; allowance rows per account, meter, origin, and reader with history-only counts, cross-ledger duplicates, and visibility under the old and new policy; the current selection per meter with a revived-prevented flag; retained monthly envelopes counted, never expanded) and `reconcileV1Envelope`, which classifies a retired collector's pending v1 envelope under an explicit source id (`duplicate`, `superseded`, `advancing`, `new_key`; quotas `duplicate_v1`, `duplicate_v2`, `new`), projects the canonical delta, and appends only with `apply`, in one transaction: new keys and advancing revisions only (a superseded revision adds nothing and, with a later observation time, could win the composition tie-break), keeping the envelope's own `observed_at`, never copying a quota the companion already holds, and never touching collector contact. `scripts/reconcile-usage-history.mjs` runs both from `DATABASE_URL` (`report`, `outbox <source-id> <state.sqlite3|envelope.json>... [--apply]`) and prints no credential.
- Synthetic coverage: `tests/usage-reconciliation.integration.test.ts` (matrix expectations, identical republication stored once, disabled-source history and current selection, dry run writes nothing, apply, second run adds no row and no logical fact, interrupted import leaves nothing, unknown/companion/browser source mappings refused); `tests/usage-store.integration.test.ts` (view keeps disabled rows flagged, duplicate shown once, re-enable restores current, app role reads both views); `tests/usage-history.test.ts` (history-only samples shape cycles and never the current reading).
- Production evidence, read-only through the linked project on September 14: 783 v1-only keys, 666 v2-only, 11 shared; the retired rows hold 3.95 billion of 8.87 billion canonical tokens and only 25 v1-only keys share an hour with companion rows; all 251 hidden quota samples are Codex local rows, 219 exact copies of embedded readings, 32 become history and none becomes current; both Windows outboxes (34 cumulative envelopes each) classify entirely as duplicate or superseded with no new fact, so nothing is imported and the collectors can be stopped. The audit's v1-only counts over-count because an identical republication is stored once; see the evidence.
- Verification on September 14, 2026 (Windows host, Docker Desktop): `npm run typecheck`, `npm run test:db` (13 migrations applied, all integration suites passed), `npm test` (the pre-existing `generated JSON Schema is current` assertion fails on this host only because `core.autocrlf` checks the file out with CRLF; it passes with LF line endings and is unrelated), one focused review.
- Remaining, outside this task: deploy the migration together with the server build (the deployed view would otherwise still hide history; the new code tolerates the old view until then), which USG-025 gates; the Mac host's local checkpoints and the 25 candidate keys need the transcripts, which USG-002's inaccessible-host inventory owns; restoring the private September 13 baseline was verified under USG-002 and not repeated.
