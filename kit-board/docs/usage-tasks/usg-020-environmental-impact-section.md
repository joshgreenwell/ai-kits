# USG-020: Build environmental impact using existing estimates and actionable recommendations

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P1
Scope: Core
Stage: 4. Interface
Dependencies: [USG-013](usg-013-reuse-cost-and-environment-calculations.md), [USG-017](usg-017-tokens-overview-and-daily-volume.md), [USG-019](usg-019-environmental-action-recommendations.md)
Created: 2026-09-13

## Outcome

Make environmental cost visible alongside financial cost for the selected activity.

## Current gap

The section needs to survive the report-pipeline replacement and add usable reduction/compensation guidance.

## Acceptance criteria

1. Place a visible environmental section after tokens by model and before the project/agent cards, with electricity, direct-water, and operational-carbon summaries side by side where space allows.
2. Show the current planning values, alternative scenarios, units, familiar comparisons, and 10% comparable-call reduction outputs from USG-013.
3. Provide concise visible estimation context and expandable scope, methodology version, sources, and assumptions; scenario ranges are not confidence intervals or guaranteed physical bounds.
4. Apply the shared filters and disclose missing call evidence or historical granularity; never substitute an unfiltered monthly estimate into a project/model view.
5. Present the concrete actions from USG-019 separately from the estimated footprint. Recommendations or link clicks do not reduce displayed impact or mark compensation complete.

## Verification

Check identical-input parity with the existing section, filters/unknown evidence, units and rounding, scenario labels, recommendation destinations, keyboard/touch use, and narrow-screen layout.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [lib/environmental-factors.json](<../../lib/environmental-factors.json>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Completed September 15, 2026 after completing the USG-019 recommendation dependency.

- `components/environmental-impact.tsx` renders the selected query result's planning electricity, direct-water, and operational-carbon quantities side by side, with alternative floor/upper scenarios and familiar comparisons. The section follows Tokens by model and stacks naturally on narrow screens.
- The visible context states that these are inference-equivalent scenarios with unknown hardware, datacenter, grid, cooling, and water source, and that the range is neither a confidence interval nor a physical guarantee. Expandable detail retains methodology versions, cohort classification, scope, factors, assumptions, and primary sources.
- Estimation coverage comes from the same filtered result. Calls without a class are named and excluded rather than filled with monthly or allowance data; provisional and stored cohorts remain visible.
- Actions are visually and semantically separate from the footprint: the existing comparable-workload 10% reduction output, Climeworks future-delivery carbon removal, BEF Jordan River catchment-specific water restoration, and Rewiring America efficiency/electrification support. Link clicks, purchases, contributions, promised delivery, retirement, and completed removal are explicitly distinct and never mutate the estimate.
- Research provenance is in [USG-019 evidence](../usage-evidence/usg-019-2026-09-15.md); concise product copy is in `lib/environmental-actions.ts`. No compensation-dollar calculator, automated transaction, action ledger, or neutrality claim was added.
- Focused rendering/calculation checks and TypeScript passed as recorded in USG-018. The test fixture covers units and rounding, selected-scope values, the 10% output, recommendation destinations, and the unchanged card order. No production receipt or deployment is claimed.
