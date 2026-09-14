# Changelog

All notable changes to the `observatory` companion. Tags are `observatory-v<version>`.

## Unreleased

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
