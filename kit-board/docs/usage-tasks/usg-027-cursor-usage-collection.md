# USG-027: Implement Cursor usage collection from validated source evidence

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-001](usg-001-metric-and-source-contract.md), [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Replace detected-but-unimplemented Cursor setup with usable, correctly labeled usage facts.

## Current gap

Adapters are implemented in this checkout. Local `state.vscdb` counters and hosted usage/allowance parse from synthetic fixtures. No real authorized hosted receipt has been stored or shown, so the task stays Planned.

## Acceptance criteria

1. Validate available local and hosted source shapes with current primary documentation and sanitized fixtures; identify which facts are local counters, provider-reported usage, allowances, or actual charges.
2. Implement the supported reader paths with explicit account identity, time semantics, stable event keys, pagination/checkpoints, rate-limit handling, and idempotent replay.
3. Preserve the separation between local execution counters and billed usage. Do not infer project attribution by an unsupported timestamp match.
4. Advertise only implemented fields in settings/coverage, including units and plan scope; state unsupported tool/agent/project/cloud detail explicitly.
5. Verify a real collection receipt and the applicable Tokens/Allowances views for an accessible intended account. If source access is unavailable, record the concrete blocker and keep the task incomplete.

## Verification

Test source fixtures, duplicate/late events, account changes, expired access, pagination, unavailable dimensions, and comparison with the provider's own reported period.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/cursor_execution.rs](<../../companion/crates/observatory-adapters/src/cursor_execution.rs>)
- [companion/crates/observatory-adapters/src/cursor_account.rs](<../../companion/crates/observatory-adapters/src/cursor_account.rs>)
- [companion/crates/observatory-core/src/cursor_store.rs](<../../companion/crates/observatory-core/src/cursor_store.rs>)
- [docs/usage-system.md](<../../docs/usage-system.md>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)

## Execution record

In source as of 2026-09-17. Status stays Planned: criterion 5 needs a real authorized collection receipt for an intended Cursor account.

- Decisions: local `state.vscdb` counters are `activity.request` on channel `local_db` (parser `2.0.0+cursor-local1`, product `cursor_ide`) only when detail is not `buckets_only`; they never write hourly buckets and never invent a project from a timestamp. Tool, agent, project, and resource dimensions stay unsupported. Hosted billed authority is `GET https://cursor.com/api/usage-summary` (reader `usage_summary`) and `POST https://cursor.com/api/dashboard/get-filtered-usage-events` (reader `dashboard_rpc`, also gated by `account_history.cursor_usage_events`), using the Cursor session from `state.vscdb` (never an Enterprise Admin key) with `Origin: https://cursor.com`. Hosted rows emit only to the single confirmed Cursor identity. Usage-summary emits one meter per named `*PercentUsed` pool (`auto`, `api`, …) and skips combined `totalPercentUsed` when those exist. Events keep exclusive fresh input when cache-read is included in `inputTokens`, keep reported input when cache-read is beside it, store the event `model` as reported, and store a total equal to the sum of present exclusive classes; `money.entry` appears when `chargedCents` > 0. Tokens query unions `account_usage_buckets` with local hours, coalescing a missing total from exclusive components, and never treats them as the same work. Cursor hosted stays off in `setup` until Settings. Project hooks stay unimplemented.
- Companion: `cursor_store.rs` reads identity and token through dedicated helpers and extracts conversation token fields in SQLite. Provider HTTP is HTTPS only; 401/403 unauthorized, 429 rate limited. Adapter cursor is JSON `PageCursor`.
- Server: `lib/usage-query.ts` canonical buckets UNION local `token_bucket_revisions` with provider `account_usage_buckets`; conversations stay local-session only. `lib/usage-store.ts` reader rank includes `usage_summary` and `dashboard_rpc`. Settings notes and capability modes advertise the implemented readers; chips still follow each installed build's report. Grok 4.6 list prices live in `lib/pricing-catalog.json` under `xai`; unknown models keep token columns with `model_not_in_catalog`.
- Checks: adapter parse tests against `tests/fixtures/usage-v2/provider/cursor-usage.json` and `cursor-events.json` plus Auto/API split and event totals; usage-query integration (database-gated) that Claude local hours sit beside Cursor hosted buckets, including hosted rows that stored no `total_tokens`, and that Grok 4.6 prices while other Cursor models remain in the token table unpriced. Collect tests stay parse-only (no live Cursor session).
- Blocker: no real authorized hosted receipt stored and shown on Tokens/Allowances. The Windows Cursor binding was unconfirmed at the September 13 audit, so hosted rows would not emit until identity is confirmed.
