# USG-025: Activate supported detail, backfill retained data, and verify the complete release

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 5. Cutover
Dependencies: [USG-010](usg-010-replace-browser-quota-bridge.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-014](usg-014-truthful-settings-and-collection-health.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-018](usg-018-cost-and-model-cards.md), [USG-020](usg-020-environmental-impact-section.md), [USG-021](usg-021-project-and-agent-breakdowns.md), [USG-022](usg-022-tool-and-knowledge-cards.md), [USG-024](usg-024-reset-calendar-and-feed-relocation.md)
Created: 2026-09-13

## Outcome

Demonstrate that scheduled collection powers every required view using real supported evidence.

## Current gap

A successful build or a coverage-only upload would not prove that the missing data or replacement UI is working.

## Acceptance criteria

1. Roll out compatible collector/server versions using the reviewed settings choices; enable the required request/tool/project/resource detail only on intended bindings while honoring local restrictions.
2. Backfill retained evidence with progress and retry receipts, preserve unrecoverable gaps, and reconcile totals and rich attribution against the baseline and representative previous monthly outputs.
3. Verify a scheduled collection cycle per required accessible machine/provider and the browser replacement, including nonzero relevant record types when activity occurred; document unavailable hosts as unfinished verification.
4. Run authenticated complete-flow checks from source event through ingest/store to filtered token, cost, environmental, project, agent, tool, allowance, and reset displays.
5. Exercise partial/stale/error/unknown states, month rollover, historical windows, navigation, keyboard/touch, responsive layout, and permissions. Run focused tests and the required build/typecheck suite.
6. Record deployment/collector versions, scoped receipts, data parity, residual gaps, and a tested rollback path. Core completion requires all requested sections and honest coverage, not just the new tab names.

## Verification

Produce a sanitized release receipt linked to source/store/UI evidence and a completed direction-document acceptance checklist. Deployment and machine changes occur only in a later authorized implementation run.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/startup-and-recovery.md](<../../docs/startup-and-recovery.md>)
- [docs/usage-collection.md](<../../docs/usage-collection.md>)
- [docs/usage-system.md](<../../docs/usage-system.md>)
- [docs/usage-v1-retirement.md](<../../docs/usage-v1-retirement.md>)
- [tests](<../../tests>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
