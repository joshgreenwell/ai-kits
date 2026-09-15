# USG-020: Build environmental impact using existing estimates and actionable recommendations

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
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

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
