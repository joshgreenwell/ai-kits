# USG-004: Collect request detail and pricing evidence from supported local histories

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Apply the common completion requirements in the [backlog index](README.md).

## Starting points

- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)
- [companion/crates/observatory-adapters/src/requests.rs](<../../companion/crates/observatory-adapters/src/requests.rs>)
- [companion/crates/observatory-adapters/src/claude_execution.rs](<../../companion/crates/observatory-adapters/src/claude_execution.rs>)
- [companion/crates/observatory-adapters/src/codex_execution.rs](<../../companion/crates/observatory-adapters/src/codex_execution.rs>)
- [companion/crates/observatory-core/src/state.rs](<../../companion/crates/observatory-core/src/state.rs>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

Completed September 13, 2026 on `kit-board/usg-004-request-pricing-collection`.

- State schema 3 retains nullable request components, reasoning, reported totals, and pricing dimensions separately from the v1 bucket counters. Explicit zero-token requests remain visible without changing the legacy hourly calls or totals.
- Claude collection maps recorded effort, tier, speed, reasoning, cache-write TTL, response outcome, actual model, surface, and exclusive token counters. Codex collection maps effort, model context size, reasoning, reported totals, actual model, surface, and cumulative deltas. Neither local request row distinguishes requested from resolved model, so requested model remains unknown.
- A detail parser generation invalidates binding checkpoints once and replays eligible retained files. Rotation, archives, canonical file mirrors, partial trailing lines, coherent cumulative resets, and subagent inclusion retain the existing parity behavior. Unresolved malformed-file gaps survive unchanged scans, checkpoint invalidation, and source deletion until a successful full replay clears them. Missing roots, files outside `since`, and deleted source evidence remain unrecoverable and are reported as coverage limits.
- Adapter coverage now reports request, token-composition, and pricing capabilities, including `buckets_only` gating, incomplete token fields, missing pricing evidence, malformed input, and partial source history.
- Added a provenance-declared synthetic Claude/Codex request-detail corpus plus focused checks for exact/partial/zero tokens, pricing fields, nullable and reset cumulative deltas, replay identity, request-to-hour totals, detail gating, unavailable history, persistent parse gaps, privacy, contract validation, and checkpoint backfill. The existing v1 parity corpus remains unchanged.
- Verification passed: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, all 73 workspace tests, fixture-manifest validation, `npm test` (75 passed with four database-gated skips), `npm run typecheck`, `npm run build`, and `git diff --check`. A fresh high-effort Astra review found no remaining actionable issues after its cumulative-reset and coverage findings were fixed.

Deployment remains server-first because the compatible envelope has no runtime negotiation. USG-025 owns activating request detail and proving production source-to-screen receipts; this task does not change production settings.
