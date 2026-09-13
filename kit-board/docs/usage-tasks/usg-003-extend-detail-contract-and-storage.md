# USG-003: Extend the usage contract and storage for the missing attribution detail

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Apply the common completion requirements in the [backlog index](README.md).

## Starting points

- [lib/usage-contract.ts](<../../lib/usage-contract.ts>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [lib/generated/usage-v2.schema.json](<../../lib/generated/usage-v2.schema.json>)
- [companion/crates/observatory-contract](<../../companion/crates/observatory-contract>)
- [scripts/build-usage-schema.mjs](<../../scripts/build-usage-schema.mjs>)
- [tests/fixtures/usage-v2](<../../tests/fixtures/usage-v2>)
- [supabase/migrations](<../../supabase/migrations>)

## Execution record

Completed September 13, 2026 in the repository.

- Kept envelope `schema_version: 2` and `/api/v1/usage`. Request pricing, token accounting, agent attribution, explicit project state, and adapter capability coverage are optional outer blocks whose inner fields are strict. An absent block means an older producer did not report the capability.
- Added independent `agent.event`, `tool.event`, and `resource.access` records to the TypeScript authority, generated schema, vendored schema, and Rust contract. Stable semantic keys exclude binding and observation identity. Invocation/result rows share an invocation key while retaining distinct event keys, so retries, revisions, several results, and orphan evidence remain representable without increasing the invocation count.
- Added reported-total, unclassified, complete/partial/inconsistent/unknown accounting rules. Positive unclassified remainders reconcile to the reported total, and reasoning remains a non-additive output subset and a lower bound on any reported total. Explicit component zeroes are retained as a call; missing evidence remains null or a typed Unknown state.
- Added privacy-safe agent/project/resource fields. Raw resource paths, arguments, results, and content fail the strict wire schema. No semantic join has a database foreign key because a parent or token row may be unavailable.
- Added `20260913230451_extend_usage_detail_contract.sql`. It leaves legacy extension columns null, preserves the old provider-dimension hash when pricing is absent or all null, adds generated activity/observed-total columns, creates the three append-only event ledgers, and grants `personal_hub_app` only select/insert access to them under RLS. The new provider reasoning-subset check is enforced for new writes but left unvalidated so a legacy row accepted by the prior schema cannot block the additive upgrade.
- Updated ingestion to store every new field and event, reject identifiable invalid records independently, and permit browser installs to ingest only `allowance.reading`. Existing v2 fixtures and producers remain valid.
- Added synthetic cross-language fixtures for pricing, zero/derived/total-only/inconsistent accounting, positive remainders, reasoning-only lower bounds, nested and rejected agent events, invocation revisions and multiple/orphan results, overlapping resources, capability coverage, explicit-null parity, and invalid privacy/identity/state combinations.

Verification passed: `npm test` (75 passed, four database-only skips), `npm run test:db` (all eight migrations and the database integration suite), `npm run typecheck`, `npm run build`, `python companion/scripts/fixtures.py check`, `cargo test --workspace` (64 tests), `cargo fmt --all --check`, and `cargo clippy --workspace --all-targets -- -D warnings`. Direct PostgreSQL probes also covered a preexisting legacy reasoning-subset violation, deferred constraint validation, new-write enforcement, accounting and identity constraints, the project-alias null edge, semantic event constraints, grants, and RLS.

The server migration must deploy before a companion emits the new variants because v2 has no runtime negotiation. USG-004 through USG-008 own actual request/pricing, agent, tool, project, and knowledge-source collection; USG-025 owns production activation and end-to-end release evidence.
