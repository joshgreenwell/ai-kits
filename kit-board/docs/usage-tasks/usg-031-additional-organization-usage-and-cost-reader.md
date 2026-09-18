# USG-031: Implement Anthropic organization usage and cost collection

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-012](usg-012-unified-filtered-usage-queries.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Collect actual organization API usage/cost with the provider's supported grouping and price dimensions.

## Current gap

The organization adapter is implemented in this checkout. Settings and contracts still do not by themselves provide billed production usage; the task stays Planned until a verified authorized receipt exists.

## Acceptance criteria

1. Verify current official usage/cost APIs, eligible access, response fixtures, and workspace/key/model/tier/context dimensions before implementation.
2. Implement checkpointed, paginated usage and money collection with stable identities, corrections, observation/receipt separation, and scoped account mapping.
3. Keep aggregate usage, local request observations, actual charges, and API-equivalent estimates separate while reconciling overlap.
4. Respect Admin credential boundaries and report missing permission/unsupported dimensions; do not imply API reports measure individual subscription usage.
5. Record a verified authorized collection and applicable UI reconciliation when access exists; otherwise leave the actual dependency visible and the task unfinished.

## Verification

Cover provider fixtures, pagination, duplicate/revised periods, context/tier cases, missing dimensions, auth failure, and a provider-reported-period comparison.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/anthropic_api.rs](<../../companion/crates/observatory-adapters/src/anthropic_api.rs>)
- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

In source as of 2026-09-17. Status stays Planned: criterion 5 needs a verified authorized collection.

- Decisions: `GET https://api.anthropic.com/v1/organizations/usage_report/messages` and `/v1/organizations/cost_report` with the Admin key from `secrets.json` (`anthropic-version: 2023-06-01`). HTTPS only; 401/403 unauthorized, 429 rate limited. Cost `amount` is a cents decimal string. Identity is none: each runnable org binding receives a copy. These reports are API spend only, never Pro or Max subscription usage. Parser `2.0.0+admin-usage1`.
- Checks: parse fixtures `tests/fixtures/usage-v2/provider/anthropic-usage.json` and `anthropic-costs.json`. Collect tests do not hit the live Admin API.
- Blocker: no real authorized organization receipt. An Admin key is required and is not present in the committed tree. Individual Console accounts cannot use this API.
