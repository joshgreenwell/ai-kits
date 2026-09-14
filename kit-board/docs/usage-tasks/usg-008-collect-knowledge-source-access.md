# USG-008: Identify access to multiple vaults and configured knowledge sources

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
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

Apply the common completion requirements in the [backlog index](README.md). Completion evidence is recorded below.

## Starting points

- [docs/usage-direction.md](<../../docs/usage-direction.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [companion/crates/observatory-core/src/config.rs](<../../companion/crates/observatory-core/src/config.rs>)
- [companion/crates/observatory-contract/src/settings.rs](<../../companion/crates/observatory-contract/src/settings.rs>)
- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>)

## Execution record

Completed on `kit-board/usg-008-knowledge-source-access` on September 14, 2026.

- Decisions: the collection-settings document and the wire contract are unchanged. Knowledge sources are local configuration (`companion.json` `resources`: `key`, `label`, `roots`, `connectors`, `source`), rows ride on `execution.detail_level` `requests_with_tools`, and the local deny entry `execution.resource_attribution` keeps them on the machine at emit and upload time. The uploaded `configuration_version` is an opaque token (`cfg:` plus sixteen random hex digits the state assigns on first sight of a source's own configuration digest), so nothing derived from a root leaves the machine and an unrelated source does not re-version another. Server identities are scoped per `(install_id, resource_key)` with the version as sighting metadata. Any change to a source purges the binding's local resource rows in the same transaction as its file checkpoints and replays retained transcripts; queued rows under an earlier token or a removed key are marked `superseded_configuration` and never upload.
- Companion: `observatory-core` gains `LocalResource` validation, `ResourceConfiguration` (normalized roots with MSYS and WSL aliases, per-resource and whole-configuration digests, `~/` against the run's home), the deny helper, state schema 7 (`local_resource_accesses`, `local_resource_inspections`, random configuration tokens in `meta`, purge-with-scan, read-only open), and the upload-time supersession policy. `observatory-adapters` gains the classifier (Claude dispatch by raw tool name including `PowerShell` and `NotebookRead`; Codex `shell_command`, `exec_command`, `local_shell_call`, `apply_patch`, `view_image`, MCP namespaces, and `tools.*` calls parsed out of `exec` scripts; conservative shell tokenization with heredoc stripping, `cd` tracking, and the bare-name rule; component-prefix matching with case decided by path form), the per-scan token map, row and inspection bookkeeping, `resource.access` emission with the invocation's outcome and subagent rule, and the `resource` capability (`detail_level`, `denied_locally`, `no_resources_configured`, `unsupported_forms`, `unresolved_paths`, `ambiguous_connectors`, `scan_partial`); the execution parser version moves to `+v1.1.0-detail5`. The binary gains `observatory resources [add|remove]`, Obsidian vault discovery and the `setup` proposal (`obsidian.<vault id>`, folder name as the local label, never under `--yes`), and the `doctor` fields `resources_configured`, `resources_invalid`, `obsidian_config_found`, `resource_attribution_effective`, and `resource_attribution_reason`.
- Server: migration `20260914003000_knowledge_source_registry.sql` adds `usage_knowledge_sources`, install-scoped `usage_knowledge_source_identities`, append-only `usage_knowledge_source_mapping_revisions`, a backfill from retained `resource_accesses`, and the `security_invoker` view `resource_access_source_resolution` with Source, Unassigned, and Unknown states and a `current_configuration` flag. `ingestUsage` upserts identity sightings before inserting accesses; `listKnowledgeSources` reports per-identity and per-source counts over current-configuration rows only, earlier-configuration rows separately, overlap as access rows against distinct invocations, mapping and resolution coverage, and the latest `resource` capability per install and adapter; `updateKnowledgeSources` creates, renames, maps, and unmaps through the authenticated same-origin `/api/usage-knowledge-sources` route.
- Synthetic coverage (`tests/fixtures/usage-v2/resource-detail/`, `companion/crates/observatory-adapters/tests/resource_access.rs`, and the web integration suites): two sources with nested roots and a Windows root, explicit read, write, and search arguments, relative paths from `cwd` and `workdir`, MSYS and unquoted PowerShell forms, `cd` chains that keep or lose the base, heredocs, `python -c` bodies, an opaque `Workflow` tool, Codex `exec` scripts calling `tools.shell_command`, `tools.apply_patch`, and `tools.view_image`, direct `apply_patch` headers, `exec_command` and `local_shell_call` forms, a connector configured once and one configured twice, a `WebFetch` prefix, a `Grep` without a path inside a vault, a read outside every root, failed, denied, and missing results, duplicate replay, a sidechain call under both subagent settings, the deny entry, each detail level, no configured sources, a configuration change with purge and replay, root sentinels absent from resource rows, records, and the outbox and file-name sentinels absent from the whole database, and, on the server, two installs sharing `obsidian.primary`, map, rename, and unmap, overlap of three rows over two invocations, stale-configuration exclusion, the migration backfill by receipt order, and the application role's append-only limits.
- Verification on September 14, 2026 (Windows host, Docker Desktop engine 28.3.0): `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (171 passed across 14 suites, 0 failed), `python scripts/fixtures.py check`, and `cargo deny check` (advisories, bans, licenses, sources ok) passed in `kit-board/companion`; `npm test` (83 tests, 79 passed, 0 failed, 4 database-gated skips), `npm run typecheck`, `npm run build`, `npm run test:db` (10 migrations applied on `postgres:17-alpine`, database integration passed), the usage-schema byte compare (`schema-identical`), and `git diff --check` passed in `kit-board`. A manual binary run on the fixture corpus emitted 25 `resource.access` records at `requests_with_tools` and none at the defaults, kept file-name sentinels out of the state database and root strings out of the resource tables, records, and outbox, superseded a removed source's rows and re-versioned the remaining source, and held rows pending under the deny entry. A five-lens read-only review with adversarial verification then raised eleven findings (argv re-quoting through the lexer, a computed exec `workdir` falling back to the turn's `cwd`, `bash -e` read as an encoded command, `Push-Location`, `rg --files`, unquoted `-Command` bodies, `<<` inside quoted script text, REPL tools under other MCP servers, queued rows surviving a parser-only replay, the scan digest depending on the run's home, and a vacuous records/outbox assertion); each was fixed with a regression test and every suite above was rerun green.
- Remaining notes: the UI is USG-015 and USG-022; no Obsidian MCP server is configured on a collected machine, so the connector path is exercised by fixtures only; symlinks and junctions are not resolved; a removed source stops future uploads but rows the server already holds are not retracted; `observatory resources` opens the state read-only and reports a pending migration until the next run upgrades an older state file. No production collection run or deployment was performed for this local implementation.
