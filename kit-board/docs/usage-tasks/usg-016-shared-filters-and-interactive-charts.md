# USG-016: Build shared filters, chart interactions, and table preferences

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: In progress
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

Delivered incrementally by the tasks that consume it rather than as its own change, through USG-017, USG-018, USG-023, and the September 16 design-system alignment pass.

Criteria 1-4 are implemented:

- `components/usage-filter-bar.tsx` carries the shared bar — date, accounts, projects, and the additional dimensions behind More filters, multi-select, active chips, Clear all, and one displayed timezone. Private URL state round-trips through the Tokens page.
- `components/usage-series-chart.tsx` and `components/allowance-burn-chart.tsx` provide the interval primitives: exact-value tooltips, keyboard and touch access, minimal labeled axes, one shared model-color map, and missing/partial/zero states.
- The legend rows are pressable and a hidden series stays discoverable, with Show all to recover. Hiding a line never changes filters or the headline.
- `components/kit/data-table.tsx` supplies numeric sorting with an accessible header control, and each card persists its own graph/table preference (`observatory.tokens.cost-view.v1`, `observatory.tokens.model-view.v1`, `observatory.allowances.v1`) without losing scope or grouping.

Criterion 5 was the September 16 correction. The controls had been built from Tailwind classes copied out of the vendored primitives, which does not reproduce the look: `app/theme.css` dresses shadcn primitives through unlayered `[data-slot="..."]` selectors, so a control is only styled when it carries the right slot. The filter triggers, the tooltip surface, the chart curves, and the model table were brought back onto the existing design system and the shadcn chart defaults; see the USG-018 execution record for the specific changes and the measured result.

Remaining: this task's own verification pass — filter URL round trips, multi-selection, timezone boundaries, legend reset, graph/table consistency, touch and keyboard usage, long labels, and narrow screens with synthetic data. The implementation is in place; the evidence is not recorded.

### 2026-09-21 · verification pass with synthetic data

Run against a fresh local database (`kit_board_verify`, all migrations, two synthetic installs, two providers, four models, three projects, 855 hourly buckets, 15,509 records over 45 days) on the built app, driven from the browser:
- URL round trips: `preset`, `timezone`, `resolution`, `agent_scope`, `models`, `machines`, `projects`, `efforts` load from a shared link; selecting an account writes `?accounts=…` and the headline narrows (18.5M to 9.5M); two accounts serialize as `accounts=a,b` with two chips; Clear all removes the list filters and keeps the period and zone; the Tokens and Allowances links carry the account selection between views.
- Timezone boundaries: `Pacific/Auckland` shows "Sep 1 to Sep 21 (now)" with 21 daily intervals while `America/Chicago` shows 20; the last-observation time is rendered in the selected zone.
- Legends: hiding a model removes its curve (28 to 27 paths), leaves the headline and the URL untouched, shows "Show all", and Show all restores it; legend rows are real buttons in the tab order.
- Graph/table: the cost card's Table view lists model, calls, tokens, priced, estimate; the preference persists in `observatory.tokens.cost-view.v1` and survives a reload.
- Long labels: an 80-character project label renders unclipped in the Projects table and in its chip; selecting the row filters the page through `?projects=<id>`.
- Narrow screens: at 375 px the page never scrolls horizontally; wide tables scroll inside their own containers.
- Found and fixed: the Agents table keyed rows by agent key alone, so an agent that used two models produced duplicate React keys (now keyed by agent, model, parent, and depth).
- Not a defect: a hard load with `?accounts=` appeared to hang in this harness because the browser pane was hidden and React 19's streamed-boundary reveal waits for an animation frame, which never fires in a hidden tab. Server HTML and the client-side path were verified complete.

Remaining: touch interaction on a real device (the keyboard path is verified; touch could not be exercised here). Everything else in this task's verification list is evidenced above.

