# USG-014: Make collection settings, cadence, and health reflect actual capabilities

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P1
Scope: Core
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md)
Created: 2026-09-13

## Outcome

Make it clear which details are being collected and whether configured changes actually took effect.

## Current gap

Some settings expose unimplemented readers, cadence edits do not update installed schedules, and coverage-only runs can appear healthy.

## Acceptance criteria

1. Advertise implemented capabilities by adapter/build and make unavailable readers/features visibly unsupported rather than presenting them as working setup options.
2. Distinguish pairing, account binding, verified sign-in, successful adapter execution, actual records, and data freshness. Report detailed publication health separately while the bridge remains.
3. Make request/tool/project/resource detail preferences and local deny rules observable through effective settings and per-install acknowledgements.
4. Reconcile desired cadence with the installed service schedule, either applying it through a supported mechanism or showing the exact required local action and pending state.
5. Expose per-provider last observation, record counts by fact type, error category, accepted settings version, backfill state, and rejected records without leaking private inputs.

## Verification

Exercise unsupported adapters, coverage-only success, denied detail, account changes, cadence mismatch, adapter failure, rejected uploads, and differing client builds with the same nominal version.

Apply the common completion requirements in the [backlog index](README.md).

## Starting points

- [lib/companion-settings.ts](<../../lib/companion-settings.ts>)
- [components/companion-installs.tsx](<../../components/companion-installs.tsx>)
- [companion/crates/observatory-core/src/service.rs](<../../companion/crates/observatory-core/src/service.rs>)
- [companion/crates/observatory-core/src/effective.rs](<../../companion/crates/observatory-core/src/effective.rs>)
- [companion/crates/observatory-adapters/src/stubs.rs](<../../companion/crates/observatory-adapters/src/stubs.rs>)
- [app/api/collection-settings/route.ts](<../../app/api/collection-settings/route.ts>)

## Execution record

Completed on `kit-board/usg-014-truthful-settings-health` on September 14, 2026.

- Decisions: capability is evidence the build reports, never a table the site maintains. The companion posts a strict `CapabilitiesDocument` (`companion/crates/observatory-contract/src/capabilities.rs`, zod authority `lib/companion-capabilities.ts`, byte-checked synthetic corpus under `tests/fixtures/usage-v2/capabilities/` from `companion/scripts/fixtures.py`) after every online run and forced on `setup` / `service install` / `service uninstall`; codes, counts, and ids only, so `deny` is a list of dotted mode paths (`ModePath`) and a path-bearing field is rejected on both sides. The server never rewrites an OS schedule: the companion reads the installed job back (`observatory_core::service::installed_schedule`, Task Scheduler XML repetition interval, launchd `StartInterval`, systemd `OnUnitActiveSec`) and the server decides `pending` against the desired cadence, showing the exact `observatory service install --config-dir` action. Settings controls are never disabled; each value that needs an adapter mode or feature carries a `requires` entry in `settingsMatrix` and `optionSupport` labels it `supported n/m`, `unsupported`, or `unverified` from the installs' current reports (a report counts only while it names the install's last-seen version and is under fourteen days old). The default Codex reader is `embedded`, the implemented one, and `setup` no longer prompts for the stub private-interface readers. A panicking adapter reports a `failed` coverage row with the new `adapter_panicked` detail.
- Companion: `observatory_core::run` computes the schedule verdict and the document (`capabilities_document`, `report_capabilities` with a change digest that excludes queue depth and a daily heartbeat, `capabilities_last_digest` / `capabilities_last_posted_at` in meta), skips the post on dry runs and `--offline`, and reports `capabilities` and `schedule` in the run summary; `service`, `status`, and `doctor` print the same verdict; `http::post_capabilities` carries the document. Contract newtypes `ModePath`, `MachineId`, `IsoDate`; `DetailCode::AdapterPanicked`; `Settings::defaults().codex_reader = Embedded`.
- Server: migration `20260914020000_companion_capabilities.sql` adds `capabilities`, `capabilities_digest`, `capabilities_previous_digest`, `capabilities_reported_at`, and `capabilities_changed_at` to `companion_installs` (no new grants); `POST /api/v1/companion/capabilities` stores the validated document through `usageStore.reportCapabilities`; `listInstalls` derives `capabilities` (validity reason `never_reported` / `version_mismatch` / `stale`), `schedule` (installed versus desired interval, cadence basis, pending), and `health` (pairing, binding, identity, execution, records, coverage-only, overdue, last contact); rejected records are counted by reason (`rejected:<reason>`) beside the per-type totals.
- Site: Usage → Settings shows support chips beside every requirement-bearing value and a per-install table (applied settings version, effective settings, local deny list, schedule verdict); Connections renders the health ladder, the capability line (version, digest, schedule, queue, backfill), rejection reasons, per-binding detailed-report status, and the pending-cadence action.
- Synthetic coverage: `companion/crates/observatory-contract/tests/capabilities.rs` and `tests/companion-capabilities.test.ts` walk the valid and invalid corpus (private path field, free-text deny entry, unknown adapter, wrong schema version) and the option-support states; `observatory_core::run` tests cover the document's contents, the unchanged-post skip, the dry-run skip, and the panicking adapter; the schedule read-back parsers have unit tests (`PT1H`, `PT15M`, launchd, systemd); `tests/security.test.ts` covers the proxy allowlist; `tests/usage-store.integration.test.ts` exercises never-reported, reported, path-bearing rejection, digest flip, cadence mismatch pending, version mismatch, and rejection reasons.
- Verification on September 14, 2026 (Windows host, Docker Desktop): in `kit-board/companion`, `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (220 passed), `python scripts/fixtures.py check`, `cargo deny check`, and the byte comparison of the vendored schema; in `kit-board`, `npm test` (98 tests, 94 passed, 4 database-gated skips), `npm run typecheck`, `npm run build`, `npm run test:db` (12 migrations applied, integration suites passed), and `git diff --check`.
- Remaining notes: production needs the `20260914020000` migration and the server deployed before a companion carrying the report is installed (the post fails soft until then, and both installs read `unverified` in the meantime). Cadence is applied by the local action only; applying it through the scheduler from the site remains out of scope. The v2 browser rows carry no requirement because that collector has not shipped.
