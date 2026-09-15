# USG-017: Build the Tokens overview, composition bar, and activity chart

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>) and [components/tokens-overview.tsx](<../../components/tokens-overview.tsx>) (the overview that replaced the USG-015 scaffold)
- [lib/usage.ts](<../../lib/usage.ts>)
- [components/kit](<../../components/kit>)
- [components/page-header.tsx](<../../components/page-header.tsx>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Completed on `main` on September 15, 2026.

- Decisions: Tokens (`/usage`) now opens on the filtered overview and reads one document, `GET /api/usage-query`; the monthly analyzer reports stay beneath it as their own section with their own month and machine selectors, because they are a different ledger and are never added to the overview. The filter state is the private URL: `lib/usage-view.ts` parses and serializes the same keys the API accepts (`preset`, `start`, `end`, `timezone`, `resolution`, `accounts`, `providers`, `models`, `efforts`, `machines`, `surfaces`, `projects`, `agent_scope`, `agents`), with lists deduplicated and sorted so a selection has one URL and one cache key, unknown values dropped rather than failing the page, and defaults omitted so the landing link is bare (month to date, all accounts and projects, daily, America/Chicago). `components/usage-filter-bar.tsx` keeps period, accounts, and projects visible, puts provider, model, effort, machine, surface, and agent scope under More filters, shows every active narrowing as a removable chip with Clear all (which keeps the period and resolution), names the resolved range and the one display zone, and offers hourly resolution only for ranges up to 14 days. The USG-012 scope gained `machines` (every non-browser collector source) so the machine filter has its vocabulary; model and effort options come from the result in scope; project names come from `/api/usage-projects`.
- Cards: the total card shows the compact observed total, the exact total, model calls, conversations, and the last observation with its age, the basis badge (hourly buckets, request detail, and whether monthly snapshots were merged), and, under a detail filter, the bucket tokens and calls that carry no request detail and were excluded rather than matched. The composition card renders one long bar of exclusive categories (fresh input, cached input, cache-write input, output, unclassified) with exact counts and percentages; reasoning is reported as a subset of output and never added again; tokens reported only as a total are folded into unclassified and said so; components that exceed the total withhold the shares rather than clamp (`compositionView`). `components/usage-chart.tsx` draws tokens over time as one focusable bar per interval, so hover, keyboard focus, and a tap all reveal the same exact detail (interval in the display zone, tokens, calls, composition, state, sources); an interval still being observed is outlined, a recorded zero is a flat tick, and an interval with no collector coverage is a dashed tick; the Y axis carries three abbreviated labels and its unit; a table of every interval sits beneath. The coverage card names request-detail coverage, merged snapshots with their method version, snapshots listed and not counted with their reason, the layer's unsupported and notes lists, and the browser and cloud gap. A failed refresh keeps the last good result on screen, marked with its time, with a retry; a rejected filter set says so.
- Card order: the agreed order is declared once (`TOKENS_SECTIONS`) and the built cards render in it; the later cards (API-equivalent cost and tokens by model in USG-018, environmental impact in USG-020, projects and agents in USG-021, tools and knowledge sources in USG-022) are named in order beneath, not drawn as empty cards, and will share this filter bar and result.
- USG-016 boundary: this task built the filter bar with private URL state, chips, Clear all, one display zone, and the interactive interval chart with exact-value details, keyboard and touch access, a minimal labeled axis, and missing/partial/zero states, plus a table view of the values. USG-016 still owns legend series toggles, persisted per-card graph/table preferences, consistent model colors across cards, and the shadcn/Recharts evaluation; the chart primitive is dependency-free so it can be swapped without changing what a point means.
- Synthetic coverage: `tests/usage-view.test.ts` (URL round trip, canonical lists, dropped unknowns, custom-range bounds, chips and Clear all, composition reconciliation with a reported-only remainder and an inconsistent case, chart ticks, interval labels in the display zone including a clipped day and an hour, series summary, the 14-day hourly bound, inclusive custom dates); `tests/tokens-overview.test.tsx` renders the overview from a synthetic query result (two accounts, a merged snapshot, an uncovered day, a partial day) and checks the headline, every composition count and percentage against `compositionView`, the bar sums against the headline, each bar's accessible name, the merged and listed snapshots, notes and unsupported filters, request-detail coverage, the section order, the detail-filter disclosure, the stale badge with the last good figures kept after a failed refresh, the loading and failed states, an inconsistent composition, and hourly labels. The unit test glob now includes `.tsx`.
- Verification on September 15, 2026 (Windows host): `npm run typecheck`, `npm run build` (the client bundle carries only client-safe modules), `npm test` (124 tests, 118 passed, six database-gated skips), `npm run test:db` (14 migrations, all integration suites), and one focused review whose seven findings were all fixed: filter vocabularies accumulate across results instead of shrinking to the current selection, filter changes apply to local state at once so quick successive toggles compose, a custom range that cannot be served hourly drops to daily before the request (and a shared URL with such a range parses as daily), a shared custom-range link fills its date inputs, the last good result keeps its own resolution and zone while new filters load and shows an updating badge, every time on the page is formatted in the display zone, and the chart has one tab stop with arrow, Home, and End keys between bars.
- Remaining, outside this task: the migrations from USG-011 and USG-012 and this build deploy together under USG-025; a browser walkthrough against seeded data needs the operator's login and was not performed here.
