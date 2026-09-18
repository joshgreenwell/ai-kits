# USG-029: Implement the Claude account allowance reader

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Planned
Priority: P2
Scope: Follow-up
Stage: 6. Provider coverage
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-009](usg-009-fix-allowance-identity-and-freshness.md), [USG-014](usg-014-truthful-settings-and-collection-health.md)
Created: 2026-09-13

## Outcome

Provide a verified account-level allowance reader alongside statusline and browser observations.

## Current gap

`oauth_usage` is implemented in this checkout. Enabling it still keeps the statusline reader as the documented fallback. No real authorized OAuth reading has been stored or shown, so the task stays Planned.

## Acceptance criteria

1. Validate current source availability, supported authorization/usage boundaries, account identity fields, and response fixtures before selecting an implementation path.
2. Collect supported pooled/model-specific windows with original observation/reset data, stable scope, and account binding; handle absent windows explicitly.
3. Handle expiry, identity change, unavailable permissions, throttling, and unrecognized schemas with truthful coverage and no cross-account fallback.
4. Define reader precedence with statusline/browser evidence and preserve historical observations without duplicate contributions.
5. Document and verify the supported setup with an actual account reading and UI result; unsupported source access remains an explicit blocker, not an assumed implementation.

## Verification

Use multiple-account, expired/unavailable-access, missing-window, stale-result, and duplicate-reader cases plus a real supported collection receipt.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [companion/crates/observatory-adapters/src/claude_account.rs](<../../companion/crates/observatory-adapters/src/claude_account.rs>)
- [companion/crates/observatory-core/src/credentials.rs](<../../companion/crates/observatory-core/src/credentials.rs>)
- [docs/usage-coverage.md](<../../docs/usage-coverage.md>)
- [docs/usage-system.md](<../../docs/usage-system.md>)

## Execution record

In source as of 2026-09-17. Status stays Planned: criterion 5 needs an actual account reading and UI result.

- Decisions: private `GET https://api.anthropic.com/api/oauth/usage` with the existing Claude Code sign-in. Observatory never POSTs a refresh_token; `allowance.claude_oauth_keepalive` may spawn Claude Code so *it* refreshes the store. Parser version stays `2.0.0+statusline1`. Emission is only to the confirmed Claude identity. `RunContext.claude_credentials_path` defaults to `None` so unit tests never hit Keychain or `.credentials.json`; `prepare()` sets the platform path. Missing credentials with statusline samples present is Partial / CredentialMissing, not a hard fail. Deny of `allowance.claude_reader.statusline` removes only the fallback; a prefix deny of `allowance.claude_reader` still stops the adapter. Queued statusline readings stay local under that deny even when the server selects `oauth_usage`.
- Checks: parse fixture `tests/fixtures/usage-v2/provider/claude-oauth-usage.json` plus a `limits` array with `weekly_scoped`; adapter tests that `oauth_usage` plus a statusline-only deny still attempts OAuth rather than `DeniedLocally`.
- Blocker: no real authorized OAuth receipt. The interface is private and can change without notice.
