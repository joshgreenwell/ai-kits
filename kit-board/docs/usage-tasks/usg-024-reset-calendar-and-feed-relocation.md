# USG-024: Place reset calendar and feed beneath the account allowances

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-015](usg-015-global-settings-and-navigation.md), [USG-023](usg-023-allowance-account-accordions.md)
Created: 2026-09-13

## Outcome

Keep reset tracking available within Allowances while moving connection diagnostics to Settings.

## Current gap

Closed: the calendar and record are section 03 of Allowances and `/usage/resets` redirects to that anchor; feed health had already moved to `/settings/feeds` in USG-015.

## Acceptance criteria

1. Reuse the existing reset calendar/feed below the account cards, preserving day selection, provider/type filters, event details, banked lifecycle, announcements, and source links.
2. Preserve current feed allowlist/normalization and refresh lease behavior; reconcile concurrent reset-feed work before editing.
3. Differentiate personal provider reset timestamps from public reset claims/predictions. Public events never overwrite account reset anchors.
4. Move full feed health/connection diagnostics into Settings while keeping affected stale/unavailable context beside feed results.
5. Preserve old reset deep links through a redirect/anchor and verify account selection affects only relevant personal context, not the meaning of global announcements.

## Verification

Check event/day filtering, multiple reset types, lease reuse, stale/failed feeds, announced versus personal resets, deep links, and responsive calendar/feed layout.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [components/reset-record.tsx](<../../components/reset-record.tsx>)
- [components/reset-calendar.tsx](<../../components/reset-calendar.tsx>)
- [lib/reset-feeds.ts](<../../lib/reset-feeds.ts>)
- [lib/reset-feed-store.ts](<../../lib/reset-feed-store.ts>)
- [docs/reset-feeds.md](<../../docs/reset-feeds.md>)

## Execution record

Executed on 2026-09-15 on `kit-board/usg-018-usg-020-insights`.

Changed files: `components/reset-record.tsx` (new: everything the old page rendered apart from the page chrome — provider and type filters, the calendar, day selection, the event record, banked lifecycle, announcements, source links, and the manual feed check), `app/(private)/usage/resets/page.tsx` (reduced to `redirect('/usage/allowances#reset-calendar')`), `app/(private)/usage/allowances/page.tsx` (section 03 "Reset calendar", `scroll-mt-24` on the anchor), `components/reset-feed-health.tsx` (its link follows the anchor), `tests/nextreset-feeds.test.ts` (the retired-URL guard reads the component that now holds the UI), `docs/agent-handoff.md`, `docs/usage-system.md`, `docs/usage-collection.md`.

Decisions:

- The calendar is a section, not a destination, so it renders outside the `!data` branch that gates the account cards: it reads the public feeds through `/api/reset-feeds`, not `/api/usage-live`, and should not wait on allowance readings that have nothing to do with it. The manual check moved into the filter row it re-runs rather than staying a page-header action.
- The section heading states the separation the acceptance criteria ask for in the reader's own words: these are claims about the providers, not readings from this Observatory, and they never move an account's own reset anchor above. No public event is written into an allowance window.
- Feed allowlist, normalization, and the shared 30-minute refresh lease were not touched — the component calls the same `POST /api/reset-feeds` the page did.
- `/usage/resets` keeps working as a redirect to the anchor, so old deep links and the `docs/reset-feeds.md` published URL still land on the calendar.

Focused checks: `npx tsc --noEmit` clean; `node --import tsx --test tests/*.test.ts tests/*.test.tsx` — 131 tests, 125 pass, 6 skipped (DB-gated), 0 fail. Verified in the running local app while signed in: the section renders under the account cards with its provider/type filters, calendar grid, and event record, and `fetch('/usage/resets')` resolves to `/usage/allowances`.

Remaining: none for this task. USG-025 still owns the production build that ships it.

### Page chrome removal (September 15, 2026)

Allowances now opens directly on its filters. `app/(private)/usage/allowances/page.tsx` dropped the `PageHeader` block and the numbered `SectionHeading` wrapper; the three sections carry `aria-label` instead (`Accounts`, `Model history`, `Reset calendar`), and the reset anchor keeps its `id` and `scroll-mt-24`. The separation this task's acceptance criteria ask for — public feed claims are not readings from this Observatory and never move an account's reset anchor — moved into `CardDescription` in `components/reset-record.tsx`, so it stays where the reader meets the record rather than depending on the removed heading.
