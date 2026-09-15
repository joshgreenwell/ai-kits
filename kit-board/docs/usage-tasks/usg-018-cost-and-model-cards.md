# USG-018: Add interactive API-cost and tokens-by-model cards

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Completed September 15, 2026.

- `components/usage-insight-cards.tsx` adds the API-equivalent cost and tokens-by-model cards immediately after the overall activity chart. Each defaults to a graph, remembers its own graph/table preference in local storage, exposes exact period/model tables, and leaves the selected headline untouched when a line is hidden or a view changes.
- `components/usage-series-chart.tsx` supplies the shared model-color map, minimal axes, readable top-five default, toggleable complete legend, Show all recovery, gap-preserving lines, and exact values on hover, focus, arrow keys, and tap. The same model color is used by both cards.
- `lib/usage-pricing.ts` now returns daily per-model cost series using each request's existing America/Chicago source price date. Missing dates remain gaps, and every series row retains priced/unpriced tokens, calls, dimensions, rate versions, and cost components. The aggregate estimate and catalog rules are unchanged.
- The cost card labels the figure as API-equivalent rather than spend or billing, reports input and catalog pricing coverage, preserves unpriced reasons, and expands to the catalog version, sources, and assumptions. Its tables expose model totals plus recorded effort and applicable/assumed service tier, including Unknown.
- Focused checks: `node --import tsx --test tests/usage-pricing.test.ts tests/environmental-estimate.test.ts tests/tokens-overview.test.tsx` (15 passed) and `npm run typecheck` passed. Full `npm test` passed 125 tests with six database-gated tests skipped, and `npm run build` completed all 29 static pages and the production route manifest. The database-backed query test asserts the new cost-series reconciliation when `TEST_DATABASE_URL` is available. An authenticated local browser check stopped at the expected login boundary because no verification credential/helper was available; no production database or deployment was changed.
