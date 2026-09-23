# Changelog

All notable changes to the `observatory` companion. Tags are `observatory-v<version>`.

## Unreleased

Ships as 2.2.0 (the workspace version is already 2.2.0; date this section when the tag is pushed).

- App projects and readable names. Each run now builds three side record types after the
  adapters, on one carrier binding (the smallest binding id the Observatory registered), with
  parser version `2.2.0+sides1`: `project.catalog` (the projects the owner created in the Codex
  desktop app, read-only from `state_<N>.sqlite` and `.codex-global-state.json`, keyed by an
  unkeyed app-project digest; a project that disappears from a successful read becomes a `removed`
  tombstone), `project.membership` (which app project each ledger session hash and folder key
  belongs to, session first, following the app's own assignment order; worktrees resolve to their
  main repository and the answer is kept in `member_paths`, so a deleted worktree keeps its
  project; Claude and Cursor folders under a Codex project root belong to that project), and
  `name.label` (the readable name beside each hashed tool, namespace, and custom agent name, the
  role of each Codex subagent session including `guardian`, and each Cursor composer). Names never
  enter a ledger record and no key changes. `tool_detail` and `project_attribution` gate them; a
  store that cannot be read produces none and the previous ones stand. A record the Observatory
  defers is marked locally and counted by `doctor`; every produced record is sent again weekly. The
  capability document reports `features.labels`.
- Codex MCP calls made from inside an `exec` script (`item_completed` `McpToolCall`) are collected
  as `tool.event` invocations and results linked to the open `exec` (`parent_invocation_key`), only
  when exactly one `exec` is open. They are marked `nested_mcp` in `local_tool_events.origin` and
  never count toward a request's `tool_calls` or `tools[]`, so no request record changes.
- `PowerShell` and `NotebookRead` travel readable in `tool.event` records (their rows are revised
  once); the request `tools[]` list is unchanged. The classification and upload lists moved to
  `observatory_core::builtins`, pinned by a golden test against the 2.1.0 functions.
- `observatory projects --apps [--samples]` prints how app projects, folders, and sessions resolve,
  as counts. `observatory upgrade-gate --state <copy> --cutoff <rfc3339> [--baseline <copy>]` checks
  a dry-run copy of the state before an upgrade and exits 3 on any ledger change the release does
  not allow. With `--baseline`, history is what the previous build had read (a re-keyed instant,
  or a line at or before where it read that session and agent to), so activity the last run had
  not read yet, including a `partial` run's backlog, is not a false failure.
- The parser version moves with the crate version, so the first run replays retained transcripts.
  That replay is now quick: copying an agent's profile onto its stored requests scanned every
  request row on each request line (no index on `agent_key`) and rewrote rows that already held the
  values. Both tables gain an index and the copy touches only rows that differ; stored content is
  unchanged. On this project's largest state (45,000 requests, 5.7 GB of Codex rollouts) a full
  replay went from about 0.7 MB/s (hours, over many runs) to under a minute.
- State schema 9: new tables `agent_labels`, `codex_session_sources`, `member_paths`,
  `app_projects_seen`; new columns `local_tool_events.origin` and `records.deferred_at`.

## 2.1.0 — 2026-09-21

- The state database now waits up to four minutes for its write lock instead of five seconds. Adapters run in parallel over one file, and a large re-emission held the lock long enough for the Claude adapters to fail with `state_error` on the first run after upgrading.

- Cursor local requests are stable and incremental. Every `cursor_execution` record uploaded since
  2026-09-18 carried the run's clock as `observed_at` and `ended_at`: current Cursor builds write a
  bubble's `createdAt` as an ISO-8601 string, the reader parsed it as an integer, got nothing, and fell
  back to `now`; the content hash covers `ended_at`, so each hourly run stored every bubble as a new
  revision (392,397 `activity_requests` rows for 8,785 records in production). The reader now observes a
  bubble at its own `createdAt` (integer milliseconds or RFC 3339 text), else at the owning composer's
  `createdAt` read from `composerData:<composer_id>` in SQLite (bodies never loaded), and skips a bubble
  the store holds no time for, counting it as malformed (coverage `partial`, `parse_error`) instead of
  substituting a clock; `ended_at` is that same store time. Bubbles whose four counters are all zero,
  which is what current builds write for nearly every message, carry no usage evidence and are skipped:
  the local store yields request existence only, the capability rows report Requests `unknown` and
  TokenComposition `unsupported` with `local_counters_zero` when nothing in a store has tokens, and
  Cursor token evidence comes from the hosted `cursor_account` reader. Each binding remembers the
  content digest it last emitted per record in the new `cursor_emitted` state table (written by the run
  only after the records are persisted, under a fingerprint of emission shape, parser version, and
  detail level in `emitted:cursor_execution:<binding>`) and emits only new or changed bubbles; a
  fingerprint change re-emits everything once. The parser version moves to `+cursor-local2`, so the
  first run of this build re-emits each token-bearing bubble once at its store time and the server can
  tell the fixed rows from the revisions the previous build uploaded. Existing local state needs no
  migration; the table is created on open.
