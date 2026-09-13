# `observatory`: the Personal Observatory companion

One static binary per machine that collects AI usage through internal adapters and publishes
envelope v2 (`POST /api/v1/usage`) to the Observatory. It replaces `scripts/telemetry/collect.py`,
`statusline.py`, and `install_schedule.py` on every machine. Rust stable, edition 2024,
`#![forbid(unsafe_code)]`, no async runtime, SQLite statically linked, HTTPS through rustls with
the platform trust store.

**Status: phase 1 (core).** `claude_execution` and `codex_execution` are exact ports of
`collect.py` v1.1.0 gated by a parity corpus; every other adapter is present as a
contract-conformant stub that reports `failed` / `unrecognized_payload` at parser version `0`
until its provider fixture exists (see "Adapters"). The server side (`/api/v1/companion/*`,
`/api/v1/usage`) lands separately; until it is deployed, `run --dry-run --offline` exercises
collection end to end without a network.

## Install

Once a release is tagged (`observatory-v<version>`), cargo-dist publishes archives, checksums,
attestations, a Homebrew formula, and shell/PowerShell installers:

```bash
brew install joshgreenwell/tap/observatory
```

```powershell
scoop bucket add joshgreenwell https://github.com/joshgreenwell/scoop-bucket
scoop install observatory
```

From a checkout:

```bash
cd kit-board/companion
cargo install --path crates/observatory --locked
```

Upgrades are the package manager's job. The companion has no self-update code; the Observatory
shows "update available" when an install's reported version is behind
`companion.latest_version`.

## Commands

| Command | What it does |
| --- | --- |
| `observatory connect --url <observatory> --code XXXX-XXXX [--label <machine>] [--since YYYY-MM-DD]` | Exchanges a one-time pairing code for an install id and key and writes `companion.json` (`0600`). `--since` sets the backfill start (default: the first day of the current UTC month); the first run pins it in state, so choose it before that run. The URL must be `https`, or `http` to `localhost`/`127.0.0.1`, with no userinfo; redirects are errors. |
| `observatory setup [--yes] [--bind claude=claude-primary]... [--secrets]` | Discovers Claude Code, Codex, and Cursor stores; shows each signed-in identity; proposes bindings; asks once each about the private-interface readers, the Claude statusline hook (an existing statusline command is preserved as a passthrough), and the schedule; writes bindings and this install's settings override; runs a dry run, a first publish, and `service install`; offers to remove a v1 schedule. |
| `observatory run [--dry-run] [--offline]` | One collection cycle (below). |
| `observatory service install\|uninstall\|status` | LaunchAgent `com.personal-observatory.companion.<install-id>`, Task Scheduler task `Personal Observatory Companion <install-id>`, or systemd user timer `personal-observatory-companion.timer`, at the effective cadence. Uninstall removes only what it installed. |
| `observatory statusline` | Claude Code statusline command: reads the statusline JSON on stdin, appends allowance samples to the inbox, prints the same one-line summary `statusline.py` printed, always exits 0 (`Claude` on any failure). No network, no SQLite. |
| `observatory hook claude\|cursor` | Tool hook receivers: append a bounded snapshot (event name, tool name, hashed session id) to the local inbox and exit 0. |
| `observatory status` | Last run summary, outbox depth, last receipt, schedule state, per-adapter state. |
| `observatory projects` | Every working directory this install has seen, per binding, with its `project_hash` and first and last sighting. Local only: this listing is how a hash gets a label on the Observatory. |
| `observatory doctor` | Effective mode and reason per adapter, prerequisite and credential checks as coverage states, discovery booleans, v1 schedules found. Never a token or a path outside the configuration directory. |
| `observatory settings show` | The cached effective settings document and its `settings_version`. |
| `observatory version` | The semantic version, also reported in every envelope. |
| `observatory serve` | Placeholder; live mode is a later phase. |

Every command accepts `--config-dir <dir>`; `OBSERVATORY_CONFIG_DIR` does the same. The scheduler
entry and the statusline hook that `setup` installs pin the directory with `--config-dir`, so every
context that starts the companion shares one state.

