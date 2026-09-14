# USG-005: Collect distinct subagents, parent relationships, roles, and token attribution

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Apply the common completion requirements in the [backlog index](README.md).

## Starting points

- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)
- [companion/crates/observatory-adapters/src/requests.rs](<../../companion/crates/observatory-adapters/src/requests.rs>)
- [tests/fixtures/usage-v2/parity](<../../tests/fixtures/usage-v2/parity>)

## Execution record

Completed September 13, 2026 on `kit-board/usg-005-agent-lineage`. The local state schema now keeps hashed agent profiles, lifecycle events, parent-evidence precedence, and direct/inferred/invalidated depth provenance. Claude and Codex histories populate main, child, nested, resumed, attempted, completed, failed, denied, cancelled, and unknown evidence without exposing provider IDs or custom names. Late sidecars and stronger parent evidence reconcile earlier rows, while direct provider depth remains authoritative.

Current settings are applied again when pending records and hourly buckets are assembled, including subagent inclusion, detail level, project attribution, and agent-name policy. Offline envelopes rebuild data under those settings while retaining prior run coverage in data-free envelopes. Synthetic fixtures cover inline sidechains, child files, nested delegation, missing parents, late spawn evidence, replay, disabled subagents, legacy child rows, missing Codex session IDs, depth correction/invalidation, and queued policy changes.

Verification passed with `cargo test --workspace`, `cargo fmt --all --check`, workspace clippy with warnings denied, `cargo deny check`, `python scripts/fixtures.py check`, `npm test` (75 passed and four expected database skips), `npm run typecheck`, `npm run build`, and `git diff --check`. An independent high-effort review reproduced several ordering and policy edge cases; regressions were added for each, and the final review reported no actionable findings.
