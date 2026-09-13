# USG-027: Implement Cursor usage collection from validated source evidence

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-001](usg-001-metric-and-source-contract.md), [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Replace detected-but-unimplemented Cursor setup with usable, correctly labeled usage facts.

## Current gap

Both Cursor adapters are stubs; local state detection currently produces no usage.

## Acceptance criteria

1. Validate available local and hosted source shapes with current primary documentation and sanitized fixtures; identify which facts are local counters, provider-reported usage, allowances, or actual charges.
2. Implement the supported reader paths with explicit account identity, time semantics, stable event keys, pagination/checkpoints, rate-limit handling, and idempotent replay.
3. Preserve the separation between local execution counters and billed usage. Do not infer project attribution by an unsupported timestamp match.
4. Advertise only implemented fields in settings/coverage, including units and plan scope; state unsupported tool/agent/project/cloud detail explicitly.
5. Verify a real collection receipt and the applicable Tokens/Allowances views for an accessible intended account. If source access is unavailable, record the concrete blocker and keep the task incomplete.

## Verification

Test source fixtures, duplicate/late events, account changes, expired access, pagination, unavailable dimensions, and comparison with the provider's own reported period.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/stubs.rs](<../../companion/crates/observatory-adapters/src/stubs.rs>)
- [companion/crates/observatory-core/src/discovery.rs](<../../companion/crates/observatory-core/src/discovery.rs>)
- [docs/usage-system.md](<../../docs/usage-system.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
