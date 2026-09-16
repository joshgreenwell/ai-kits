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

### Design-system alignment pass (September 15, 2026)

A review of the running pages found the new controls and cards had drifted off the house style. `app/theme.css` is the design system: it dresses shadcn primitives through unlayered `[data-slot="..."]` selectors, so a control only looks right when it carries the correct slot — copying a primitive's Tailwind classes does not reproduce it.

- `components/usage-filter-bar.tsx`: the shared `FilterTrigger` now writes `data-slot="select-trigger"` *after* `{...props}`. `PopoverTrigger asChild` passes its own `data-slot="popover-trigger"` down as a prop, so the earlier ordering let the popover's slot win and theme.css dressed nothing; Accounts, Projects, and More filters rendered as 46px transparent buttons beside the 44px card-backed Period and Resolution. All five triggers now measure identically (44px tall, 14px text, `10px 14px` padding, control background, 6.4px radius).
- `app/theme.css`: `[data-slot="tooltip-content"]` joins `select-content` and `hover-card-content` on the shared overlay surface, with compact tooltip sizing. Table border rules name `var(--border)` explicitly, because Tailwind preflight is deliberately not imported and a bare `border-b` in a vendored primitive resolves to `currentColor`.
- `components/usage-series-chart.tsx`, `components/allowance-burn-chart.tsx`: every line and area uses `type="natural"` with `dot={false}` and an `activeDot` on hover only, matching the default shadcn chart. The custom `ReadingDot` is gone.
- `components/usage-insight-cards.tsx`: the tokens-by-model table follows the `/design` reference — `font-mono truncate` model identifiers with a `title`, the `ProviderDot` square swatch rather than a circle, a `Total · N models` footer, `CardHeader` without a bottom border, and no nested max-height scroller.

Checks: `npx tsc --noEmit` clean; `node --import tsx --test tests/*.test.ts tests/*.test.tsx` — 131 tests, 125 pass, 6 skipped (DB-gated), 0 fail. Verified against the running local app with measured computed styles, not screenshots alone.
