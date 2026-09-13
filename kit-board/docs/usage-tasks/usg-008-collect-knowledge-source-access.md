# USG-008: Identify access to multiple vaults and configured knowledge sources

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P0
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md)
Created: 2026-09-13

## Outcome

Measure observed access to each named vault or knowledge source across machines.

## Current gap

The monthly brain counters are specialized; normal collection has no configurable resource identities or evidence-based access records.

## Acceptance criteria

1. Add stable named source definitions with multiple local roots and/or connector resource identifiers; roots remain local while the app stores permitted IDs and labels.
2. Match supported read/search/write paths and explicit shell/MCP resource evidence to the correct source, normalizing relative paths and platform separators without broad substring matches.
3. Distinguish direct access, attempted searches, indirect shell evidence, failed/unknown outcomes, and unrecognized access. Being inside a vault directory alone does not attribute every call to that vault.
4. Link accesses to invocation/session/agent identities. Count an invocation once globally and disclose overlap when it accesses several resources or nested roots.
5. Supply per-resource counts and detection coverage without claiming that retrieved information was used in the answer or assigning exact token costs to resource results.

## Verification

Use two vaults across two machines, overlapping roots, relative paths, shell wrappers, unsupported indirect access, connector ambiguity, false-positive directory-only cases, and privacy-mode fixtures.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [companion/crates/observatory-core/src/config.rs](<../../companion/crates/observatory-core/src/config.rs>)
- [companion/crates/observatory-contract/src/settings.rs](<../../companion/crates/observatory-contract/src/settings.rs>)
- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
