# USG-016: Build shared filters, chart interactions, and table preferences

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-001](usg-001-metric-and-source-contract.md)
Created: 2026-09-13

## Outcome

Give every new usage visualization the same filtering and interaction rules.

## Current gap

Existing daily bars lack the requested rich hover and minimal-axis behavior, and model/cost tables lack consistent chart switching.

## Acceptance criteria

1. Create a shared filter bar with visible date/accounts/projects, additional supported dimensions, multi-select, active chips, Clear all, private URL state, and one displayed timezone.
2. Provide interactive time-series primitives with exact-value tooltips, keyboard/touch access, minimal labeled axes, consistent model colors, and missing/partial/zero states.
3. Implement legend controls that hide/reveal lines while keeping hidden series discoverable; visibility does not change global filters or headline totals.
4. Provide graph/table switching and persisted per-card preferences without losing scope/grouping, plus usable numeric sorting and an accessible underlying data view.
5. Use the existing design system and evaluate the compatible shadcn/Recharts components against the local app rather than assuming an upgrade is required.

## Verification

Verify filter URL round trips, multi-selection, timezone boundaries, legend reset, graph/table consistency, touch/keyboard usage, long labels, and narrow screens with synthetic data.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [components/ui](<../../components/ui>)
- [components/kit](<../../components/kit>)
- [components/model-usage-history.tsx](<../../components/model-usage-history.tsx>)
- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
