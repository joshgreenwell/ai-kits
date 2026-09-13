# USG-028: Implement the Codex account allowance reader

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Refresh account windows through a verified supported account interface, reducing dependence on new rollout events.

## Current gap

The account adapter and selectable app-server/web-backend reader paths are unimplemented.

## Acceptance criteria

1. Inspect current installed interface/documentation and source fixtures to select a supported account reader; document eligibility and prerequisites.
2. Implement account identity verification, relevant allowance windows/reset anchors, source observation timestamps, timeouts, and bounded retry behavior.
3. Define precedence/deduplication against embedded and browser readings without adding overlapping meters or manufacturing sample times.
4. Respect existing authentication ownership and local secret handling; expose unavailable/expired/unrecognized states rather than falling back silently to a different account.
5. Enable the matching settings option only after a real account reading is stored and displayed; preserve unsupported alternatives as unavailable.

## Verification

Test multiple limit IDs including Spark, changed sign-in, stale/failed responses, equivalent embedded readings, and a real supported account refresh.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/stubs.rs](<../../companion/crates/observatory-adapters/src/stubs.rs>)
- [companion/crates/observatory-adapters/src/readings.rs](<../../companion/crates/observatory-adapters/src/readings.rs>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [lib/telemetry-contract.ts](<../../lib/telemetry-contract.ts>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
