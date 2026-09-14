# USG-007: Collect and map project identities across machines and worktrees

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Completed on `kit-board/usg-007-project-identities`.

- Companion state schema 6 preserves explicit `native`, `working_directory`, `none`, and `unknown` project evidence. Supported Claude and Codex histories distinguish explicit absence from missing or malformed `cwd`, store the local path-to-hash map only on the machine, and emit privacy-safe keys when attribution is enabled.
- Current local project, detail, agent, tool, adapter, provider, and execution-mode privacy rules are reapplied before queued records are uploaded. Parent deny prefixes and direct adapter/provider denies keep previously queued data local.
- The server now has scoped project identities, stable logical labels, append-only mapping revisions with serialized database order, and an authenticated same-origin `/api/usage-projects` naming/mapping interface. Working-directory identities are scoped per install; native identities are scoped per account and provider.
- `activity_request_project_resolution` selects one evidence-aware revision per logical request and keeps Project, Unassigned, No project, and Unknown distinct. Retained legacy `project_hash` evidence is backfilled and resolved without modifying raw request rows. Evidence, registry mapping, and resolved-request coverage remain separate.
- Synthetic coverage includes two machines, matching folder hashes that remain separate, multiple worktrees mapped together, native and legacy identities, No project and Unknown, richer replay canonicalization, rapid map/unmap/remap history, duplicate replay, app-role limits, malformed source values, state migration, and fresh/queued local denies.

Verification: `cargo test --workspace`, `cargo fmt --all -- --check`, clippy with warnings denied, `cargo deny check`, fixture validation, 77 web tests, TypeScript, production build, script syntax, and diff checks passed. The disposable PostgreSQL suite was attempted, but Docker Desktop's Linux engine did not become ready on this host; the migration/backfill and restricted-role integration cases remain checked in for CI. A fresh high-effort read-only review reported `CLEAN` after the review fixes.
