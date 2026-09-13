# USG-017: Build the Tokens overview, composition bar, and activity chart

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-016](usg-016-shared-filters-and-interactive-charts.md)
Created: 2026-09-13

## Outcome

Show filtered usage immediately without waiting for a separate monthly report.

## Current gap

The current landing view is tied to machine/month report publication.

## Acceptance criteria

1. Make Tokens the proposed Usage landing page with month-to-date/all-account defaults and the common filter bar.
2. Show a compact observed-token total followed by a long exclusive-composition bar, counts/percentages, and an unclassified remainder; reasoning remains within output.
3. Render the overall daily activity chart with exact interval details and minimal Y-axis; offer finer/coarser resolution only where supported.
4. Explain last observation, partial coverage, missing periods, unsupported historical filters, and refresh failures while retaining last good data when appropriate.
5. Establish the full agreed card order, including environmental impact before projects/agents, and integrate later cards without duplicate filter controls.

## Verification

Compare rendered totals/composition/day sums with query results across two accounts and projects, current/closed periods, historical-only coverage, unknown categories, and failed refreshes.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [lib/usage.ts](<../../lib/usage.ts>)
- [components/kit](<../../components/kit>)
- [components/page-header.tsx](<../../components/page-header.tsx>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
