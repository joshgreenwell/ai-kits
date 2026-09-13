# USG-007: Collect and map project identities across machines and worktrees

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md)
Created: 2026-09-13

## Outcome

Make project filtering match the project a conversation belongs to.

## Current gap

Working-directory hashes exist only when enabled; native project mapping, labels, and cross-machine grouping are missing.

## Acceptance criteria

1. Retain explicit native conversation-project identity where the source supports it; use an identified mapped working directory otherwise and record the attribution basis.
2. Provide a stable project registry and minimal authenticated naming/mapping interface that can join different machine paths and worktrees without assuming equal folder names mean equal projects.
3. Keep private paths local and upload only the permitted identity/label representation; honor attribution settings and local deny rules.
4. Separate mapped Project, Unassigned project (identity present but not mapped), known No project, and Unknown project; keep every state in totals and define how historical mapping changes are applied without editing raw facts. Report evidence coverage separately from registry-mapping coverage.
5. Enable supported backfill from retained evidence and expose attribution coverage rather than synthesizing project detail from coarse history.

## Verification

Test the same project on two machines, separate projects with matching folder names, worktrees, native project evidence, unknown/no-project cases, mapping changes, and duplicate request replay.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [companion/crates/observatory/src/commands/projects.rs](<../../companion/crates/observatory/src/commands/projects.rs>)
- [companion/crates/observatory-core/src/state.rs](<../../companion/crates/observatory-core/src/state.rs>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [app/api/collection-settings/route.ts](<../../app/api/collection-settings/route.ts>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
