# USG-004: Collect request detail and pricing evidence from supported local histories

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md)
Created: 2026-09-13

## Outcome

Make routine Claude Code and Codex collection retain the facts needed for token and cost views.

## Current gap

Production is bucket-only; normal request collection does not yet replace the richer monthly pricing dimensions.

## Acceptance criteria

1. Collect stable request/session identity, original activity time, account/source/surface, actual model, exclusive token categories, and trustworthy model-call counts.
2. Extract recorded effort, requested model where available, service tier, context-size and cache-pricing evidence; leave unsupported dimensions unknown and document provider-specific mappings.
3. Preserve transcript rotation, archives, mirrored copies, cumulative-counter deltas, partial records, and parser-version changes without changing logical usage or counting subagents twice.
4. Provide checkpoint-aware reprocessing/backfill for newly added fields using retained source evidence. Do not assume emitting existing bucket-only state reconstructs fields it never saved.
5. Expose progress, eligible history, missing source periods, malformed records, and detail-level gating. Keep the existing hourly history representation compatible.

## Verification

Use representative sanitized local fixtures for both providers, replay twice, compare request-derived totals with canonical hourly totals, and verify effort/tier/context cases and missing fields.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)
- [companion/crates/observatory-adapters/src/requests.rs](<../../companion/crates/observatory-adapters/src/requests.rs>)
- [companion/crates/observatory-adapters/src/claude_execution.rs](<../../companion/crates/observatory-adapters/src/claude_execution.rs>)
- [companion/crates/observatory-adapters/src/codex_execution.rs](<../../companion/crates/observatory-adapters/src/codex_execution.rs>)
- [companion/crates/observatory-core/src/state.rs](<../../companion/crates/observatory-core/src/state.rs>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
