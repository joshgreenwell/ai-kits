# USG-023: Build account allowance accordions with per-window burn charts

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

- [app/(private)/usage/allowances/page.tsx](<../../app/(private)/usage/allowances/page.tsx>) (the USG-015 scaffold this task replaces)
- [components/telemetry-shared.tsx](<../../components/telemetry-shared.tsx>)
- [components/model-usage-history.tsx](<../../components/model-usage-history.tsx>)
- [lib/telemetry-contract.ts](<../../lib/telemetry-contract.ts>)
- [docs/usage-burn-rate-history.md](<../../docs/usage-burn-rate-history.md>)

## Execution record

Executed on 2026-09-15 on `main`.

Changed files: `lib/allowance-view.ts` (new: `accountViews`, `outlookState`, `carriedAccounts`, the persisted preferences, `expandedAccounts`, `rememberExpanded`, `countdownLabel`), `components/allowance-accordion.tsx` (new), `components/allowance-burn-chart.tsx` (new), `app/(private)/usage/allowances/page.tsx` (rewritten), `components/usage-navigation.tsx` (carries `accounts` and `providers` between the subtabs), `lib/telemetry-contract.ts` (`quotaOutlook` takes the cycle holding the newest live reading as the active one), `components/allowance-card.tsx` (removed), `tests/allowance-view.test.ts` and `tests/allowance-accordion.test.tsx` (new), `tests/telemetry.test.ts` (one expectation follows the active-cycle rule).

Decisions:

- The data source stays `GET /api/usage-live`, whose `allowance_percent_view` rows already carry `history_only` (USG-011). Each account is one Radix `Accordion` item (`type="multiple"`); the header holds the account, its provider, identity badges, the newest observation behind a current figure, and every visible window side by side (title from `meterLabel`, outlook badge, remaining percentage points, used and reset countdown or "window has reset", meter, projection or pause reason, the window's own observation time, model-scoped and Spark notes). Expansion renders one detail per window: the burn chart, projected-by-reset, forecast burn and available pace per hour (windows under a day) or per day, the verdict, and "How this projection works" naming the forecast source, warm-up weight, and the safeguards.
- Every current figure is the newest live reading of its own window: `quotaOutlook` now picks the cycle containing the newest live reading (readers that estimate the reset differently no longer promote an older reading once one boundary passes), and the page's history range (7, 14, or 30 days, persisted) narrows only `history` and `cycles`, keeping the whole active cycle whatever the range. Overlapping windows (five-hour, weekly, model-scoped, Spark) are forecast independently because grouping is per account and `window_key`; percentage points never mix with tokens.
- The burn chart normalizes each cycle to its phase (0 at `windowStartedAt`, 1 at the reset) so every other cycle in range, completed or a newer history-only one, sits faint under the emphasized current cycle; the projection continues from the last reading in the warning stroke with the forecast-start and reset markers, the historical band and seed line appear only while a forecast is running (a stale or expired reading pauses them), the even-pace guide is the dotted diagonal, the Y ceiling grows in 25-point steps when demand exceeds the allowance, and each reading of the current cycle is a focusable button with hover, keyboard, and touch detail in an `aria-live` line; the SVG is a labelled group so those readings stay in the accessibility tree.
- Preferences live in `localStorage` under `observatory.allowances.v1` (`expanded`, `showSpark`, `historyDays`), parsed tolerantly, loaded after mount; the first account starts open, several may be open, and toggling in a narrowed view keeps the remembered state of the accounts it does not show. Spark windows start hidden; the toggle shows their count and is disabled when none exist.
- The selection carried from Tokens is `accounts` and `providers` only, read from the URL by both the subtab links and the page; every other Tokens filter is ignored here, and "Show all accounts" clears the narrowing. Identity alerts come from `/api/usage-v2` bindings (`duplicate_identity`, `identity_state` unconfirmed or reset), deduplicated, fetched after each live refresh until one succeeds and then kept for five minutes.
- The model history section stays beneath the accordion, fed by the visible windows that have a current reading; the reset calendar remains behind the header button until USG-024 relocates it.

Focused checks: `npm run typecheck`; `npm test` (130 tests including the two new files: two providers with differing window sets, Spark hidden then shown, blended, learning, stale, expired, and history-only states, a later history-only reading never becoming current, reader disagreement on the reset, the short range keeping the active cycle, the newer history-only cycle drawn faint, no seed while stale, no `NaN` in the SVG, countdown rounding, carried params, preference parsing, expansion memory); `npm run build`; `npm run test:db` (14 migrations on postgres:17-alpine). One focused review found nine defects (presentational SVG role, a newer history-only cycle never drawn, reader disagreement promoting an older reading, the expired countdown sentinel, forecast lines drawn from a stale reading, the header time from a disabled source, duplicate alert keys, one-shot alert fetch, expansion memory shrinking when narrowed); all were fixed and covered before this record. The private workspace's unlock password was not entered, so the page was verified through the render tests rather than a browser walk-through.

Remaining: USG-024 moves the reset calendar and feed under this view; USG-016 still owns the shared legend and preference conventions; production shows this only with the USG-025 server build.