**Windows and packaged apps.** A process started from a packaged (MSIX) app, such as a Claude Code
session inside the Claude desktop app, sees new folders under `%LOCALAPPDATA%` redirected into
`Packages\<app>\LocalCache\Local`; Task Scheduler and every other program never see those files.
`connect` and `setup` detect this (`doctor` reports `config_dir_virtualized`) and refuse to continue;
pass `--config-dir %USERPROFILE%\.config\personal-hub\companion` (the profile root is never
redirected) or run them from a normal terminal. The Microsoft Store Python is redirected the same way,
so the analyzer step skips interpreters under `WindowsApps`; name another one in the binding's
`detailed_report.python`. `OBSERVATORY_LOG`
(`error`, `warn`, `info`, `debug`) sets the log level on stderr; logs contain counters and codes.

### The run loop

1. Take the single-run lock (SQLite `BEGIN IMMEDIATE` on `<install-id>.lock`). If held, print
   `{"skipped":"companion_already_running"}` and exit 0.
2. `GET /api/v1/companion/config` with `If-None-Match`; cache on success; use the cache on
   failure; with no cache, run only the default-on local execution readers.
3. Compute the effective mode for every adapter and record why an adapter does not run.
4. Run the enabled adapters concurrently on scoped threads under one deadline; a failure or
   timeout is a coverage entry, not a run failure.
5. Validate each record against the contract, isolate anything invalid, store the normalized
   record and the bounded raw observation (`local_raw_retention_days`).
6. Derive v1 buckets by `(session_hash, hour, model)` exactly as `collect.py` does; publish a
   bucket only when its digest changed since the last receipt.
7. Batch buckets (400), records (1000), and coverage into envelopes under 2 MB; write them to the
   outbox; upload in order; store receipts; delete acknowledged bodies. Per-record rejections are
   marked with the server's reason and never retried.
8. When `detailed_monthly_report` is on, run the v1 analyzer adapter for each binding that names
   it (five-minute budget each; status codes only).
9. Write a run summary (`status`, `doctor`, `logs/companion.log`).

When the `detailed_monthly_report` setting is on, the run also executes the kept v1 analyzer
adapter (`scripts/telemetry/detailed_report.py`) once per binding that names it in
`companion.json` (`detailed_report`, below): the companion writes a connection file under
`detailed/`, runs `python detailed_report.py --config <file> [--dry-run]` with a five-minute
budget, and records only the adapter's status codes in the run summary (`detailed_reports`).
The adapter keeps its own analyzers, state, artifacts, and usage-publisher credential.

## Files on this machine

