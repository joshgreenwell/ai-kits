# USG-024: Place reset calendar and feed beneath the account allowances

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-015](usg-015-global-settings-and-navigation.md), [USG-023](usg-023-allowance-account-accordions.md)
Created: 2026-09-13

## Outcome

Keep reset tracking available within Allowances while moving connection diagnostics to Settings.

## Current gap

The reset calendar still renders at `/usage/resets`, linked from Allowances rather than a subtab; feed health already moved to `/settings/feeds` in USG-015.

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

- [app/(private)/usage/resets/page.tsx](<../../app/(private)/usage/resets/page.tsx>)
- [components/reset-calendar.tsx](<../../components/reset-calendar.tsx>)
- [lib/reset-feeds.ts](<../../lib/reset-feeds.ts>)
- [lib/reset-feed-store.ts](<../../lib/reset-feed-store.ts>)
- [docs/reset-feeds.md](<../../docs/reset-feeds.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
