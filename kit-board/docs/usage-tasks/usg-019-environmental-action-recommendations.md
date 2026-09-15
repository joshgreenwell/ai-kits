# USG-019: Research concrete environmental reduction and compensation recommendations

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P1
Scope: Core
Stage: 3. Read models
Dependencies: [USG-001](usg-001-metric-and-source-contract.md)
Created: 2026-09-13

## Outcome

Supply usable, evidence-backed recommendations beside the reused footprint estimates.

## Current gap

The current environmental section offers comparisons and a tree example, but no researched set of actionable compensation destinations.

## Acceptance criteria

1. Identify currently usable carbon-removal, water-stewardship, and clean-energy/efficiency options appropriate for a personal user; use current primary program sources and record the verification date.
2. For each selected option, record a concrete destination, purpose, relevant unit, availability, geographic scope, delivery timing, evidence/verification basis, and material minimums or fees where disclosed.
3. Prefer transparent additionality, durability, quantification, verification, and retirement evidence for carbon options; distinguish paid commitments from completed removals.
4. Explain water benefits in their catchment context and electricity instruments in their own units. Do not promise to reverse the impact at an unknown datacenter or make a neutrality claim.
5. Retain the existing modeled 10% call-reduction example. Deliver recommendation content usable without a dollar calculator; price-budget arithmetic is conditional USG-034.

## Verification

Review every displayed recommendation against its direct source and available purchase/support path. Research completion does not initiate a purchase or validate a new footprint model.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [lib/environmental-factors.json](<../../lib/environmental-factors.json>)

## Execution record

Completed September 15, 2026 as the research dependency required to finish USG-020.

- Primary-source research and claim-state rules are recorded in [the dated evidence note](../usage-evidence/usg-019-2026-09-15.md). It selected Climeworks Technology focus for future durable-removal delivery, BEF's Jordan River Water Restoration Certificate for a named catchment, and Rewiring America for unquantified U.S. electrification/efficiency support.
- `lib/environmental-actions.ts` carries the concise UI copy, direct destinations, units, availability, geography, delivery/evidence boundaries, and caveats. The full note retains disclosed prices, minimums, fees, candidate rejections, and recheck requirements without turning them into the optional budget arithmetic owned by USG-034.
- The recommendation states distinguish contribution, purchase, commitment, delivery, and retirement. No order, donation, automated checkout, compensation ledger, or neutrality claim was made.
- Direct program, registry/standard-owner, WRI, DOE, and EPA pages were checked September 15. Recommendation rendering and link coverage are verified with the USG-020 tests; live availability must still be rechecked before each release because these are external programs.
