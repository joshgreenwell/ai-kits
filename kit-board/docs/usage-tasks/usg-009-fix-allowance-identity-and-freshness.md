# USG-009: Fix account attribution and freshness for existing allowance collection

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 2. Collection
Dependencies: [USG-001](usg-001-metric-and-source-contract.md)
Created: 2026-09-13

## Outcome

Give each account a correctly attributed, timestamped set of current allowance windows.

## Current gap

Existing statusline/embedded/browser evidence has freshness gaps, and machine-wide hooks can assign a reading to the first binding rather than the verified account.

## Acceptance criteria

1. Recheck existing statusline, embedded rollout, and current browser reader paths; distinguish hook installation, successful execution, collected readings, and accepted uploads.
2. Bind each reading to verified provider identity/account where available. Quarantine ambiguous or changed identities rather than assigning them to the first account.
3. Preserve provider meter keys, labels, durations, units, reset anchors, and scope, including Spark and model-specific windows; select the newest relevant supported reading.
4. Show stale/missing readings honestly and preserve gap/reset/decrease handling in forecasts. A coverage-only receipt does not refresh the account meter.
5. Document attainable refresh behavior for each reader, prevent unrelated readers/settings from claiming coverage, and retain existing account data while identity is reconfirmed.

## Verification

Use two-account switching, ambiguous identity, stale/no-data runs, reset transitions, overlapping windows, Spark, and repeated-reading cases; obtain fresh readings on accessible active bindings.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory/src/commands/statusline.rs](<../../companion/crates/observatory/src/commands/statusline.rs>)
- [companion/crates/observatory-adapters/src/readings.rs](<../../companion/crates/observatory-adapters/src/readings.rs>)
- [companion/crates/observatory-core/src/inbox.rs](<../../companion/crates/observatory-core/src/inbox.rs>)
- [lib/telemetry-contract.ts](<../../lib/telemetry-contract.ts>)
- [lib/telemetry-store.ts](<../../lib/telemetry-store.ts>)
- [docs/usage-system.md](<../../docs/usage-system.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
