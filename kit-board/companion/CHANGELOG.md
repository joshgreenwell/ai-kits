# Changelog

All notable changes to the `observatory` companion. Tags are `observatory-v<version>`.

## Unreleased

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
- Model-scoped weekly allowance windows (`seven_day_<model>`) from the Claude Code statusline are
  published beside the pooled windows, labelled `Claude · weekly · <Model>`.
- The `detailed_monthly_report` setting runs the kept v1 analyzer adapter
  (`scripts/telemetry/detailed_report.py`) per binding that names it in `companion.json`;
  `setup` carries a v1 connection's `detailed_report` block over.
- A binding whose server identity hash is null is re-confirmed with the locally observed evidence
  on the next run; a hash the Observatory has not approved is refused and pauses the binding.
