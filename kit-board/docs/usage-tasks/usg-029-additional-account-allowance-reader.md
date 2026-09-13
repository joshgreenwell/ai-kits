# USG-029: Implement the Claude account allowance reader

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Provide a verified account-level allowance reader alongside statusline and browser observations.

## Current gap

The selectable account/OAuth reader is a stub, so enabling its setting does not supply readings.

## Acceptance criteria

1. Validate current source availability, supported authorization/usage boundaries, account identity fields, and response fixtures before selecting an implementation path.
2. Collect supported pooled/model-specific windows with original observation/reset data, stable scope, and account binding; handle absent windows explicitly.
3. Handle expiry, identity change, unavailable permissions, throttling, and unrecognized schemas with truthful coverage and no cross-account fallback.
4. Define reader precedence with statusline/browser evidence and preserve historical observations without duplicate contributions.
5. Document and verify the supported setup with an actual account reading and UI result; unsupported source access remains an explicit blocker, not an assumed implementation.

## Verification

Use multiple-account, expired/unavailable-access, missing-window, stale-result, and duplicate-reader cases plus a real supported collection receipt.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/stubs.rs](<../../companion/crates/observatory-adapters/src/stubs.rs>)
- [companion/crates/observatory-core/src/credentials.rs](<../../companion/crates/observatory-core/src/credentials.rs>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [docs/usage-system.md](<../../docs/usage-system.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
