# USG-014: Make collection settings, cadence, and health reflect actual capabilities

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md)
Created: 2026-09-13

## Outcome

Make it clear which details are being collected and whether configured changes actually took effect.

## Current gap

Some settings expose unimplemented readers, cadence edits do not update installed schedules, and coverage-only runs can appear healthy.

## Acceptance criteria

1. Advertise implemented capabilities by adapter/build and make unavailable readers/features visibly unsupported rather than presenting them as working setup options.
2. Distinguish pairing, account binding, verified sign-in, successful adapter execution, actual records, and data freshness. Report detailed publication health separately while the bridge remains.
3. Make request/tool/project/resource detail preferences and local deny rules observable through effective settings and per-install acknowledgements.
4. Reconcile desired cadence with the installed service schedule, either applying it through a supported mechanism or showing the exact required local action and pending state.
5. Expose per-provider last observation, record counts by fact type, error category, accepted settings version, backfill state, and rejected records without leaking private inputs.

## Verification

Exercise unsupported adapters, coverage-only success, denied detail, account changes, cadence mismatch, adapter failure, rejected uploads, and differing client builds with the same nominal version.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [lib/companion-settings.ts](<../../lib/companion-settings.ts>)
- [components/companion-installs.tsx](<../../components/companion-installs.tsx>)
- [companion/crates/observatory-core/src/service.rs](<../../companion/crates/observatory-core/src/service.rs>)
- [companion/crates/observatory-core/src/effective.rs](<../../companion/crates/observatory-core/src/effective.rs>)
- [companion/crates/observatory-adapters/src/stubs.rs](<../../companion/crates/observatory-adapters/src/stubs.rs>)
- [app/api/collection-settings/route.ts](<../../app/api/collection-settings/route.ts>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
