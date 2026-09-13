# USG-002: Preserve usage history and recover missing current collection evidence

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: In progress
Priority: P0
Scope: Core
Stage: 1. Foundations
Dependencies: None
Created: 2026-09-13

## Outcome

Establish a restorable baseline and recover the known Windows reporting gap while the replacement is built.

## Current gap

The September 13 audit recorded missing Windows September reports, a failed detailed upload, retained v1-only history, and incompletely verified schedules.

## Acceptance criteria

1. Recheck the dated audit on each accessible machine/account; inventory exact current collectors, report publishers, harvesters, schedules, source ranges, and pending outcomes. Record inaccessible hosts explicitly.
2. Create private database and machine-state backups outside Git, including SQLite WAL-safe copies, retained analyzer ledgers, artifacts, outboxes, receipts, and scheduler definitions; demonstrate restoration in an isolated environment.
3. Diagnose the Windows detailed upload failure, preserve and reconcile its pending artifact/receipt before retrying, and restore the configured publication path with an authenticated receipt.
4. Establish intended Claude/other machine-provider publication coverage and preserve the existing ledger harvest until continuous collection replaces it. Recover available missed periods without inventing absent detail.
5. Produce a sanitized before/after baseline by account, source, period, model, token categories, and report identity, including the documented v1-only keys and disabled-source quota history.
6. Use the existing detailed path only for recovery/continuity during transition; do not introduce a new permanent report scheduler.

## Verification

Show backup restoration, canonical reconciliation, an actual recovered publication receipt, and the next scheduled outcome where accessible. Keep private identifiers and contents out of committed evidence.

Apply the common completion requirements in the [backlog index](README.md). Completion requires the remaining inaccessible-host inventory, natural scheduled occurrence, and full historical reconciliation described below.

## Starting points

- [docs/usage-system.md](<../../docs/usage-system.md>)
- [docs/usage-v1-retirement.md](<../../docs/usage-v1-retirement.md>)
- [docs/schedules.md](<../../docs/schedules.md>)
- [scripts/telemetry/detailed_report.py](<../../scripts/telemetry/detailed_report.py>)
- [companion/crates/observatory-core/src/detailed.rs](<../../companion/crates/observatory-core/src/detailed.rs>)

## Execution record

Started September 13, 2026. See the [sanitized recovery evidence](../usage-evidence/usg-002-2026-09-13.md).

- Inventoried the accessible Windows companion, detailed publisher, two retained v1 collectors, their scheduler definitions, and the production database. Recorded the Mac and exact browser hosts as inaccessible rather than inferring coverage.
- Created a private backup outside Git with a complete per-file hash manifest. WAL-safe backups of three SQLite databases passed isolated integrity and schema checks; all three scheduler definitions parsed from the restored copy.
- Exported the production schema and 2,906 rows across 19 tables. An isolated PostgreSQL 17 restore applied the six production migrations and matched every source row count and ordered checksum with constraints active.
- Reconciled the accessible Windows v1 histories against v2. All 17 Claude keys matched exactly. All 135 Codex keys overlapped; 134 matched exactly and the current hour was larger in the later v2 scan. V2 retained 447 additional Codex keys.
- Preserved the exact failed detailed artifact, confirmed it parses locally and stayed byte-identical through nine retries, and confirmed its idempotency/content identity was absent from production before retry.
- Diagnosed the current failure as HTTP 401 caused by a publisher key absent from the deployed credential set. Added a tested usage-only additive credential path so recovery did not overwrite the non-readable primary hosting secret, plus source-tested bounded publisher and scheduled-companion HTTP diagnostics. The isolated release contained only the authentication change; the installed Windows companion binary was not replaced in this pass.
- Reconstructed the active deployment source into an isolated private release because its dirty source could not be reproduced from Git alone. All 255 source files passed UID/SHA-1 verification; the candidate's only runtime differences were the authentication entrypoint and new credential helper. Focused tests, typecheck, build, exact valid/wrong/cross-kind auth gates, and the production alias checks passed.
- Retried the exact preserved artifact successfully, verified its authenticated production receipt, and confirmed the follow-up current snapshot was selected. A Task Scheduler invocation then exited `0`, accepted six buckets and one request record with no rejections, and published a third detailed revision that became the selected September report.
- Sent the completed slice to a new Astra reviewer at high effort. Its two correctness/privacy findings and scheduled-diagnostic observation were fixed and retested before production activation.
- Final validation passed: 72 web tests with three database-only skips, 15 publisher tests, four focused companion tests, companion formatting, typecheck, production build, `git diff --check`, and 230 documentation links. Both isolated restore verifiers passed again, and all 172 files in the finalized private manifest matched their recorded sizes and SHA-256 digests.

Remaining: observe a natural hourly occurrence, inspect the Mac and browser hosts, and reconcile the production-wide v1-only and disabled-source histories into the complete before/after matrix. The task remains In progress until those acceptance criteria are evidenced.
