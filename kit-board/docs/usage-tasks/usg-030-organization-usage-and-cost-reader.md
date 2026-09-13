# USG-030: Implement OpenAI organization usage and cost collection

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Collect actual organization API usage and cost where an intended account has the required access.

## Current gap

The organization adapter is a stub and its aggregate/money ledgers have no verified ingested data in the audit.

## Acceptance criteria

1. Verify current official usage/cost APIs, required organization access, supported dimensions, pagination, and source time semantics using primary documentation and fixtures.
2. Implement checkpointed usage buckets and money entries with stable provider keys, late-correction handling, account/project/key scope, and original source timestamps.
3. Keep provider aggregates, overlapping local requests, actual charges, credits, and hypothetical API estimates distinct; define reconciliation without summing duplicate usage.
4. Keep Admin credentials local/server-only and expose unavailable access or dimensions honestly. Organization API billing must not be presented as subscription allowance or spend.
5. Verify applicable filtered views and a real authorized organization-period receipt when access exists; otherwise retain an explicit external prerequisite.

## Verification

Test pagination, corrections, duplicates, money units, scope/identity changes, permission failures, and reconciliation against a provider-reported sample period.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/stubs.rs](<../../companion/crates/observatory-adapters/src/stubs.rs>)
- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
