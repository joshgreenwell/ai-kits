# `observatory`: the Personal Observatory companion

Start with [Usage: features and verified state](../docs/usage-system.md). This README documents the implementation; [v2 operation](../docs/usage-collection.md) and [v1 retirement](../docs/usage-v1-retirement.md) own installation and removal procedures respectively.

One static binary per machine that collects AI usage through internal adapters and publishes
envelope v2 (`POST /api/v1/usage`) to the Observatory. It replaces `scripts/telemetry/collect.py`,
`statusline.py`, and `install_schedule.py` on every machine. Rust stable, edition 2024,
`#![forbid(unsafe_code)]`, no async runtime, SQLite statically linked, HTTPS through rustls with
the platform trust store.

**Status: core collection deployed; other readers unfinished.** `claude_execution` and
`codex_execution` port `collect.py` v1.1.0 against a synthetic parity corpus. Other adapters
are stubs at parser version `0`: current source reports a missing prerequisite or
`not_implemented`, while older installed builds can report `failed / unrecognized_payload`.
The server and unified schema are deployed, with Mac and Windows receipts verified on
September 13. This does not prove complete backfill: the audit found substantial v1-only
history. `run --dry-run --offline` exercises local collection without a network.

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
`companion.latest_version`. A tagged install updates with `brew upgrade
joshgreenwell/tap/observatory` or `scoop update observatory`. After either upgrade, run
`observatory --config-dir <the-existing-directory> service install`, `run`, and `doctor`; do not
reconnect a working install. For the current unreleased checkout and platform-specific rollback
steps, use [the operating guide](../docs/usage-collection.md#update-an-existing-windows-install).

## Commands

| Command | What it does |
| --- | --- |
| `observatory connect --url <observatory> --code XXXX-XXXX [--label <machine>] [--since YYYY-MM-DD]` | Exchanges a one-time pairing code for an install id and key and writes `companion.json` (`0600`). `--since` sets the backfill start (default: the first day of the current UTC month); the first run pins it in state, so choose it before that run. The URL must be `https`, or `http` to `localhost`/`127.0.0.1`, with no userinfo; redirects are errors. |
| `observatory setup [--yes] [--bind claude=claude-primary]... [--secrets]` | Discovers Claude Code, Codex, and Cursor stores; shows each signed-in identity; proposes bindings; offers each Obsidian vault from the application's own registry as a knowledge source (key `obsidian.<vault id>`, folder name as the local label; default no, skipped under `--yes`); asks once each about the private-interface readers, the Claude statusline hook (written into `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set, else `~/.claude/settings.json`; an existing statusline command is preserved as a passthrough), and the schedule; writes bindings and this install's settings override; runs a dry run, a first publish, and `service install`; offers to remove a v1 schedule. |
| `observatory run [--dry-run] [--offline]` | One collection cycle (below). |
| `observatory service install\|uninstall\|status` | LaunchAgent `com.personal-observatory.companion.<install-id>`, Task Scheduler task `Personal Observatory Companion <install-id>`, or systemd user timer `personal-observatory-companion.timer`, at the effective cadence. Uninstall removes only what it installed. Every subcommand reads the installed job back (`schedule`: state, interval, whether it pins this config directory, `pending` against the desired cadence, and the action when it does not match) and install/uninstall post the capability report so the site sees the change at once. |
| `observatory statusline` | Claude Code statusline command: reads the statusline JSON on stdin, stamps each allowance sample with the signed-in account's identity hash, writes a part file to the inbox only when a reading changed or the fifteen-minute heartbeat is due, prints the same one-line summary `statusline.py` printed, always exits 0 (`Claude` on any failure). No network, no SQLite. |
| `observatory hook claude\|cursor` | Tool hook receivers: append a bounded snapshot (event name, tool name, hashed session id) to the local inbox and exit 0. |
| `observatory status` | Last run summary, outbox depth, last receipt, the schedule verdict (installed versus desired cadence), per-adapter state. |
| `observatory projects` | Every working directory this install has seen, per binding, with its `project_hash` and first and last sighting. Local only: this listing is how a hash gets a label on the Observatory. |
| `observatory resources` | Every knowledge source in `companion.json` with its key, label, source, roots (and how many exist), connectors, validation problem, and, once a run has created the state, the `cfg:` token its rows carry; the local deny state; per binding, access counts by key, kind, and evidence basis and inspection counts by class. Local only: roots, labels, and connector ids never leave the machine. |
| `observatory resources add --key <key> --root <dir>... [--connector <id>]... [--label <text>] [--source <text>]` | Adds a source, or replaces the one with the same key, after validation (key `^[a-z0-9_.:-]{1,64}$`; roots absolute or `~/`-anchored; connectors `mcp:<namespace>` or `url:<prefix>`; at least one root or connector). The next run replays retained transcripts under the new configuration. |
| `observatory resources remove --key <key>` | Removes a source. Future runs stop uploading rows for that key; rows the Observatory already holds are append-only and stay. |
| `observatory doctor [--offline]` | Effective mode and reason per adapter, prerequisite and credential checks as coverage states, discovery booleans (including Obsidian's registry and vault count), `resources_configured`, `resources_invalid`, `resource_attribution_effective` with its reason (`detail_level`, `denied_locally`, `no_resources`, `ok`), a `claude_statusline` block (below), v1 schedules found. `--offline` reads the cached config document instead of fetching it, like `run --offline`. Also the `schedule` verdict. Never a token or a path outside the configuration directory. |
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
| Config, key, state, inbox, logs | `~/.config/personal-hub/companion/` | `%USERPROFILE%\.config\personal-hub\companion\` is recommended so packaged and ordinary apps share one tree; `%LOCALAPPDATA%\PersonalObservatory\` remains the CLI default |
| `companion.json` | install id and key, Observatory URL, per-binding root overrides, `deny` list, optional `since`, optional `resources` (knowledge sources with their local roots); `0600` | same; pass the selected root consistently with `--config-dir` |
| `secrets.json` (opt-in) | Admin API keys; read only by `anthropic_api` and `openai_api` | same |
| `<install-id>.sqlite3`, `<install-id>.lock` | state and the run lock | same |
| `inbox/claude-statusline/`, `inbox/hooks/` | hook inboxes; the statusline writes one part file per changed reading (`<YYYY-MM-DDTHH>-<observed microseconds>.json`), tool hooks one line per invocation | same |
| `inbox/claude-statusline-status.json` | the statusline sidecar beside the inbox, never inside it (`last_invocation_at`, `invocations`, `last_offered_at`, `offered_windows`, `offered_windows_ever`, `published_windows`, `last_published_at`; no session field) | same |
| `inbox/claude-statusline-latest.json` | the hook's kept state beside the inbox: the last reading per identity stamp and window (`used_percent`, `resets_at`, `kept_at`), which tells a changed reading from a repeat | same |
| `claude-identity-cache.json` | the hook's identity cache per Claude config file (`mtime_ns`, `size`, `evidence_hash` or null); no secret and no account uuid | same |
| Claude Code stores read | `~/.claude/projects/**`, the config file (`$CLAUDE_CONFIG_DIR/.claude.json` when set, else `~/.claude.json`: the account, for display and for the statusline stamp), `~/.claude/settings.json` (the installed `statusLine.command`, read never written by a run), Keychain `Claude Code-credentials` (presence only in phase 1) | `%USERPROFILE%\.claude\projects`, `.claude\.credentials.json` (expiry only) |
| Codex stores read | `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.codex/auth.json` (`tokens.account_id` only, for display) | same under `%USERPROFILE%` |

Store paths are discovered at setup, can be overridden per binding in `companion.json`
(`roots`, `codex_home`, `cursor_state_db`), and are never uploaded. `setup` copies a v1
connection's `detailed_report` block into the binding (asking first) when it finds one; add it by
hand otherwise (`python` optionally names the interpreter; `analyzer_config_path` replaces
`codex_home` for the Claude analyzer). The example assumes the current Python adapter has been
installed at its stated `script` path; the binary does not bundle it. Verify the migrated path
and detailed publication before removing the old directory. `resources` names the knowledge
sources this machine classifies tool calls against (`observatory resources`, below); `setup`
proposes Obsidian vaults, and `key` is the only part of an entry the Observatory ever sees.

```json
{
  "schema_version": 1,
  "url": "https://personal-observatory-jg.vercel.app",
  "install_id": "…", "key": "…", "machine_label": "mac-workstation",
  "since": "2026-09-01",
  "bindings": [
    { "binding_id": "…", "account_id": "claude-primary", "provider": "claude" },
    { "binding_id": "…", "account_id": "codex-primary", "provider": "codex", "codex_home": "/Users/me/.codex",
      "detailed_report": { "script": "/Users/me/.config/personal-hub/companion/detailed_report.py",
        "analyzer_path": "/Users/me/analyze-monthly-token-usage/scripts/analyze_token_usage.py",
        "codex_home": "/Users/me/.codex", "upload_config_path": "/Users/me/.config/personal-hub/token-usage-upload.json",
        "machine_id": "mac-personal" } }
  ],
  "deny": ["allowance.claude_reader.oauth_usage"],
  "resources": [
    { "key": "obsidian.f00dbeefcafe0001", "label": "notes", "roots": ["/Users/me/Documents/notes"],
      "connectors": ["mcp:notes"], "source": "obsidian:f00dbeefcafe0001" }
  ]
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
exact mode path (`allowance.codex_reader.app_server`), project attribution
(`execution.project_attribution` or `execution.project_attribution.hashed`), knowledge-source
attribution (`execution.resource_attribution`, which has no settings-document counterpart: sources
are local configuration and this entry is the only switch), or a dotted prefix of one
(`allowance.codex_reader` or `execution`). The deny list can only remove. Every adapter reports its effective
state in coverage (`disabled_by_setting`, `denied_locally`, `prerequisite_missing`,
`credential_unavailable`, `identity_changed`, …) with a code from the closed `DetailCode` list, so
"off" is always distinguishable from "broken".
Outbox rebuild applies adapter, provider, and mode denies to pending records as well, so data queued
before a local deny was added remains local while that rule is active; a resource deny leaves queued
`resource.access` records pending rather than dropping them, so lifting it uploads them.

`allowance.claude_reader` needs one extra rule, because two readers share one adapter. `claude_account`
runs the statusline reader whenever `allowance.claude_reader` is not `off`, and under `oauth_usage` the
adapter's own gate names the unimplemented reader while the statusline still runs as the fallback. So
`allowance.claude_reader.statusline`, or a dotted prefix of it, removes the statusline reader in either
mode and keeps statusline readings already in the outbox on the machine. `allowance.claude_reader.oauth_usage`
keeps its existing meaning as the adapter's gate under that mode.

## Adapters

| Adapter | Phase | In this version |
| --- | --- | --- |
| `claude_execution` | 1 | Ported. Buckets; nullable token accounting and recorded effort, tier, speed, reasoning, and cache TTL on `activity.request` at `detail_level` `requests`. The statusline inbox belongs to `claude_account`. |
| `codex_execution` | 1 | Ported. Buckets; embedded `rate_limits` as `allowance.reading` (reader `embedded`, meter `<limit_id>:<minutes>`) and the Codex `allowance` capability row; nullable token accounting and recorded effort, context size, reasoning, and reported totals on `activity.request` at `requests`. |
| `claude_account` | 2 | The Claude allowance meter (parser version `2.0.0+statusline1`). Ingests the statusline inbox, binds each sample by the identity stamped on it, quarantines what it cannot bind, and emits `allowance.reading` (reader `statusline`, meters `five_hour`, `seven_day`, and every model-scoped weekly window `seven_day_<model>`, labelled `Claude · weekly · <Model>`) plus the Claude `allowance` capability row. Its OAuth usage reader is still unimplemented: mode `oauth_usage` does the same statusline work and reports `partial` / `not_implemented`. |
| `codex_account` | 2 | Stub. Preflight reports whether `codex` is on `PATH`. |
| `cursor_execution`, `cursor_account` | 3 | Stubs. Preflight reports whether `state.vscdb` exists. |
| `anthropic_api`, `openai_api` | 5 | Stubs. Preflight reports whether the key is in `secrets.json`. |

Stubs never make a network request, spawn a process, or read a credential.

### The Claude statusline reader

`observatory statusline` runs inside Claude Code, once per render, with no network and no SQLite. It
resolves the Claude config file in order — `OBSERVATORY_CLAUDE_CONFIG_FILE` (a test and override seam),
`$CLAUDE_CONFIG_DIR/.claude.json` (the profile of the session that started it), then `~/.claude.json` —
and hashes the `oauthAccount.accountUuid` it finds there into each sample's `identity_hash`, the same
`sha256(stableJson([provider, account uuid]))` a binding confirms. The uuid itself is never stored. The file is parsed only when its
`stat` changed since `claude-identity-cache.json`, so the usual cost is one `stat`; a signed-out file
caches null, a file over 8 MB is not parsed, and a half-written file yields nothing without touching the
cache. v1 `collect.py` ignores the stamp, and the six-field slot digest excludes it, so an identical
reading is still one reading.

A window is written only when its `(used_percent, resets_at)` differs from the kept reading for that
stamp and window, or that reading is older than fifteen minutes, so an idle meter still proves the hook
runs. Each write is its own part file, `<inbox>/<YYYY-MM-DDTHH>-<observed microseconds>.json`, atomic and
`0600`, so concurrent sessions never share a file; a lost kept-state update costs one duplicate sample,
which the digest removes at ingest. The kept state and the sidecar sit beside the inbox, never inside it,
because v1 `collect.py` parses every file in the inbox as samples. The run — not the reader — prunes the
inbox afterwards, retention `max(local_raw_retention_days, 2)` days by the thirteen-character hour prefix
of each file name, so a blocked or denied reader never lets part files accumulate.

`claude_account` binds a stamped sample to the enabled Claude binding whose confirmed hash equals the
stamp and that is free of identity conflict, whichever account is signed in at run time; several
candidates hold it as `identity_ambiguous` and none as `unpaired_identity`. An unstamped sample binds
only to a lone enabled confirmed binding, and is otherwise held as `identity_unconfirmed` (one binding,
not yet confirmed, recorded as its only candidate) or `identity_ambiguous`. Held samples live in the
schema-8 `allowance_quarantine` table, never appear among the dirty slots, and are re-evaluated every
run: a stamped row is released once its hash binds, an unstamped `identity_unconfirmed` row only to the
candidate binding it was held for once that binding is confirmed, and an unstamped ambiguous row never —
nothing can later establish whose reading it was. Held rows are pruned after
`max(local_raw_retention_days, 7)` days unless their stamp still pairs with an enabled binding's hash. A
digest already stored or already held is skipped before any binding decision.

The run also declines to confirm an identity it cannot attribute: it does not post the local evidence
when a sibling binding of the same install and provider already holds that hash (the Observatory would
answer 409 `identity_taken`), or when another *enabled* sibling of that provider still has a null hash,
because the evidence is then ambiguous between them. Both bindings stay `Unconfirmed` until one candidate
remains — disable one binding in the Observatory, or sign into the other account and run.

The `allowance` capability row reads that evidence first: `disabled_by_setting` / `reader_off`; else,
when this run bound, released, or held a sample or the sidecar shows a recent invocation, the first of
`identity_ambiguous`, `identity_unconfirmed`, `unpaired_identity`, `quarantined_samples`,
`no_samples_offered`, `reader_fallback_statusline`, `hook_config_dir_mismatch`, else `complete` with
`no_recent_samples` when the newest bound sample is older than `max(120, 2 × cadence + 15)` minutes. With
no evidence at all the hook installation speaks: `unsupported` / `hook_not_installed` when no
`statusLine.command` runs the `statusline` subcommand with a `--config-dir` (the executable path is never
matched), `partial` / `hook_config_dir_mismatch` when it names another directory, `unknown` /
`hook_not_executing` when the command is installed but the sidecar is missing or stale — which is where
Windows MSIX redirection shows up. `observatory doctor` prints the same facts in a `claude_statusline`
block: hook state, the directory it names, whether the sidecar exists, its last invocation, invocation
count, offered windows and last publication, and the held samples by reason. Directories and counts only;
never a sample or a transcript path.

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
transcripts (`.../<session>/subagents/*.jsonl`) when `include_subagents` is on. State schema 4 keeps
nullable request counters, pricing evidence, agent attribution, privacy-gated local role names, and
agent lifecycle rows beside the non-null v1 counters. Explicit zero-token Claude calls remain
request rows but are excluded from the legacy bucket query; a Codex token-count row with no numeric
token evidence is not counted as a request.

Claude maps the four `usage` token counters directly, `output_tokens_details.thinking_tokens` to
reasoning, top-level `effort` plus `usage.service_tier` and `usage.speed` to pricing evidence, and
positive `cache_creation` TTL counters to `5m`, `1h`, or `mixed`. Codex subtracts cached and written
input from inclusive input, keeps `reasoning_output_tokens` and `total_tokens`, and maps
`turn_context.effort` plus `model_context_window`. Claude child requests inherit a requested model
when the parent `Agent` tool call records one; Codex local histories expose only the resolved child
model, so their `model_requested` remains null. Missing counters and pricing fields remain null.

Supported Claude and Codex requests carry a hashed agent identity, explicit identity basis,
main/built-in/custom/unknown class, recorded parent, and depth where available. Claude joins parent
spawn calls, tool results, child sidecars, inline sidechains, and nested child paths; Codex uses the
child thread and `session_meta.source.subagent.thread_spawn`. Stable start identities count a
resumed child once, while independent spawn rows retain failed attempts without inventing a child.
Built-in names can be emitted, custom names are either omitted or hashed according to `tool_detail`,
and raw bounded names remain only in local state. No initiator is inferred from a role or tool name.

At `requests_with_tools`, the local readers also emit one invocation row per stable Claude `tool_use.id`
or Codex call identity, plus a separate result row when supported. Claude calls join to the issuing
message; Codex calls join to the following `token_count` when it exists. Duplicate provider rows,
result updates, and wrapper internals do not add headline calls. Tool-only and result-less calls remain
visible, explicit outcomes are classified conservatively, and opaque outcomes remain unknown. Raw
arguments and result content are never stored. Built-in names may be emitted; MCP, function, and custom
names and namespaces are omitted or hashed according to `tool_detail`.

When `companion.json` names knowledge sources, the same in-memory arguments are classified against
their roots and connectors before they are dropped. Claude dispatches by raw tool name (`Read`,
`NotebookRead`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob` with its `path` and the absolute
prefix of `pattern`, `Grep` and `LS` by `path` only, `Bash` and `PowerShell` by `command`, `WebFetch`
by `url` against `url:` connectors, `mcp__<namespace>__*` against `mcp:<namespace>`); Codex reads
`shell_command`, `exec_command`, and `local_shell_call` commands with their `workdir`, `apply_patch`
headers, `view_image` paths, MCP namespaces, and only the `tools.*` calls inside `exec` scripts.
Shell text is tokenized conservatively: heredoc bodies are stripped, `cd` tracks the base for later
segments, and a token counts only when it is absolute (POSIX, drive, UNC, MSYS, WSL, or `~/`),
`./`-relative, or a bare `name.ext` operand of a recognized file command on a single line. Drive,
UNC, MSYS, and WSL forms compare case-insensitively and POSIX paths exactly, decided by the path
text rather than the platform; matching is by component prefix; a working directory only resolves
relative arguments and is never access by itself. `Workflow`, REPL tools, `python -c` bodies, and
`exec` scripts with no recognized call are unsupported rather than guessed. State schema 7 keeps one
row per (invocation, source) with the strongest kind and basis, plus one inspection class per
invocation (`matched`, `unmatched`, `no_evidence`, `unresolved`, `unsupported`, `ambiguous`); no
path, argument, or file name is stored. Each row is stamped `cfg:<16 random hex>`, a token the state
assigns on first sight of that source's configuration digest, so a changed root re-versions rows
without disclosing anything about the root. Rows are emitted at `requests_with_tools` when sources
are configured and `execution.resource_attribution` is not denied, with the invocation's outcome and
subagent rule; a configuration change replays retained transcripts from empty resource tables, and
queued rows under an earlier token or a removed key are marked `superseded_configuration` and never
upload. `observatory resources` is the only place keys, roots, and counts appear together.

The parser version includes a detail generation, and the local scan generation also includes the
subagent setting and the knowledge-source configuration digest. When any of them changes, the state
atomically removes the binding's file checkpoints (and, for a resource change, its local resource
rows) so retained files still eligible under `since` are replayed; interrupted replays resume normally.
Unresolved parse gaps are stored separately, survive a deleted source or checkpoint invalidation,
and clear only after that file is successfully replayed from the start.
Hourly identities and values remain under the v1 parity gate. Coverage adds request,
token-composition, pricing, agent, tool, resource, and allowance capability states — eight dimensions,
the per-adapter maximum — including detail-level gating, partial source history, unmapped tool forms,
truncated tool names, for resources `denied_locally`, `no_resources_configured`, `unsupported_forms`,
`unresolved_paths`, `ambiguous_connectors`, and `scan_partial`, and for allowance the reader-health
codes above. The detail level does not gate the allowance row: an install at `buckets_only` still
reports its meters.

Envelope v2 also defines optional detail blocks for token accounting, pricing, agent attribution,
and explicit project state, plus independent `agent.event`, `tool.event`, and `resource.access`
records. The two execution adapters now emit token accounting, available pricing fields, agent
attribution, supported agent lifecycle events, tool invocation and result events, and resource-access
rows for locally configured sources. The stub producers omit those blocks and remain wire-compatible.
Missing blocks mean the producer did not report that capability; they are not zero, No project, a
main agent, or success.
The server and the `20260913230451_extend_usage_detail_contract.sql` and
`20260914010000_allowance_basis_and_run_counts.sql` migrations must be deployed before shipping a
producer that emits the new variants, the `allowance` coverage dimension included. There is no runtime
version negotiation inside schema version 2, so this server-first order prevents an older server from
retaining an upgraded companion's outbox behind a contract error.

The event semantic keys exclude collector identity and observation time. Invocation and result
events share an invocation key but have distinct semantic keys, so several results or a revised
outcome do not inflate call counts. Resource events upload only a configured key, version, typed
access/evidence/outcome codes, and their invocation join; raw paths, arguments, results, and
content remain local and fail strict validation if added to the wire object.

`surface` follows what the provider wrote: Claude Code's per-line `entrypoint` (`cli`,
`claude-desktop` → `desktop`, `claude-vscode` → `ide`, `sdk-*` → `sdk`; a transcript without the
field counts as `cli`, which every transcript was before the field existed) and Codex's
`session_meta.originator`, then `source` (`codex_cli_rs` → `cli`, `Codex Desktop` and
`codex_work_desktop` → `desktop`, a `vscode` originator or source → `ide`). Desktop-app sessions
of both products therefore land in the same ledger as terminal sessions, distinguished by surface.

The structured `project` block is emitted only when `execution.project_attribution` is `hashed`
(default `off`) and the local deny list permits it. Its basis is `working_directory`, `none`, or
`unknown` for current Claude and Codex local histories. Only explicit `cwd: null` produces `none`;
missing, blank, or malformed values stay `unknown`. `project_hash` remains the compatibility
alias for `working_directory`; both keys are `sha256(["project", cwd])` in the repository's stable
JSON form, where `cwd` is the working directory the transcript recorded (Claude: the line's `cwd`;
Codex: `session_meta.cwd`, updated by each `turn_context.cwd`) with trailing separators trimmed.
The companion records the hash and path together only in its local `projects` table, and
`observatory projects` shows which hash is which folder. Parser-generation replay backfills
retained source evidence when it is still available. The path itself is never uploaded. See
`docs/usage-coverage.md` for what this does and does not cover.

### Decisions made during the port

These settle points the handoff left open or that the port could not follow literally. The
owner can veto any of them.

- **Codex `semantic_key` is the v1 event digest** (`sha256([provider, account, thread id, token_count
  timestamp, cumulative counters])`) even when a turn id is present: one turn contains several
  provider requests, and keying by turn would collapse them into one canonical row.
- **`include_subagents: false` skips Claude Code `subagents/` transcripts entirely** rather than
  counting them without a parent; v1 counted every file, so the default (`true`) keeps parity.
- **The statusline inbox is machine-wide**, so each sample carries the identity of the account
  signed in when it was observed and the run binds it to that account's binding. Attributing the
  inbox to the install's first Claude binding, which this port originally did, was replaced in
  USG-009; a sample that cannot be attributed is held rather than assigned.
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

## The capability report

After every online run — and forced on `setup`, `service install`, and `service uninstall` — the
companion posts `CapabilitiesDocument` (`observatory_contract::capabilities`, the zod authority is
`lib/companion-capabilities.ts`) to `POST /api/v1/companion/capabilities` with the install key. It
says what this build can do and what it is running under: build version, target and scheduler kind;
each of the eight adapters with `implemented`, the modes it implements (`claude_local_logs`,
`codex_local_history`, `embedded`, `statusline`, …), its parser version, and whether the local deny
list removes it; feature lists (detail levels, tool detail, project attribution, hooks, schedulers,
`live_mode`, `detailed_monthly_report`, `account_history`); the effective settings (applied settings
version, config source `server` / `cache` / `defaults`, paused, detail level, tool detail, project
and resource attribution, reader per provider, `resources_configured`); the recognized local deny
entries as dotted mode paths plus a count of unrecognized ones; discovery booleans; per-binding
identity state; the detailed report's configuration and last outcome per binding; the schedule read
back from the OS (`installed` / `not_installed` / `unreadable`, interval, config directory pinned);
queue depth; and backfill progress. Every field is a closed enum, a counter, or an id — the strict
Rust type and the zod schema both reject a path, token, label, or free-text entry, and the synthetic
corpus under `tests/fixtures/usage-v2/capabilities/` is checked on both sides.

The post is best effort: a dry run or `--offline` skips it, a failure is reported in the run summary
(`capabilities.error`, a code such as `http_401`, `timeout`, or `transport`) and never blocks the
upload, and an unchanged digest (queue depth excluded) is re-posted only once a day as a heartbeat.
`observatory run` prints the outcome under `capabilities` and the schedule verdict under `schedule`;
the site turns them into support chips on Settings → Collection, the health ladder on Settings → Connections, and the
`cadence pending` action.

## What is uploaded

Counters, hashed identifiers, model names, allowlisted or hashed tool names, allowance readings,
provider aggregates and charges, coverage codes, versions, only when project attribution is
`hashed`, a hash of each request's working directory, and, only for knowledge sources configured
in `companion.json` at `requests_with_tools`, each matched call's source key, opaque configuration
token, and typed access, evidence, and outcome codes. Never: prompts, responses, file paths,
vault roots, connector ids, repository names, credentials, raw provider payloads, free-text errors. Credentials are
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
- Snapshots of each collecting adapter's normalized output (both execution adapters and
  `claude_account`) live in `crates/observatory-adapters/tests/snapshots/`; review a change with `cargo insta review` or
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
fails loudly. The identity endpoint answers 409 both for a hash the Observatory has not approved for
that binding and for one a sibling binding of the same install and provider already holds
(`identity_taken`). The companion normally avoids the second case by not posting a hash a sibling
holds; a refusal it does receive is treated as an identity conflict, so the binding waits rather than
taking another account's readings.

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
