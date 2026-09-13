# USG-001: Define metric semantics, source precedence, and remaining display decisions

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P0
Scope: Core
Stage: 1. Foundations
Dependencies: None
Created: 2026-09-13

## Outcome

Give collection and UI work a shared, reviewable definition of every displayed quantity.

## Current gap

The direction is established, but canonical overlap rules, environmental classification scope, and a few display defaults still need an explicit contract.

## Acceptance criteria

1. Document model calls, tool invocations, successful calls, observed subagents, spawns, conversations, token components, and the unknown/unassigned states with small synthetic examples.
2. Choose source precedence by metric and coverage interval for request data, hourly buckets, provider aggregates, and monthly snapshots; specify how overlap is detected without summing duplicate representations.
3. Define supported filters and time resolutions per source, one display timezone policy, partial-period comparison rules, and attribution/estimation coverage denominators.
4. Record two-tab labels, initial chart/accordion defaults, and a stable source-period unit for the reused environmental classification. Keep the optional compensation-dollar decision separate so it does not block core delivery.
5. Map each requested UI section and currently missing collector capability to the tasks in this backlog. Record unresolved source limitations rather than assuming logs contain unavailable facts.

## Verification

Review the examples against the current contract and audited source behavior. No production changes are required.

Apply the common completion requirements in the [backlog index](README.md). Completion evidence is recorded below.

## Starting points

- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/usage-system.md](<../../docs/usage-system.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [lib/telemetry-contract.ts](<../../lib/telemetry-contract.ts>)

## Execution record

Completed September 13, 2026.

- Added [`CONTEXT.md`](../../CONTEXT.md) with the canonical Usage vocabulary and distinctions between model calls, tool invocations, spawns, observed subagents, allowances, estimates, and unknown/unattributed states.
- Added [`docs/usage-metric-contract.md`](../usage-metric-contract.md) with metric definitions, synthetic edge cases, per-family source precedence, overlap rules, filter/resolution support, America/Chicago display-time rules, coverage denominators, initial UI defaults, and the stable environmental classification cohort.
- Chose coarse hourly buckets as the token-total authority until request detail is explicitly complete and reconciled for the same coverage slice. Detailed rows can supply supported breakdowns in the meantime but are never added to the bucket total.
- Kept the optional compensation-dollar decision isolated in USG-034 so it does not block physical environmental estimates or actionable recommendations.
- Defined reported-total normalization, inconsistent composition, explicit success, aggregate requests, root conversations, wrapper counting, Unassigned project, half-open activity time, logical-versus-observation identity, provider event/query identity, report-subject crosswalks, and two-stage coverage (`E/H` and `S/E`).

Verification: reviewed the contract against `lib/telemetry-contract.ts`, `lib/usage-contract.ts`, canonical queries in `lib/telemetry-store.ts` and `lib/usage-store.ts`, the monthly parser, and the documented source limitations. The final documentation check resolved all 230 relative links across the direction, contract, audit, evidence, and task-index set. No runtime or production state changed for this task.
