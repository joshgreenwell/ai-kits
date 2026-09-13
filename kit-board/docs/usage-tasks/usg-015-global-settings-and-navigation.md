# USG-015: Move configuration into global Settings and establish two Usage subtabs

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
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

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [components/navigation.tsx](<../../components/navigation.tsx>)
- [components/usage-navigation.tsx](<../../components/usage-navigation.tsx>)
- [app/(private)/usage/layout.tsx](<../../app/(private)/usage/layout.tsx>)
- [app/(private)/usage/connections/page.tsx](<../../app/(private)/usage/connections/page.tsx>)
- [app/(private)/usage/settings/page.tsx](<../../app/(private)/usage/settings/page.tsx>)
- [components/companion-installs.tsx](<../../components/companion-installs.tsx>)
- [components/browser-connections.tsx](<../../components/browser-connections.tsx>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
