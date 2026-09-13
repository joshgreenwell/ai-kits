# USG-018: Add interactive API-cost and tokens-by-model cards

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md)
Created: 2026-09-13

## Outcome

Compare estimated API cost and token usage by model and recorded effort.

## Current gap

The current cost detail is primarily a monthly table and lacks the requested paired graph/table experience.

## Acceptance criteria

1. Place the API-equivalent cost card and tokens-by-model card after the overall activity chart in the agreed order.
2. Give both cards persistent graph/table switching, exact-value interaction, minimal axes, consistent model colors, and line visibility through their legends.
3. Show per-model cost/token time series and period tables; make effort and applicable tier breakdowns available while preserving unknown values and avoiding an unreadable initial legend.
4. Display cost assumptions/catalog version and priced/unpriced coverage; separate API-equivalent estimates from subscription spend and actual bills.
5. Keep all totals and series derived from the same selected scope; hiding a line or switching view never changes the headline token total.

## Verification

Compare table sums and plotted points against calculation outputs, including multiple efforts/tiers, unpriced models, hidden lines, missing days, and filter changes.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [components/model-usage-history.tsx](<../../components/model-usage-history.tsx>)
- [components/ui](<../../components/ui>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
