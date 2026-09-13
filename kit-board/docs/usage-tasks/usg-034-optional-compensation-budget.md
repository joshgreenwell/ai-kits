# USG-034: Add an optional environmental compensation budget if selected

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Decision pending
Priority: P3
Scope: Decision pending
Stage: 8. Optional environmental work
Dependencies: [USG-019](usg-019-environmental-action-recommendations.md), [USG-020](usg-020-environmental-impact-section.md)
Created: 2026-09-13

## Outcome

Translate a chosen compensation action into a transparent estimated dollar budget.

## Current gap

The user has not yet selected whether environmental cost includes compensation dollars in addition to physical estimates and recommendations.

## Acceptance criteria

1. First record the user's choice about including the budget; do not treat elapsed time or task creation as approval of this optional feature.
2. If selected, show the chosen scenario, physical quantity, sourced unit rate, currency, price date, program, and material fees/minimums.
3. For carbon, calculate from scenario kg CO2e converted to tonnes and the quoted per-tonne price. Only use volumetric water/electricity prices where the selected program supports a defensible unit.
4. Use contribution guidance when no comparable unit price exists; never turn unrelated physical categories into a single claimed offset quantity.
5. Keep estimated impact, proposed budget, purchased support, promised delivery, and verified removal distinct. No automatic transactions or compensation ledger is included.

## Verification

After selection, verify unit conversion, rounding/minimums, missing/stale prices, scenario changes, and persistent footprint display. If declined, mark this task Cancelled with the decision.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [app/(private)/usage/environmental-factors.json](<../../app/(private)/usage/environmental-factors.json>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