- Privacy: project keys and hashed custom tool, MCP, function, and agent names are now
  HMAC-SHA256 under a random 32-byte key each install creates on its first run and keeps in
  the state database (`meta.privacy_salt`). They were plain `sha256([label, value])` over a
  public construction, so anyone with read access to the Observatory database could confirm a
  guessed working directory or tool name by hashing it. The key is never uploaded, logged, or
  shown by `status`, `doctor`, or `projects`; it survives re-pairing and changes only with a new
  state file, which then changes every key this machine uploads. Output formats are unchanged
  (64 hex digits for `project.key` and `project_hash`, `h:` plus 16 hex digits for names), so
  the server contract does not move. Consequences: the first run of this build re-keys the
  project keys and tool hashes already stored in its state (from the paths and names kept
  beside them) and re-emits every detail record once under the new keys (emission shape `2`);
  project labels assigned on the Observatory to the old keys do not carry over (a no-op today,
  since production has never held request rows); the same custom tool now hashes differently on
  every machine, so the Tools card shows one row per machine for it, and the same MCP tool
  hashes the same way from Claude and Codex on one machine; a name longer than 400 characters is
  hashed after bounding, like the stored name. Session, agent, and provider account identifiers
  stay plain SHA-256. Adds the `hmac` crate.
- Outbox: a body the Observatory refuses on its content (a 4xx other than 401, 403, 408, or
  429) no longer blocks the queue forever. The upload
  bisects it (coverage first, then halves) until the refused record or bucket stands alone,
  marks that record `http_<status>` locally (never retried, like a
  server rejection), records a refused bucket as published at its refused digest so it stays
  local until its totals change, drops the isolated body, and continues with the rest of the
  queue. At most 24 bisections per queued body per run; accepted halves are acknowledged, so
  the body rebuilt next run only carries what is still unacknowledged. Transport failures,
  5xx, 408, and 429 still stop the run and retain everything; 401 and 403 stop it because no
  other body would be accepted. The run summary's `publication` (shown by `status`) gains
  `rejected_bodies`, `isolated_records`, `isolated_buckets`, `splits`, and `rejection`.
- Execution readers emit detail records incrementally instead of rebuilding, hashing, and
  upserting every request, agent, tool, and resource record on every run. The four local event
  tables gain a `change_generation` column (existing files migrate in place; SQLite triggers
  stamp every insert and update, including cascades such as a result revising its invocation
  or a profile revising its events), a run advances the generation before its adapters write
  and again after their records are persisted, and each reader keeps a per-binding mark
  (`emitted:<adapter>:<binding>` in `meta`, stored only after persistence) of the generation
  and settings fingerprint it last emitted under. A run emits the rows written since, the
  records that depend on them (a request whose tool calls changed, a resource access whose
  invocation changed), and any row without a record; a parser version, detail level, tool
  detail, subagent, project or resource attribution, or resource configuration change re-emits
  everything once. Per-request tool summaries come from an index built once per binding
  instead of a pass over every tool row per request, and the changed-bucket check reads a
  binding's published digests in one query instead of one per bucket. The adapter's
  `records` count in the run summary now means records emitted this run.
- Cursor hosted allowance splits Auto vs API from each named `*PercentUsed` field on
  `/api/usage-summary` (skipping combined `totalPercentUsed` when those pools exist). Hosted
  events store a token total equal to the exclusive classes present so Tokens can count them;
  the event `model` is stored as reported. The statusline hook and Claude OAuth reader accept
  Claude Code's `limits` array (`weekly_scoped` → `seven_day_<slug>`), so Fable's extra weekly
  window does not require the website. Grok 4.6 list prices live in the xAI pricing catalog;
  models without a rate still keep their token columns. `allowance.claude_oauth_keepalive`
  (off by default) may spawn Claude Code invisibly (`claude auth status`) so Claude Code
  refreshes its own OAuth store; Observatory never POSTs a refresh_token. `oauth_usage`
  still falls back to statusline, and Connections / Allowances say so when OAuth failed.
