# USG-013: Reuse pricing and environmental calculations on the unified data

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 3. Read models
Dependencies: [USG-001](usg-001-metric-and-source-contract.md), [USG-012](usg-012-unified-filtered-usage-queries.md)
Created: 2026-09-13

## Outcome

Reproduce current API and environmental estimates for equivalent inputs and support honest filtering.

## Current gap

Rich estimates currently arrive through monthly analyzer snapshots or page-local environmental fallback calculations.

## Acceptance criteria

1. Make existing catalog-based API estimation reusable for filtered collected activity, preserving effort/tier/context/cache evidence, catalog version, assumptions, and priced/unpriced coverage.
2. Retain environmental method 2026-08-20.1 factors, threshold, electricity/water/carbon scenarios, comparisons, and the 10% comparable-call reduction scenario.
3. Apply the stable classification unit chosen in USG-001 so filtering does not reclassify unrelated calls; preserve historical snapshot methods and mark incomplete estimation coverage.
4. Do not use API dollars, allowance percentages, or an invented tokens-per-call average to supply missing environmental call evidence. Do not proportionally distribute unsupported historical detail.
5. Return reproducible estimate inputs, units, scenario labels, scope, source links, and method versions to the UI. Keep future methodology changes outside this task.

## Verification

Compare representative current analyzer/fallback outputs, threshold boundaries, mixed methods, no-call evidence, unpriced models, and filtered/unfiltered aggregation. Confirm the requested reuse rather than introducing new physical factors.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [app/(private)/usage/environmental-factors.json](<../../app/(private)/usage/environmental-factors.json>)
- [scripts/telemetry/detailed_report.py](<../../scripts/telemetry/detailed_report.py>)
- [lib/usage.ts](<../../lib/usage.ts>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
