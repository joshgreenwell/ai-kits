# USG-005: Collect distinct subagents, parent relationships, roles, and token attribution

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md)
Created: 2026-09-13

## Outcome

Explain how much work subagents perform and who their recorded parent is.

## Current gap

Current local buckets fold subagent usage into parent sessions, and the request parent field does not provide complete independent agent identity.

## Acceptance criteria

1. Parse independent child and parent identities from supported transcript/spawn metadata, including inline sidechains, child files, nested delegations, and resumed agents.
2. Record built-in/custom/unknown role, actual model, available requested model, and depth; honor custom-name privacy settings.
3. Distinguish attempted spawns from observed children and count a resumed child once. Token attribution remains a subset of the overall total.
4. Keep unknown agent attribution explicit and preserve known parent relationships even when parent or child transcripts are missing.
5. Never infer whether the user or model initiated delegation from the role or tool name; populate that distinction only from explicit source evidence.

## Verification

Reconcile parent/child totals with and without subagent collection, and test nested, custom-role, missing-parent, duplicate-notification, and resumed-child fixtures.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)
- [companion/crates/observatory-adapters/src/requests.rs](<../../companion/crates/observatory-adapters/src/requests.rs>)
- [tests/fixtures/usage-v2/parity](<../../tests/fixtures/usage-v2/parity>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
