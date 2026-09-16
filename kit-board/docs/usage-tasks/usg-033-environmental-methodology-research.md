# USG-033: Improve environmental estimation after the current method is preserved

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 7. Later environmental work
Dependencies: [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-019](usg-019-environmental-action-recommendations.md), [USG-020](usg-020-environmental-impact-section.md)
Created: 2026-09-13

## Outcome

Develop a better-supported future estimate while keeping historical results reproducible.

## Current gap

The existing generic per-call scenarios are deliberately approximate and do not identify the executing datacenter.

## Acceptance criteria

1. Review current primary evidence for workload/model/context/cache effects, electricity, direct versus indirect water, operational carbon, and applicable regional averages.
2. Evaluate uncertainty and representativeness rather than replacing averages with unsupported model-specific precision.
3. Propose a versioned methodology with explicit scope, inputs, sources/dates, classification rules, and coverage requirements; quantify how it differs on representative stored workloads.
4. Preserve prior estimates/catalog versions and design an explicit recalculation choice for history instead of silently rewriting old numbers.
5. Create implementation follow-ups from the reviewed method. Do not block the core section, which must reuse the current calculation first.

## Verification

Produce a reproducible research/calculation comparison with sensitivity cases and limitations. Research completion is distinct from shipping a new method.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [lib/environmental-factors.json](<../../lib/environmental-factors.json>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
