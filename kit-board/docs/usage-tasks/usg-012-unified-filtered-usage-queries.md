# USG-012: Build one filtered usage query layer with explicit coverage

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 3. Read models
Dependencies: [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-005](usg-005-collect-agent-lineage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-011](usg-011-reconcile-historical-ledgers.md)
Created: 2026-09-13

## Outcome

Serve all Tokens cards from a consistent selected scope without a monthly publishing dependency.

## Current gap

Monthly report and live endpoints use separate pipelines and cannot currently supply the full requested filters and breakdowns together.

## Acceptance criteria

1. Provide common period/account/project/provider/model/effort/machine/surface/agent filters, with OR-within/AND-across semantics, explicit Unknown/unfilterable handling, half-open time ranges, full-bucket inclusion, and bounded query behavior.
2. Return canonical total/composition, overall and model time series, pricing inputs, project/agent/tool/resource summaries, eligible call evidence, and per-section coverage/provenance.
3. Keep request events and coarser fallback history mutually reconciled; preserve provider event/query-profile identity, crosswalk monthly subjects to logical populations, prefer complete revisions for closed months, and explain unsupported filters and historical resolution instead of silently returning unfiltered monthly figures.
4. Use observation time and mark partial intervals, true zeros, missing data, unknown dimensions, and unavailable estimates. Counts and shares state their denominator.
5. Preserve private authentication, no-store behavior, database queue serialization, timeouts, cache boundaries, and error/retry behavior under a realistic history size.

## Verification

Use a mixed old/new synthetic history and intersecting filters; reconcile all disjoint breakdowns to canonical totals, test time boundaries/DST, and exercise authenticated bounded concurrent reads.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/api/usage-v2/route.ts](<../../app/api/usage-v2/route.ts>)
- [app/api/usage-live/route.ts](<../../app/api/usage-live/route.ts>)
- [app/api/reports/route.ts](<../../app/api/reports/route.ts>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [lib/telemetry-store.ts](<../../lib/telemetry-store.ts>)
- [lib/database-queue.ts](<../../lib/database-queue.ts>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