- Provider coverage (USG-027–031): Cursor local counters and hosted usage/allowance, Codex
  app-server rate limits, Claude OAuth usage, and OpenAI/Anthropic Admin usage and cost. Parser
  versions `+cursor-local1`, `+cursor-hosted1`, `+appserver1`, and `+admin-usage1`; Claude OAuth
  keeps `+statusline1`. Cursor hosted reads `GET https://cursor.com/api/usage-summary` and
  `POST /api/dashboard/get-filtered-usage-events` with `Origin: https://cursor.com`, and current
  `state.vscdb` builds store session fields as split `cursorAuth/*` scalars. Codex app-server
  speaks newline-delimited JSON and is discovered from the Windows desktop install when it is
  not on PATH. `web_backend` stays unimplemented. Tokens query unions `account_usage_buckets`
  with local hours without summing them as the same work. Tasks stay Planned until a real
  authorized receipt exists.
- Windows collection is silent: `service install` registers a Task Scheduler job that starts
  `observatory.exe` directly (the previous `schtasks /TR` form can wrap the command in `cmd.exe`).
  The release binary is a Windows-subsystem process, so the scheduled run itself has no window,
  while a terminal still sees CLI output. Child analyzer processes (`python`, `powershell`) are
  started with `CREATE_NO_WINDOW`.
- Capability report: after every online run, and on `setup` / `service install` / `service uninstall`,
  the companion posts a strict `CapabilitiesDocument` (build, implemented adapter modes, features,
  effective settings, recognized deny entries, binding identity states, detailed-report status, the
  schedule read back from the OS, queue depth, backfill) to `POST /api/v1/companion/capabilities`.
  Codes, counts, and ids only; dry runs and `--offline` skip it; an unchanged document is re-posted
  once a day. `run`, `status`, `doctor`, and `service *` print a `schedule` verdict (installed versus
  desired cadence, config directory pinned, the action when they differ). A panicking adapter now
  reports a `failed` coverage row with the new `adapter_panicked` detail instead of vanishing. The
  default Codex reader is `embedded` (the implemented one), `setup` no longer offers the stub
  private-interface readers, and the server-side `20260914020000_companion_capabilities.sql`
  migration must be deployed before a build that posts the report is installed (the post fails
  soft until then).
- Extended envelope v2 compatibly with optional reported-total accounting, pricing, agent, and
  explicit project-state blocks; independent agent lifecycle, tool invocation/result, and
  privacy-safe resource-access events; and per-adapter capability coverage. Legacy producers
  continue to serialize the original shape until their collection stories are implemented.
- Knowledge sources: `companion.json` gains `resources` (`key`, `label`, `roots`, `connectors`,
  `source`), `setup` proposes each Obsidian vault from the application's registry as
  `obsidian.<vault id>` (never under `--yes`), and `observatory resources [add|remove]` lists and
  edits them on the machine. Supported Claude and Codex tool calls are classified against the roots
  and `mcp:`/`url:` connectors while their arguments are in memory; state schema 7 keeps one
  (invocation, source) row and one inspection class per invocation, never a path. Rows upload at
  `requests_with_tools` as `resource.access` with the key, an opaque random `cfg:` configuration
  token, access kind, evidence basis, outcome, and invocation join; the local deny entry
  `execution.resource_attribution` keeps them on the machine; a configuration change replays
  retained transcripts and marks stale queued rows `superseded_configuration`. `doctor` reports
  `resources_configured`, `resources_invalid`, `obsidian_config_found`,
  `resource_attribution_effective`, and `resource_attribution_reason`; the execution parser version
  moves to `+v1.1.0-detail5`, so retained transcripts replay once.
- Allowance coverage: `CapabilityDimension` gains `allowance` and the per-adapter maximum rises from
  seven capability rows to eight. Envelope v2 has no runtime negotiation, so the server and the
  `20260914010000_allowance_basis_and_run_counts.sql` migration must be deployed before a companion
  that reports the row is installed.
- The Claude statusline allowance reader moved from `claude_execution` into `claude_account`
  (parser version `2.0.0+statusline1`, channel `hook_snapshot`, reader `statusline`; record ids
  unchanged). `allowance.claude_reader` now gates that adapter, `off` being the only value that stops
  it; mode `oauth_usage` also calls the private OAuth usage interface and keeps the statusline
  reader running as the documented fallback. The local deny entry `allowance.claude_reader.statusline`, or a
  dotted prefix, removes the reader in either mode and holds queued statusline readings on the machine.
  `codex_execution` reports the Codex embedded row.
