# USG-023: Build account allowance accordions with per-window burn charts

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-015](usg-015-global-settings-and-navigation.md), [USG-016](usg-016-shared-filters-and-interactive-charts.md)
Created: 2026-09-13

## Outcome

Make current account capacity and burn-rate outlook readable at a glance.

## Current gap

The current view spreads allowance windows into separate cards rather than grouping them under each account.

## Acceptance criteria

1. Put one full-width expandable account card first on Allowances, with side-by-side current windows, remaining values, reset countdowns, relevant observation time, and a compact outlook.
2. Use provider-supplied labels/scopes/durations/units; support differing window sets and a persisted Spark visibility control that starts hidden.
3. Expansion reveals each window's interactive burn/cycle history, observed and projected series, even-pace guide, reset markers, minimal axes, and source-of-forecast explanation.
4. Preserve current reset/gap/staleness safeguards and useful historical-prior behavior. Forecast overlapping windows independently and keep percentage-point pace separate from tokens.
5. Remember expanded accounts, allow several open, and ensure Tokens project/agent/effort filters do not alter account-wide capacity; a history range does not redefine current readings.

## Verification

Test two providers/accounts with differing windows, Spark, resets, stale/insufficient data, history-only disabled sources, ambiguous identity, forecast transitions, and responsive accordion interaction.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/live/page.tsx](<../../app/(private)/usage/live/page.tsx>)
- [components/telemetry-shared.tsx](<../../components/telemetry-shared.tsx>)
- [components/model-usage-history.tsx](<../../components/model-usage-history.tsx>)
- [lib/telemetry-contract.ts](<../../lib/telemetry-contract.ts>)
- [docs/usage-burn-rate-history.md](<../../docs/usage-burn-rate-history.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
