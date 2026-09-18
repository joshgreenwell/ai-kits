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

The organization adapter is implemented in this checkout. Aggregate/money ledgers still have no verified ingested production data, so the task stays Planned.

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

- [companion/crates/observatory-adapters/src/openai_api.rs](<../../companion/crates/observatory-adapters/src/openai_api.rs>)
- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

In source as of 2026-09-17. Status stays Planned: criterion 5 needs a real authorized organization-period receipt.

- Decisions: `GET https://api.openai.com/v1/organization/usage/completions` and `/v1/organization/costs` with the Admin key from `secrets.json`. HTTPS only; 401/403 unauthorized, 429 rate limited. Checkpointed `PageCursor` JSON. `measures.input_tokens` is exclusive fresh because complete-state sums exclusive classes. Identity is none: each runnable org binding receives a copy. Codex ChatGPT-plan usage is not in these reports. Tokens query unions `account_usage_buckets` with local hours and never sums them as the same work. Parser `2.0.0+admin-usage1`.
- Checks: parse fixtures `tests/fixtures/usage-v2/provider/openai-usage.json` and `openai-costs.json`. Collect tests do not hit the live Admin API.
- Blocker: no real authorized organization receipt. An Admin key is required and is not present in the committed tree.
