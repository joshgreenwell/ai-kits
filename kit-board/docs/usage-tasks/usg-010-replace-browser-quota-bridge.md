# USG-010: Build and verify the v2 replacement for the active browser quota bridge

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md)
Created: 2026-09-13

## Outcome

Replace the existing Claude browser quota dependency with a working paired v2 collector.

## Current gap

The app issues browser pairing codes but no v2 browser collector exists; active v1 extensions still provide needed account readings.

## Acceptance criteria

1. Implement a usable installation/pairing path and allowance-only upload flow for the currently supported Claude browser accounts using verified source fixtures.
2. Respect account identity, source enable/disable, settings, credential scope, and local/session isolation; do not upload token counters, browsing content, or arbitrary page text.
3. Expose reader health, recognized windows, last actual observation, pairing failures, and unsupported browser/provider states truthfully.
4. Run the replacement alongside the old bridge only for a controlled reconciliation period, with a defined duplicate-selection policy. Keep the old source available until new readings and preserved history are verified.
5. Document installation and per-profile cutover on each used browser/machine. Leave unrelated browser integrations intact; remove the old extension only in USG-026.

## Verification

Test pairing/auth, account changes, quota-only restrictions, failed reads, duplicate old/new observations, and a real new scheduled/automatic reading from each accessible supported browser profile.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [browser/claude-quota](<../../browser/claude-quota>)
- [components/browser-connections.tsx](<../../components/browser-connections.tsx>)
- [app/api/v1/companion](<../../app/api/v1/companion>)
- [app/api/v1/usage/route.ts](<../../app/api/v1/usage/route.ts>)
- [tests/browser-collector.test.ts](<../../tests/browser-collector.test.ts>)
- [docs/usage-v1-retirement.md](<../../docs/usage-v1-retirement.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
