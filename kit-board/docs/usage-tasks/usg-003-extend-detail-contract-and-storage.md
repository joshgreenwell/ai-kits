# USG-003: Extend the usage contract and storage for the missing attribution detail

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 1. Foundations
Dependencies: [USG-001](usg-001-metric-and-source-contract.md)
Created: 2026-09-13

## Outcome

Provide a compatible representation for pricing evidence, independent agent/tool events, resource access, and coverage.

## Current gap

The request contract lacks retained effort/tier/context dimensions and complete agent/resource attribution; some tools/spawns occur without a token-bearing request.

## Acceptance criteria

1. Specify nullable pricing, independent reported-total/unclassified/inconsistent token state, typed Unknown values, agent identity/parent/class/depth, project identity basis, tool invocation/outcome, and resource-access fields or linked event records. Represent explicit zero-usage calls and tool/spawn events even when no token-bearing record follows.
2. Define stable identities and joins for deduplication, retries, nested agents, multiple calls/results, record revisions, and events lacking parent or token evidence.
3. Update the TypeScript authority, generated and vendored schemas, Rust contract, validation, storage mapping, and append-only migrations together; explicitly choose compatibility/version negotiation for existing installs.
4. Keep missing fields unknown, reasoning within output, private resource paths/content local, and unsupported attribution visible through coverage.
5. Preserve authentication, same-origin mutations, restricted grants/RLS, revision semantics, and browser allowance-only ingestion boundaries.

## Verification

Run focused cross-language wire and store tests for old/new payloads, invalid data, duplicate identities, orphan events, permission boundaries, and migration compatibility. All fixtures are synthetic or sanitized with provenance.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [lib/generated/usage-v2.schema.json](<../../lib/generated/usage-v2.schema.json>)
- [companion/crates/observatory-contract](<../../companion/crates/observatory-contract>)
- [scripts/build-usage-schema.mjs](<../../scripts/build-usage-schema.mjs>)
- [tests/fixtures/usage-v2](<../../tests/fixtures/usage-v2>)
- [supabase/migrations](<../../supabase/migrations>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
