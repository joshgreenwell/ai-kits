# USG-006: Collect tool invocations, callers, and outcomes without duplicate counting

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Apply the common completion requirements in the [backlog index](README.md). Completion evidence is recorded below.

## Starting points

- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)
- [companion/crates/observatory-adapters/src/requests.rs](<../../companion/crates/observatory-adapters/src/requests.rs>)
- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [tests/fixtures/usage-v2](<../../tests/fixtures/usage-v2>)

## Execution record

Completed on `kit-board/usg-006-tool-invocations` with a clean independent high-effort review.

- Added schema-v5 local tool evidence with one stable invocation row per provider call identity, a separately keyed result row, conservative outcome enrichment, caller/session/agent joins, subagent filtering, and persistent unmapped/truncated coverage flags.
- Claude now reads `tool_use` and `tool_result` blocks, including tool-only assistant records. Codex now reads function, custom-tool, MCP, web-search, local-shell, and output forms; pending calls join to the following supported `token_count`, while calls without one keep a null caller.
- Built-in tools retain allowlisted names. MCP, function, and custom names/namespaces remain absent at `builtin_only` and use `h:<16 hex>` identities at `hashed_custom`; `off` retains totals with no names. Arguments and results are inspected in memory only and never stored or emitted.
- Request records expose exact invocation totals and at most 50 grouped names only at `requests_with_tools`. Offline pending records are rebuilt under current detail, name, project, and subagent settings before upload.
- Added declared synthetic fixtures and focused tests for multiple calls, tool-only turns, duplicate calls/results, wrappers, explicit success/failure/denial, opaque outcomes, missing outputs, caller joins, replay, policy changes, child-agent filtering, unknown forms, overlong names, and local-content non-retention. V1 bucket parity remains unchanged.
- Review regressions cover queued requests after a detail downgrade, orphan child results, explicit success text containing denial phrases, and copied Codex fork history in both parent-first and child-first scan order. The final review reported no remaining correctness, privacy, replay, or acceptance-criteria findings.
- Verification: `cargo test --workspace`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo deny check`, `python scripts/fixtures.py check`, `npm test` (75 passed, four configured database skips), `npm run typecheck`, `npm run build`, and `git diff --check` passed on September 13, 2026.
- Scope boundary: opaque result payloads remain `unknown`, and calls without a supported caller accounting event retain a null caller. Resource-path classification and per-result token allocation remain assigned to later stories. No production collection run or deployment was performed for this local implementation.