| Item | macOS and Linux | Windows |
| --- | --- | --- |
| Config, key, state, inbox, logs | `~/.config/personal-hub/companion/` | `%LOCALAPPDATA%\PersonalObservatory\` |
| `companion.json` | install id and key, Observatory URL, per-binding root overrides, `deny` list, optional `since`; `0600` | same, or `%USERPROFILE%\.config\personal-hub\companion` when set up from a packaged app |
| `secrets.json` (opt-in) | Admin API keys; read only by `anthropic_api` and `openai_api` | same |
| `<install-id>.sqlite3`, `<install-id>.lock` | state and the run lock | same |
| `inbox/claude-statusline/`, `inbox/hooks/` | hook inboxes; one file per UTC hour | same |
| `claude-statusline-status.json` | the statusline sidecar (invocations, offered windows; no session field) | same |
| Claude Code stores read | `~/.claude/projects/**`, `~/.claude.json` (account for display), Keychain `Claude Code-credentials` (presence only in phase 1) | `%USERPROFILE%\.claude\projects`, `.claude\.credentials.json` (expiry only) |
| Codex stores read | `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.codex/auth.json` (`tokens.account_id` only, for display) | same under `%USERPROFILE%` |

Store paths are discovered at setup, can be overridden per binding in `companion.json`
(`roots`, `codex_home`, `cursor_state_db`), and are never uploaded. `setup` copies a v1
connection's `detailed_report` block into the binding (asking first) when it finds one; add it by
hand otherwise (`python` optionally names the interpreter; `analyzer_config_path` replaces
`codex_home` for the Claude analyzer).

```json
{
  "schema_version": 1,
  "url": "https://personal-observatory-jg.vercel.app",
  "install_id": "…", "key": "…", "machine_label": "mac-workstation",
  "since": "2026-09-01",
  "bindings": [
    { "binding_id": "…", "account_id": "claude-primary", "provider": "claude" },
    { "binding_id": "…", "account_id": "codex-primary", "provider": "codex", "codex_home": "/Users/me/.codex",
      "detailed_report": { "script": "/Users/me/.config/personal-hub/telemetry/detailed_report.py",
        "analyzer_path": "/Users/me/analyze-monthly-token-usage/scripts/analyze_token_usage.py",
        "codex_home": "/Users/me/.codex", "upload_config_path": "/Users/me/.config/personal-hub/token-usage-upload.json",
        "machine_id": "mac-personal" } }
  ],
  "deny": ["allowance.claude_reader.oauth_usage"]
}
```

## Settings, deny list, effective mode

Collection modes are settings stored in the Observatory (`lib/companion-settings.ts`), edited in
the UI, fetched on every run, and further restrictable locally. A setting can only turn a mode on
or off; it can never name a path, an endpoint, or a command.

```text
effective(adapter, mode) =
      server value (install override, else global default)
  AND adapter mode not in the local deny list          e.g. "allowance.claude_reader.oauth_usage"
  AND binding enabled and identity unchanged
  AND prerequisite present (store, executable, credential)
```

A deny entry matches an adapter id (`codex_account`), a provider switch (`providers.cursor`), an
exact mode path (`allowance.codex_reader.app_server`), or a dotted prefix of one
(`allowance.codex_reader`). The deny list can only remove. Every adapter reports its effective
state in coverage (`disabled_by_setting`, `denied_locally`, `prerequisite_missing`,
`credential_unavailable`, `identity_changed`, …) with a code from the closed `DetailCode` list, so
"off" is always distinguishable from "broken".

## Adapters

| Adapter | Phase | In this version |
| --- | --- | --- |
| `claude_execution` | 1 | Ported. Buckets; `allowance.reading` from the statusline inbox (reader `statusline`, meters `five_hour`, `seven_day`, and every model-scoped weekly window `seven_day_<model>`, labelled `Claude · weekly · <Model>`); `activity.request` at `detail_level` `requests`. |
| `codex_execution` | 1 | Ported. Buckets; embedded `rate_limits` as `allowance.reading` (reader `embedded`, meter `<limit_id>:<minutes>`); `activity.request` at `requests`. |
| `claude_account` | 2 | Stub. Preflight reports the Keychain item or `.credentials.json` state; collect reports `unrecognized_payload` until `provider/claude/*` fixtures exist. |
| `codex_account` | 2 | Stub. Preflight reports whether `codex` is on `PATH`. |
| `cursor_execution`, `cursor_account` | 3 | Stubs. Preflight reports whether `state.vscdb` exists. |
| `anthropic_api`, `openai_api` | 5 | Stubs. Preflight reports whether the key is in `secrets.json`. |

Stubs never make a network request, spawn a process, or read a credential.

### The v1 parity port

`observatory-core::pyjson` reproduces `json.dumps(value, sort_keys=True, separators=(',', ':'))`
byte for byte (code-point key order, `ensure_ascii`, Python float `repr`) so a v1 collector and
the companion observing the same session produce the same `session_hash` and event digests and
deduplicate in `token_bucket_revisions`. `observatory-adapters::jsonl` restates `collect.py`'s
discovery, checkpoints, Codex and Claude parsing, event saving, and embedded quotas, including
Python's evaluation order and which failures count as malformed.
`kit-board/tests/fixtures/usage-v2/parity/expected.json` is what `collect.py` produces from the
synthetic corpus; `cargo test -p observatory-adapters` fails when the port drifts, and
`scripts/fixtures.py check` fails in CI when the expectations go stale.

Beyond parity, `activity.request` records add `product`, `surface`, `execution_host`,
`client_version`, `ended_at`, `outcome`, and `parent_session_hash` for Claude Code subagent
transcripts (`.../<session>/subagents/*.jsonl`) when `include_subagents` is on.

`surface` follows what the provider wrote: Claude Code's per-line `entrypoint` (`cli`,
`claude-desktop` → `desktop`, `claude-vscode` → `ide`, `sdk-*` → `sdk`; a transcript without the
field counts as `cli`, which every transcript was before the field existed) and Codex's
`session_meta.originator`, then `source` (`codex_cli_rs` → `cli`, `Codex Desktop` and
`codex_work_desktop` → `desktop`, a `vscode` originator or source → `ide`). Desktop-app sessions
of both products therefore land in the same ledger as terminal sessions, distinguished by surface.

`project_hash` is filled only when `execution.project_attribution` is `hashed` (default `off`).
It is `sha256(["project", cwd])` in the repository's stable JSON form, where `cwd` is the working
directory the transcript recorded (Claude: the line's `cwd`; Codex: `session_meta.cwd`, updated by
each `turn_context.cwd`) with trailing separators trimmed. The same directory yields the same
hash from Claude and Codex, so one project groups across providers; two machines yield different
hashes because their paths differ, and a label on the Observatory joins them. The companion
records the hash and the path together in its local `projects` table whatever the setting, so
turning the setting on later re-emits every retained request with its hash as a revision, and
`observatory projects` shows which hash is which folder. The path itself is never uploaded. See
`docs/usage-coverage.md` for what this does and does not cover.

### Decisions made during the port

These settle points the handoff left open or that the port could not follow literally. The
owner can veto any of them.

- **Codex `semantic_key` is the v1 event digest** (`sha256([provider, account, thread id, token_count
  timestamp, cumulative counters])`) even when a turn id is present: one turn contains several
  provider requests, and keying by turn would collapse them into one canonical row.
- **`include_subagents: false` skips Claude Code `subagents/` transcripts entirely** rather than
  counting them without a parent; v1 counted every file, so the default (`true`) keeps parity.
- **The statusline inbox is machine-wide** and is attributed to the first Claude binding of the
  install (the machine has one Claude Code sign-in).
- **All envelopes of one run share `run_id`**; the server must upsert `companion_runs` on
  `run_id`, summing counts and replacing coverage.
- **`identity_hash = sha256(stableJson([provider, account uuid]))`**, the same derivation the
  browser collector uses, so one account yields one hash from both installs. The v1 roots pin
  (`digest([account_id, provider, roots])`) is kept in state; a change pauses the binding with
  `identity_changed` instead of refusing to run.
- **Windows file identity** is `volume serial:file index` (Python's `st_dev:st_ino` on Windows),
  read through `winapi-util`.
- **`allowance_slots` payloads carry an extra `raw_window_id`** beside the six v1 fields; the
  parity test strips it before comparing.
- **`run --offline`** skips the config fetch (benchmarks and CI); it is not a mode users need.
- **Cursor identity is not read in phase 1**; its binding is created without evidence.
- **The project key is an unsalted hash of the working directory.** A salt per install would
  stop a guessed path from being confirmed by hashing it, but it would also give the same
  directory a different key from every install and from the browser collector's future
  readings. The Observatory is private; the hash keeps the path off the server, which is the
  boundary that matters. The setting stays opt-in.
- **Model-scoped weekly windows are accepted** wherever v1 accepted only `five_hour` and
  `seven_day`: the statusline hook publishes any `rate_limits.seven_day_<model>` entry with a
  10080-minute window, and the inbox reader forwards it. The parity corpus contains only the two
  pooled windows, so `expected.json` is unchanged. Each scoped window is its own meter on the
  Observatory; it is never summed with the pooled weekly window.
- **A reading's reset must fall inside its own window** (plus a day of slack; 90 days when the
  window length is unknown). The hook drops such a sample and the contract rejects the record on
  both sides: a far-future reset would otherwise pin the forecast card for weeks.
- **Stub adapters report `prerequisite_missing` / `not_implemented`** once their prerequisites are
  present instead of running and failing; `failed` is reserved for real errors.
- **The detailed monthly report stays a Python adapter** run as a subprocess; porting the
  analyzers is out of scope, and the adapter already owns retries, artifacts, and the
  publisher credential.

## What is uploaded

Counters, hashed identifiers, model names, allowlisted or hashed tool names, allowance readings,
provider aggregates and charges, coverage codes, versions, and, only when project attribution is
`hashed`, a hash of each request's working directory. Never: prompts, responses, file
paths, repository names, credentials, raw provider payloads, free-text errors. Credentials are
read at run time from their owning application's store, used for one read, and dropped; the
companion never refreshes one. `companion.json`, `secrets.json`, the state database, and the
inbox are `0600` on Unix; `%LOCALAPPDATA%` is private by its default ACL on Windows. The companion
never downloads or executes code.

## Development

```bash
cd kit-board/companion
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
python3 scripts/fixtures.py check       # corpus, MANIFEST.json, and parity expectations are current
cargo deny check                        # advisories, licenses, duplicate versions, sources
```

- `scripts/fixtures.py generate|expected|check` owns `kit-board/tests/fixtures/usage-v2/`
  (wire envelopes, the parity corpus, `MANIFEST.json`) and runs `collect.py` for `expected.json`.
- `scripts/bench.py --bytes 1000000000 --exe target/release/observatory` generates synthetic
  JSONL and times `run --dry-run --offline`; CI runs a 64 MB version on each OS (informational).
- Snapshots of each execution adapter's normalized output live in
  `crates/observatory-adapters/tests/snapshots/`; review a change with `cargo insta review` or
  `INSTA_UPDATE=always cargo test -p observatory-adapters`.
- The vendored schema `crates/observatory-contract/schema/usage-v2.schema.json` is the
  `z.toJSONSchema(usageEnvelopeSchema, { io: 'input' })` output of the section 1.1 definition
  (input mode, so the defaulted `buckets` and `records` arrays are optional as zod accepts them); once `lib/generated/usage-v2.schema.json`
  exists, `cargo test` and CI require the two to be byte-identical.
- Dependencies are deliberately few (`clap`, `serde`, `serde_json`, `rusqlite`, `ureq`, `jiff`,
  `sha2`, `uuid`, `plist`, `thiserror`, `tracing`; `winapi-util` on Windows; dev-only `jsonschema`,
  `insta`, `tempfile`). Dependabot watches `Cargo.lock`.

### A macOS test build from a Windows host

`scripts/cross-macos-from-windows.sh [aarch64|x86_64]` cross-compiles a **test** build with zig
as the linker (no Apple SDK) and `--no-default-features`, so TLS trusts the bundled Mozilla roots
instead of the macOS Keychain; `observatory doctor` shows `"tls_roots": "webpki"` for it. The
release pipeline never does this: cargo-dist builds Apple targets on native macOS runners with
the platform verifier. The script's header lists the one-time prerequisites.

### Server contract the companion expects

Bearer: the install key (`Authorization: Bearer <key>`), except `pair`.

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /api/v1/companion/pair` | `{ code, machine_label, kind, platform, arch }` | `{ install_id, key }` |
| `GET /api/v1/companion/config` | `If-None-Match` | `ConfigDocument` with `ETag`; `304` when unchanged |
| `POST /api/v1/companion/bindings` | `{ account_id, provider, account_label, identity_hash }` | `{ binding_id, account_id, provider, enabled, identity_hash }` (201 created, 200 existing) |
| `PUT /api/v1/companion/settings` | `InstallOverride` | `{ ok, settings_version }` |
| `POST /api/v1/companion/bindings/<id>/identity` | `{ identity_hash }` | `{ ok, binding_id, identity_hash, enabled }` |
| `POST /api/v1/usage` | envelope v2 | `{ ok, schema_version, run_id, accepted: { buckets, records }, duplicates, rejected: [{ record_id, reason }] }` |

Every body is strict on both sides: an unknown field in a response is a contract change and
fails loudly.

## Release

1. Bump `version` in `Cargo.toml` (`[workspace.package]`), date the changelog entry, merge.
2. Tag the merge commit `observatory-v<version>` and push the tag. cargo-dist's
   `.github/workflows/release.yml` (generated and owned by `dist generate`; configuration in the
   repository-root `dist-workspace.toml`, which points at this workspace) builds each target on a native runner, publishes the GitHub Release with
   SHA-256 checksums and artifact attestations, pushes the Homebrew formula to
   `joshgreenwell/homebrew-tap` (token scoped to that repository, secret `HOMEBREW_TAP_TOKEN`),
   and produces the shell and PowerShell installers.
3. Update `joshgreenwell/scoop-bucket` from `packaging/scoop/observatory.json` (the manifest
   carries `checkver` and `autoupdate`, so later releases update themselves).
4. Verify from a fresh machine: `brew install joshgreenwell/tap/observatory` or
   `scoop install observatory`, then `observatory version`.
