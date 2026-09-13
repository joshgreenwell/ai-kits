# USG-021: Build project and agent breakdown cards with drill-down

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-005](usg-005-collect-agent-lineage.md), [USG-007](usg-007-map-project-identities.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md)
Created: 2026-09-13

## Outcome

Explain which projects and agents account for the selected usage.

## Current gap

Existing monthly classifications do not provide the unified mapped project and independent agent detail.

## Acceptance criteria

1. Show project and agent cards side by side on wide screens and stacked on narrow screens, after environmental impact.
2. Project rows show mapped name, token totals/share, and supported calls/conversations, with separate No project and Unknown project buckets and visible attribution coverage.
3. Agent content shows observed distinct children, main/subagent token share, built-in/custom/unknown roles, parent, actual model, and depth where recorded.
4. Selecting a project or supported agent dimension applies the common filter and produces a reversible drill-down.
5. Keep missing identity explicit and agent tokens within overall totals; do not present custom-role classification as proof of user-versus-model initiation.

## Verification

Exercise cross-machine mappings, worktrees, missing identity, nested/resumed agents, partial attribution, drill-down/reset, and reconciled totals.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
