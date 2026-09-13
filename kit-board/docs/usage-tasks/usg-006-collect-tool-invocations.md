# USG-006: Collect tool invocations, callers, and outcomes without duplicate counting

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md)
Created: 2026-09-13

## Outcome

Supply trustworthy tool-call totals and the evidence required for knowledge-source detection.

## Current gap

The companion currently discards tool blocks and emits no functioning per-tool attribution.

## Acceptance criteria

1. Parse supported built-in, MCP, function/custom-tool, and wrapper call forms from both local providers, recording invocation identity, tool name/namespace, caller, and original time.
2. Join results/outcomes when supported; preserve issued calls without results and calls on tool-only turns. Results, status messages, and retries of the same event do not become new invocations.
3. Count one headline call per stable model-issued invocation identity. Internal subprocesses or nested wrapper operations do not add calls unless the model separately issued them with their own invocation identities.
4. Classify successful, failed, denied/cancelled, and unknown results only from evidence; preserve the broader total of reported invocations.
5. Honor tool-detail/name policies and retain sensitive arguments/results only locally for classification; make unmapped forms and truncated-name coverage visible.

## Verification

Exercise several calls per turn, failed/denied calls, missing outputs, duplicate records, wrapper/nested calls, no-following-token records, and replay idempotency.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)
- [companion/crates/observatory-adapters/src/requests.rs](<../../companion/crates/observatory-adapters/src/requests.rs>)
- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [tests/fixtures/usage-v2](<../../tests/fixtures/usage-v2>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
