# USG-015: Move configuration into global Settings and establish two Usage subtabs

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Provide Tokens and Allowances under Usage and a global Settings destination in the main header.

## Current gap

Usage currently has five subtabs, including connection and collection configuration pages.

## Acceptance criteria

1. Add the main-header Settings destination and relocate existing connections, collection controls, and feed status without losing functioning operations.
2. Provide the minimal project/source naming and mapping controls required by USG-007 and USG-008; defer a broader settings redesign.
3. Establish Tokens and Allowances routes/layout, migrate old URLs to appropriate destinations, and retain access to historical report snapshots. Release routing only when the replacement views are ready.
4. Keep authentication, same-origin mutation protection, focus states, active navigation, and narrow-screen behavior consistent with the app.
5. Place compact relevant data-status indicators on the usage views with links to Settings diagnostics; no collector/version internals in the ordinary card flow.

## Verification

Check authenticated navigation, old deep links, settings operations, history access, keyboard/focus behavior, and responsive header/tab layout. Verify other report areas remain usable.

Apply the common completion requirements in the [backlog index](README.md).

## Starting points

- [components/navigation.tsx](<../../components/navigation.tsx>)
- [components/usage-navigation.tsx](<../../components/usage-navigation.tsx>)
- [app/(private)/usage/layout.tsx](<../../app/(private)/usage/layout.tsx>)
- [app/(private)/usage/connections/page.tsx](<../../app/(private)/usage/connections/page.tsx>)
- [app/(private)/usage/settings/page.tsx](<../../app/(private)/usage/settings/page.tsx>)
- [components/companion-installs.tsx](<../../components/companion-installs.tsx>)
- [components/browser-connections.tsx](<../../components/browser-connections.tsx>)

## Execution record

Completed on `kit-board/usg-015-global-settings-navigation` on September 14, 2026.

- Decisions: Settings is a header destination (`components/navigation.tsx`, prefix-matched active state) with route-driven subtabs (`components/settings-navigation.tsx`, exact match) rather than an entry in `lib/catalog.ts`, so the generic report viewer never sees it. Usage keeps two subtabs, Tokens (`/usage`) and Allowances (`/usage/allowances`). Nothing functioning disappeared: the monthly report and its month and machine selectors stay on `/usage` beneath the hourly activity scaffold (`components/token-activity.tsx`), the allowance cards and model history moved to Allowances, the reset calendar and record stay at `/usage/resets` (linked from Allowances) while feed health and the manual check moved to `/settings/feeds`. Old deep links redirect: `/usage/live` → `/usage/allowances`, `/usage/connections` → `/settings`, `/usage/settings` → `/settings/collection`; `/usage/reports` keeps its redirect. Every in-app link was rewired (Schedules, the cloud-estimate card, the companion card, empty states).
- Registries: one shared client (`components/registry.tsx`, payloads and outcome copy in `lib/registry-ui.ts`) provides create, rename, multi-select map, and unmap over the existing `PUT /api/usage-projects` and `PUT /api/usage-knowledge-sources` contracts; `components/project-registry.tsx` and `components/knowledge-source-registry.tsx` add each registry's coverage figures, empty states pointing at the collection setting that produces identities, and the knowledge registry's partial-detection notice. Identities show evidence keys and machine or account labels only; no control invites a path.
- Status indicators: `lib/usage-status.ts` derives one line per usage view from `/api/usage-live` sources (collectors enabled, contact judged per collector at two cadences plus fifteen minutes, unreadable logs as `partial`), rendered by `components/usage-status-line.tsx` with a link to Settings; cards carry no collector or version internals.
- Consistency: every page sits inside the private layout's auth boundary; mutations keep `requireSession` + `requireSameOrigin` on the existing routes; links keep the focus ring and `aria-current`; the subtab bars wrap on narrow screens like the usage bar did.
- Synthetic coverage: `tests/usage-status.test.ts` (status states, per-cadence quiet threshold, disabled collectors, registry payload id fields, deduped identities, outcome copy).
- Verification on September 14, 2026: `npm test` (100 tests, 96 passed, 4 database-gated skips), `npm run typecheck`, `npm run build` (routes `/settings`, `/settings/collection`, `/settings/feeds`, `/settings/projects`, `/settings/sources`, `/usage/allowances` plus the redirect stubs), `git diff --check`; the production server starts and unauthenticated requests to the new routes redirect to `/login`. Authenticated navigation, registry operations against real identities, keyboard order, and the narrow layout are for the owner to exercise in the browser (the session password is never entered by an agent); no server or database code changed, so the database suites were not rerun.
- Remaining notes: the Tokens and Allowances pages are scaffolds until USG-017 and USG-023 replace their content; the reset calendar relocation is USG-024; `/settings/feeds` polls nothing on its own and offers the manual check.
