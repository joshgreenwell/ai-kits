# USG-028: Implement the Codex account allowance reader

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Refresh account windows through a verified supported account interface, reducing dependence on new rollout events.

## Current gap

`app_server` is implemented in this checkout through `codex app-server`. `web_backend` stays unimplemented. No real authorized app-server reading has been stored or shown, so the task stays Planned.

## Acceptance criteria

1. Inspect current installed interface/documentation and source fixtures to select a supported account reader; document eligibility and prerequisites.
2. Implement account identity verification, relevant allowance windows/reset anchors, source observation timestamps, timeouts, and bounded retry behavior.
3. Define precedence/deduplication against embedded and browser readings without adding overlapping meters or manufacturing sample times.
4. Respect existing authentication ownership and local secret handling; expose unavailable/expired/unrecognized states rather than falling back silently to a different account.
5. Enable the matching settings option only after a real account reading is stored and displayed; preserve unsupported alternatives as unavailable.

## Verification

Test multiple limit IDs including Spark, changed sign-in, stale/failed responses, equivalent embedded readings, and a real supported account refresh.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/codex_account.rs](<../../companion/crates/observatory-adapters/src/codex_account.rs>)
- [companion/crates/observatory-core/src/process.rs](<../../companion/crates/observatory-core/src/process.rs>)
- [companion/crates/observatory-adapters/src/readings.rs](<../../companion/crates/observatory-adapters/src/readings.rs>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

In source as of 2026-09-17. Status stays Planned: criterion 5 requires a real account reading stored and displayed before treating the setting as production-ready.

- Decisions: `codex_account` talks to `codex app-server` with Content-Length JSON-RPC and NDJSON fallback, method `account/rateLimits/read`, including `rateLimitsByLimitId`. Meter keys stay `<limit_id>:<minutes>` so they match the embedded reader. Child processes start with `CREATE_NO_WINDOW`. Timeout is clamped to 1–15s of remaining run time. Emission is only to the single confirmed Codex identity; missing identity is `identity_changed`, not a fallback to the first binding. `web_backend` still preflights `not_implemented`. `codex_execution` continues to report the Codex `allowance` capability row, including `reader_fallback_embedded` while `app_server` is selected, because embedded remains a by-product of the rollout scan. `codex_account` does not emit its own allowance capability row.
- Checks: parse-only fixture `tests/fixtures/usage-v2/provider/codex-rate-limits.json`. Collect tests do not spawn a live app-server.
- Blocker: no real authorized app-server receipt. `web_backend` remains unimplemented.