- Allowance identity: `observatory statusline` stamps each sample with the account signed in when it
  observed the reading, resolving the Claude config file as `OBSERVATORY_CLAUDE_CONFIG_FILE`, then
  `$CLAUDE_CONFIG_DIR/.claude.json`, then `~/.claude.json`, and caching its evidence by `stat` in
  `claude-identity-cache.json`. The run binds a stamped sample to the binding holding that hash,
  whichever account is signed in by then, and holds what it cannot attribute in the schema-8
  `allowance_quarantine` table as `identity_ambiguous`, `identity_unconfirmed`, or `unpaired_identity`
  rather than assigning it to the install's first Claude binding. Held rows are re-evaluated every run,
  released only to a binding that can own them, and pruned after `max(local_raw_retention_days, 7)`
  days unless their stamp still pairs with an enabled binding. The local replay key includes the stamp,
  so equal meter readings from two accounts remain distinct. The run also skips confirming an identity
  a sibling binding already holds, or that two enabled unconfirmed siblings could both claim.
- The statusline hook writes one part file per changed reading
  (`<inbox>/<YYYY-MM-DDTHH>-<observed microseconds>.json`) instead of overwriting an hour file, on a
  changed `(used_percent, resets_at)` or every fifteen minutes, with the kept state
  `claude-statusline-latest.json` and the sidecar (now carrying `last_offered_at` and
  `offered_windows_ever`; `published_windows` means written this invocation) beside the inbox. The run
  prunes the inbox after the adapters, retention `max(local_raw_retention_days, 2)` days, even when the
  reader is denied. `setup` installs the hook into `$CLAUDE_CONFIG_DIR/settings.json` when that
  variable is set.
- `doctor` gains a `claude_statusline` block (hook state and the configuration directory it names,
  sidecar presence and counters, held samples by reason) and an `--offline` flag mirroring
  `run --offline`.

### 2.0.0 (phase 1: core)

- Workspace `kit-board/companion/` with four crates: `observatory` (binary), `observatory-contract`
  (wire types for envelope v2 with the vendored JSON Schema), `observatory-core` (config, settings,
  state, sink, outbox, HTTP, lock, service), `observatory-adapters`.
- Commands: `connect`, `setup`, `run [--dry-run] [--offline]`, `service install|uninstall|status`,
  `statusline`, `hook claude|cursor`, `status`, `doctor`, `settings show`, `version`. `serve` is a
  placeholder for a later phase.
- `claude_execution` and `codex_execution` ported from `collect.py` v1.1.0 with the parity corpus
  and `expected.json` gate; embedded Codex rate limits and the Claude statusline inbox as
  `allowance.reading`; `activity.request` at `requests` detail.
- Project attribution: with `execution.project_attribution: hashed`, each `activity.request`
  carries `sha256(["project", cwd])` of the transcript's working directory, never the path;
  `surface` follows Claude Code's `entrypoint` and Codex's `originator`, so desktop-app sessions
  are told apart from terminal sessions. State schema 2 adds `events.project_hash`,
  `events.surface`, and the local `projects` table (a version 1 state upgrades in place);
  `observatory projects` lists hash and path on this machine only.
- Contract-conformant stubs for `claude_account`, `codex_account`, `cursor_execution`,
  `cursor_account`, `anthropic_api`, `openai_api` (parser version `0`, `unrecognized_payload`).
- Schedulers: LaunchAgent, Task Scheduler, systemd user timer; v1 schedule detection and removal.
- CI: fmt, clippy, tests, fixture and parity checks, `cargo deny`, informational statusline and
  backfill timings on three operating systems; cargo-dist configuration for `observatory-v*` tags.
- `platform-tls` cargo feature (default on) selects the operating-system trust store; a build
  without it (`scripts/cross-macos-from-windows.sh`) uses the bundled Mozilla roots and reports
  `"tls_roots": "webpki"` in `doctor`.
- `connect --since YYYY-MM-DD` sets the backfill start before the first run pins it.
- The scheduler entry and the statusline hook pin `--config-dir`; `connect` and `setup` refuse a
  directory that a packaged app redirects into its private store (`doctor` reports
  `config_dir_virtualized`); the analyzer step never picks the Store Python.
- Allowance readings whose reset lies beyond their window are dropped by the hook and rejected by
  the contract; stub adapters report `not_implemented` instead of `failed`; write transactions
  open with `BEGIN IMMEDIATE` so concurrent adapters wait instead of failing with `state_error`.
- Model-scoped weekly allowance windows (`seven_day_<model>`) from the Claude Code statusline are
  published beside the pooled windows, labelled `Claude · weekly · <Model>`.
- The `detailed_monthly_report` setting runs the kept v1 analyzer adapter
  (`scripts/telemetry/detailed_report.py`) per binding that names it in `companion.json`;
  `setup` carries a v1 connection's `detailed_report` block over.
- A binding whose server identity hash is null is re-confirmed with the locally observed evidence
  on the next run; a hash the Observatory has not approved is refused and pauses the binding.
