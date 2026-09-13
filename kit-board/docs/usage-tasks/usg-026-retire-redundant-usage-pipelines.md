# USG-026: Retire superseded usage publishers, collectors, and schedules after parity

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P1
Scope: Core
Stage: 5. Cutover
Dependencies: [USG-002](usg-002-preserve-history-and-recover-publication.md), [USG-010](usg-010-replace-browser-quota-bridge.md), [USG-011](usg-011-reconcile-historical-ledgers.md), [USG-025](usg-025-activate-backfill-and-verify-release.md)
Created: 2026-09-13

## Outcome

Finish the transition to normal collection without losing history or leaving failing duplicate jobs.

## Current gap

The audit records dead local schedules, a live v1 browser bridge, separate usage automations, old-site sync, and analyzer/harvest dependencies.

## Acceptance criteria

1. Use the retirement runbook and exact current inventories to stop/remove only superseded usage responsibilities after backup, history parity, rich-detail replacement, and scheduled receipts pass.
2. Cover Windows/macOS and any used Linux/WSL services, usage-specific app automations, Claude local/remote/session/Cowork schedules, hosting sync, and exact browser extension profiles; record unreachable surfaces as remaining work.
3. Preserve or replace the analyzer ledger-harvest responsibility before removing its jobs. Retain complete historical reports and original provenance even though future views no longer require monthly publication.
4. Remove obsolete ingress/UI/runtime code and dedicated credentials only after their last dependent source is replaced. Keep the current companion, provider-owned histories, reset/release schedules, and unrelated report pipelines.
5. Update operating docs with one current usage workflow and retained historical exceptions; search for still-active old commands and confirm they no longer run.

## Verification

Verify absence of exact retired jobs/receipts, successful retained schedules, history visibility, recovery availability, auth/ingest behavior, and current documentation. Do not mark complete while an uninspected host may still run a required retirement target.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [docs/usage-v1-retirement.md](<../../docs/usage-v1-retirement.md>)
- [docs/usage-system.md](<../../docs/usage-system.md>)
- [docs/agent-handoff.md](<../../docs/agent-handoff.md>)
- [docs/schedules.md](<../../docs/schedules.md>)
- [docs/usage-collection.md](<../../docs/usage-collection.md>)
- [scripts/telemetry](<../../scripts/telemetry>)
- [browser/claude-quota](<../../browser/claude-quota>)

## Execution record

Unstarted. Record changed files, decisions, focused checks, scoped receipts, and remaining blockers here when this task is executed.
