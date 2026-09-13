# USG-011: Reconcile historical usage and preserve history when sources are disabled

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
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

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
