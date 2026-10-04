# USG-035: Carry the recorded git branch on each request when enabled

[Backlog index](README.md) · [Coverage P2](../usage-coverage.md#p2-hashed-project-attribution-and-surface) · [Upgrading to 2.3.0](../usage-collection.md#upgrading-to-230-server-then-companions-then-the-setting)

Status: In progress
Priority: P2
Scope: Follow-up
Stage: 2. Collection
Dependencies: [USG-003](usg-003-extend-detail-contract-and-storage.md), [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-007](usg-007-map-project-identities.md)
Created: 2026-10-02

## Outcome

A request can say which git branch its transcript recorded, so usage can later be tied to the work a branch names (a ticket, a story, a release). The field is optional everywhere: off by default, absent from the record when off, and safe to ignore for every reader that predates it.

## Current gap

Claude transcripts write `gitBranch` on every assistant line and Codex rollouts write `session_meta.git.branch`, but the contract had no field for it, so the branch never left the machine. `usage-coverage.md` also described the Codex field as rarely present; on this machine on 2026-10-02 it was present on 299 of the 300 most recent rollouts.

## Acceptance criteria

1. `activity.request` has an optional `git_branch: { name, basis }` block in zod, the generated JSON Schema, its vendored copy, and the Rust contract. Omission is valid; an explicit `null` is not. `basis` is `recorded` (name present), `detached` (the transcript wrote `HEAD`), or `unknown` (absent, empty, or not 1 to 200 bytes of `[A-Za-z0-9._/+@-]` starting with a letter or digit); a name appears exactly when the basis is `recorded`.
2. A new setting `execution.branch_attribution` is `off` by default and `plain` to enable. Under `off` no request carries the block. A local deny (`execution.branch_attribution`) keeps it home for fresh and queued records, and the upload-time check strips it from queued requests whenever the current setting is not `plain`.
3. Only the branch name leaves the transcript. Commit hashes, remote URLs, and paths are never read into the record.
4. The setting is part of the emission fingerprint, so enabling it re-emits retained requests with the branch, as revisions.
5. Companions before 2.3.0 keep working unchanged: they reject unknown execution keys, so the config route sends the key only as `plain` and only to a client whose `observatory/<version>` User-Agent names 2.3.0 or later. `off` is never sent, so older builds' documents and ETags do not change.
6. The server stores the block in two nullable `activity_requests` columns, `git_branch` and `git_branch_basis`, with CHECK constraints for the basis values and for name-exactly-when-recorded. Earlier rows and rows without the block stay NULL.
7. The Collection settings matrix offers the setting, notes that both providers record the branch of the folder the session was launched from, and gates `plain` on the companion reporting the `branch_attribution` feature.
8. Docs state the field, the launch-folder limitation, and the deployment order: migration and server, then companions with the setting off, then the setting.

## Verification

- Rust: `tests/git_branch.rs` (absent by default, plain carries only the name, enabling re-emits, local deny), the upload-strip test in `run.rs`, wire tests for omission versus explicit null, refreshed adapter snapshots (parser version only), `cargo fmt`, `clippy -D warnings`, `cargo test --workspace`.
- Fixtures: `git-branch-requests` (valid: recorded, detached, unknown) and `null-request-git-branch`, `git-branch-basis-mismatch` (not expressible in JSON Schema), `git-branch-unsafe-name` (invalid); `python3 scripts/fixtures.py check`; `npm run usage-schema` leaves no diff.
- Server: `npm run typecheck`, `npm test`, and `npm run test:db`. The integration test covers the User-Agent gate (2.3.0, 2.10.0, 10.0.0 receive `plain`; 2.2.9, 1.9.0, a browser, and no User-Agent do not; `off` keeps one ETag across builds), the stored columns, the revision on enabling, and the presence CHECK.

Apply the common completion requirements in the [backlog index](README.md).

## Starting points

- [companion/crates/observatory-adapters/src/jsonl.rs](<../../companion/crates/observatory-adapters/src/jsonl.rs>) (`git_branch_from`)
- [companion/crates/observatory-contract/src/records.rs](<../../companion/crates/observatory-contract/src/records.rs>), [settings.rs](<../../companion/crates/observatory-contract/src/settings.rs>)
- [lib/usage-contract.ts](<../../lib/usage-contract.ts>), [lib/companion-settings.ts](<../../lib/companion-settings.ts>), [lib/usage-store.ts](<../../lib/usage-store.ts>) (`companionConfig`, `companionBuild`)
- [supabase/migrations/20261002090000_activity_request_git_branch.sql](<../../supabase/migrations/20261002090000_activity_request_git_branch.sql>)

## Execution record

2026-10-02, on branch `kit-board/usg-035-git-branch-attribution`; merged to `main` on October 4:

- Implemented criteria 1 to 8 across the Rust contract, adapters, core run loop (state schema 10), zod contract, settings matrix, capabilities, config route, ingestion, migration, fixtures, and docs. Companion version is 2.3.0 (CHANGELOG "2.3.0 — 2026-10-04").
- Verified locally: Rust 340 tests, fmt and clippy clean; fixtures check OK; typecheck clean; `npm test` 226 pass; `npm run test:db` 41 of 42 pass, including the new git-branch test. The one failure, C2 in `usage-side-records.integration.test.ts`, creates a database with the Linux locale name `en_US.utf8`, which macOS lacks; it is unrelated to this change. On macOS the local cluster also needs `LC_ALL` set (for example `LC_ALL=en_US.UTF-8`), or the postmaster refuses to start.
- October 4: the owner applied `20261002090000_activity_request_git_branch.sql` to Aurora before the server deploy; `supabase migration list` shows it applied and nothing pending.
- October 4: `63e5ef2` reached `main` and Vercel deployed it to Production. A 2.2.0 run against the new server received configuration `not_modified` and had 106 records accepted, 0 rejected, so 2.2.0 companions are unaffected.
- October 4: tagged `observatory-v2.3.0`, and the release workflow published the binaries and the GitHub Release. Its Homebrew job failed for lack of a `HOMEBREW_TAP_TOKEN` secret, as it did for 2.1.0 and 2.2.0. The tarball install does not use it.
- October 4, Mac: verified the aarch64 build (checksum and `gh attestation verify`), backed up the state, and gated a 2.3.0 dry run on a scratch copy.
  - The gate found no request or agent revisions, and `caller_request_changes` was 0.
  - It failed on one `tool.event`, revised in `outcome` only: a Bash call still running during the cutoff run, whose outcome went from `unknown` to `succeeded` once the transcript recorded its result.
  - A control, the 2.2.0 dry run on a second copy of the same baseline, reported the identical violation. That made it a transcript change, not an upgrade effect, and the install went ahead. [Upgrading to 2.3.0](../usage-collection.md#upgrading-to-230-server-then-companions-then-the-setting) now describes this control and the `schema_version` check that replaces `pending_side` for 2.3.0.
  - `service install` repointed the LaunchAgent at 2.3.0. The first run hit the five-minute scan deadline mid-replay (`partial_read` on both execution adapters; 128 records accepted). The next run finished the replay: both adapters `ok`, 66 accepted, none rejected or retained.
  - `doctor` reports `ok: true` on 2.3.0. `codex_account` stays `executable_missing` and the schedule read-back stays `unreadable`, both unchanged from 2.2.0.
  - Aurora holds 211,266 requests, none with a branch.
- October 4, Windows: verified the x86_64 build (checksum and `gh attestation verify`), backed up the state with SQLite's backup API, and gated a 2.3.0 dry run on a scratch copy.
  - The gate passed with no violations: 0 request or agent revisions, `caller_request_changes` 0, `pending_side` empty, and the scratch copy's `schema_version` 10 against 9 in the baseline. Its one `tool.event` revision (`outcome` only) was allowed, so no control was needed.
  - `service install` repointed the task at 2.3.0, keeping the 2.2.0 binary as a rollback copy. The first run finished inside the scan limit: both execution adapters `ok`, 48,252 Claude and 108,336 Codex records read. The next run accepted 10 records, with 0 rejected and 0 retained.
  - `doctor` reports `ok: true` and version 2.3.0; the schedule is installed and not pending. `claude_account` showed `credential_expired` on the first run, and `cursor_account` was `partial` (`timeout`) on the second, both unchanged from before.
- Open: turn the setting on (both machines are now on 2.3.0). No read model uses the columns yet; the factory kit will add one.
- Known limit: neither provider follows the folder a session works in. Claude writes the launch folder's branch on every line; Codex records git once, at session start. A session launched from a workspace root on `main` that works in a nested checkout on a feature branch reports `main`. Ticket attribution needs the session launched in the story checkout or worktree, or an explicit session-to-ticket link.
