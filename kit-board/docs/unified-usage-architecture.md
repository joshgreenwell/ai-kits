# Unified usage system architecture

Designed 2026-09-12 against `f713f74` on `feat/epic-hypatia-0j03mx`; revised the same day, first from
Python to a compiled binary after the owner asked for the best tool rather than the easiest, then from
Go to Rust after the owner decided the companion will be maintained by agents (section 3 records both
decisions). This is the implementation
architecture for collecting AI usage across Claude, Codex/ChatGPT, Cursor, and the two direct API
billing families into one Observatory, using the September 11 collection research as the option
catalog (its `C*`, `O*`, `U*` option identifiers are reused below). **Browser-based collection is out
of scope for this design.** The existing Claude browser extension keeps working unchanged under the
v1 contract; nothing here extends, replaces, or removes it.

Companions: [usage collection](usage-collection.md) describes the v1 collectors that stay in service
during migration; [architecture](architecture.md) describes the Observatory's hosting, data ownership
and security boundaries, all of which this design inherits.

---

## 1. Decision summary

Build **one companion program per machine** that contains every non-browser integration as an
internal adapter, publishes to **one versioned wire contract**, and lands in **four independent
ledgers** in the existing Supabase `personal_hub` schema. Collection modes are **settings stored in
the Observatory**, edited from the UI, fetched by the companion on every run, and further
restrictable by a local deny list on each machine. The user installs once per machine, confirms what
the companion discovered, and then does nothing recurring.

| Decision | Choice | Why |
| --- | --- | --- |
| Companion language | **Rust**, one static binary named `observatory`, no runtime dependency, real SQLite statically linked | The hook paths (statusline, tool hooks) run hundreds of times per session and block the agent while they run; a compiled binary costs a millisecond where an interpreter costs tens. The code will be maintained by agents, so the compiler must catch the two mistakes this contract cannot tolerate: a missing counter read as zero, and an unhandled enum case. See section 3. |
| Companion distribution | **cargo-dist** from tags `observatory-v*` to GitHub Releases with checksums and Sigstore provenance; **Homebrew tap** (macOS, Linux), **Scoop bucket** (Windows), shell and PowerShell installers for hosts without a package manager | Package-manager installs avoid the browser-download quarantine and Gatekeeper path, give the user `brew upgrade` / `scoop update`, and keep a stable binary path for the scheduler. |
| Server language | **TypeScript** (Next.js 16 App Router, zod 4, postgres.js), unchanged | Existing app, auth, ingestion, and database queue. |
| Cross-language contract | **JSON Schema generated from the zod contract** with `z.toJSONSchema`, vendored into the companion, enforced against **serde wire types** by fixture and schema-validation tests in CI | The v1 wire is `.strict()` in four places; a companion that sends a field the server rejects is an outage on every machine. Shared fixtures make drift a CI failure on both sides. |
| Ledgers | Request activity, account usage, allowance, money: **four tables, never summed together** | Different denominators, grains, and provenance. A quota percentage is not tokens; a provider aggregate is not extra sessions. |
| Hourly partition | **Keep the v1 `token_bucket_revisions` ledger and `bucketSchema` exactly as they are**; the companion emits v1-compatible buckets plus richer request records | The live dashboard and its canonical query keep working; v1 collectors and the companion dedupe naturally because both compute the same `session_hash`. |
| Identity | Observation identity (which collector saw it) is separate from **semantic identity** (which provider request it was) | Two channels observing one request must dedupe; channel-prefixed keys make that impossible. |
| Settings | Server-side settings document (global defaults + per-install overrides), **local deny list wins**, prerequisites decide the rest | The owner can turn modes on and off from the Observatory without touching each machine, and a machine can refuse a mode regardless. |
| Credentials | The companion **reads** existing app sign-ins where a mode permits, **never refreshes, copies, or uploads** them; API Admin keys live in a separate local 0600 file | Reuse reduces setup friction; refresh contention and broad-scope tokens are the two real hazards. |
| Browser | **Excluded** | Separate product decision; v1 browser connections continue as-is. |

---

## 2. Scope

**In scope.** Local execution history for Claude Code, Codex, and Cursor; account allowance through
the Codex app-server, the Claude OAuth usage endpoint, and the Cursor usage-summary endpoint; Cursor
account usage-event history; Claude Code statusline snapshots; the Anthropic and OpenAI
organization usage and cost APIs for separately billed API traffic; settings; setup; scheduling on
macOS, Windows, and Linux; the four ledgers; canonical selection and reconciliation; coverage
reporting; dashboard changes needed to show per-model, per-source, per-tool, and allowance detail
that the new ledgers make available.

**Extension points, not built in the first delivery.** Claude Enterprise analytics (C6), Claude Code
Analytics (C5), Claude spend limits (C8), Codex Analytics (O5), OpenAI Compliance Logs (O6), OpenAI
monthly usage limits (O9), Cursor Admin API (U3), Cursor Enterprise OpenTelemetry (U4), Claude
Code/Cowork OpenTelemetry intake (C2 telemetry), Codex OpenTelemetry (O8), and a live daemon mode for
Codex `thread/tokenUsage/updated`. Each maps onto an adapter slot and a ledger defined here and needs
only a configured credential plus an adapter module.

**Out of scope.** Browser extensions, browser automation, browser response capture, and any manual
recurring export/import workflow. Manual import remains a possible later backfill feature and does not
count toward coverage.

---

## 3. Language and distribution recommendation

### The efficiency question, answered per workload

"Efficient enough" has two different answers depending on what the companion is doing at the time.
Figures are estimates from the v1 measurements in `schedules.md` and typical process start-up costs;
phase 1 measures them on the owner's machines (section 12).

| Workload | Python (stdlib, zipapp) | Compiled binary (Rust) | Does it decide anything? |
| --- | --- | --- | --- |
| First backfill of a month of JSONL (hundreds of MB to a few GB for a heavy Claude Code user) | Tens of seconds. A byte prefilter plus the C JSON parser keeps it close to I/O bound; v1 measured 4 s for Codex and 1 s for Claude on one Mac. | A few seconds with the same strategy. | No. Once per machine. |
| Hourly incremental run | Well under a second (v1: 0.5 to 0.6 s scan). | Under 0.1 s. | No. |
| Statusline hook, invoked on every Claude Code redraw, debounced at roughly 300 ms, hundreds to thousands of times per session | 50 to 100 ms of interpreter start per invocation, 25 to 40 MB resident each time. | About 1 ms, a few MB. | **Yes.** Measurable CPU and battery cost on a laptop and visible lag in the status bar. |
| Tool hooks (Claude Code `PreToolUse`/`PostToolUse`, Cursor hooks), which run synchronously and block the tool call until the hook exits | Adds 50 to 100 ms to every tool call. | Adds about 1 ms. | **Yes.** This is user-visible latency inside the agent. |
| Live daemon (`serve`) holding a Codex app-server subscription | Fine; 30 to 40 MB resident. | Fine; 3 to 6 MB resident. | Minor. |
| Eight adapters with independent deadlines, in parallel | Threads and hand-rolled deadlines. | Scoped threads with per-adapter deadlines; no async runtime needed. | Quality, not speed. |
| Windows machines | Requires a Python install and interpreter path pinning; the v1 guide spends a page on it. | One `.exe`, no runtime. | **Yes.** Setup friction and support load. |

Python is efficient enough for batch collection and is the wrong tool for the hook paths. The hook
paths are exactly where a usage collector touches the user's agent session, so they decide.

### Two corrections to earlier drafts

The first draft rejected a compiled binary on distribution grounds: an unsigned binary downloaded by a
browser is quarantined and Gatekeeper blocks it. That is true for browser downloads and irrelevant
for package managers. Homebrew formulae and curl-based installers do not set the quarantine attribute,
Scoop and winget installs never go through the browser-download path, and command-line binaries
launched by Task Scheduler or a terminal do not get the SmartScreen dialog that Explorer shows. With
a tap and a bucket, the distribution cost that tipped the first draft toward Python disappears.
Code signing (Apple Developer ID, Authenticode) stays optional and can be added later.

The second draft chose Go over Rust on a smaller dependency tree, a simpler daemon, and trivial
cross-builds, judging that Rust's compile-time advantages could be closed in Go by review discipline.
The owner then decided the companion will be written and maintained by agents. That changes the
weighting: review discipline is exactly what cannot be assumed, and the compiler is the reviewer that
is always present. Rust is the choice.

### Why Rust for an agent-maintained collector

| Factor | Rust | Go | Weight once agents maintain the code |
| --- | --- | --- | --- |
| "Null, never zero", the rule behind every counter in the contract | `Option<u64>` through serde round-trips `null` exactly; a missing field and a zero cannot be confused | `encoding/json` decodes a missing field to `0` unless every nullable is a pointer or custom type | Decisive. This is the single most likely agent mistake and the one the ledgers cannot tolerate |
| Exhaustive handling of the nine coverage states, six meter kinds, four record types, seven money kinds | `match` must cover every variant or the build fails | A linter can warn; the language does not | Decisive. An added variant cannot be silently ignored |
| Unknown fields on the wire | `#[serde(deny_unknown_fields)]` mirrors the server's `.strict()` | Silently dropped by default | High |
| Error handling | `Result` and `?`; an ignored error is a compiler warning promoted to an error in CI | `if err != nil` by convention; an ignored error compiles cleanly | High |
| Data races in the parallel adapter run | Rejected at compile time | Detected only when the race detector happens to observe them | Medium |
| SQLite engine | `rusqlite` links the real SQLite amalgamation | A transpile of SQLite to Go; correct, slower, very large | Medium; Cursor's `state.vscdb` can be hundreds of MB |
| Hook start-up, resident memory, binary size | About 1 ms, 3 to 6 MB resident, 6 to 10 MB binary | 2 to 5 ms, 8 to 15 MB, 15 to 25 MB | Low; both are far better than an interpreter |
| Dependency tree for a binary that reads sign-in tokens | Larger (TLS, serde, SQLite, CLI); mitigated below | Standard library covers HTTP, TLS, JSON | Real, and answered by `cargo deny`, a committed lockfile, no async runtime, and OS trust-store verification |
| Daemon concurrency (`serve`) | Scoped threads and channels; no tokio | Goroutines and `context` | Low; the daemon is a later phase and the thread model is sufficient |
| Cross-building six targets | Native runner per OS through cargo-dist | One runner, `GOOS`/`GOARCH` | Low; cargo-dist owns it |
| Build time | 1 to 3 min clean, seconds incremental | Seconds | Low; agents wait, people do not |

Python is kept as the fallback in the record, not as an option: efficient for batch work, wrong for
hooks, and a runtime to install on Windows. Node needs a runtime on collecting machines and was never
a candidate.

### Recommendation

- **Rust stable**, edition 2024, MSRV pinned in `rust-toolchain.toml`, workspace at
  `kit-board/companion/`, binary name `observatory`, `#![forbid(unsafe_code)]` in every crate.
- **Crates, deliberately few**: `clap` (CLI), `serde` and `serde_json` (wire and provider payloads),
  `rusqlite` with the `bundled` feature (own state, Cursor databases), `ureq` with `rustls` and the
  platform trust-store verifier (provider and Observatory HTTPS; blocking, no async runtime), `jiff`
  (RFC 3339 and time zones), `sha2` and `uuid` (identity), `plist` (LaunchAgent), `thiserror` (typed
  errors), `tracing` (structured logs of codes and counters only), `jsonschema` (contract validation in
  tests), `insta` (golden tests for parser output). `Cargo.lock` is committed; `cargo deny` enforces
  the advisory database, a license allowlist, and duplicate-version bans in CI.
- **Targets**: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`,
  `aarch64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, each built on a
  native runner by cargo-dist so the bundled SQLite compiles with the target's own toolchain.
- **Releases** from tags `observatory-v<version>` by cargo-dist: GitHub Release with per-target
  archives and SHA-256 checksums, GitHub artifact attestations (Sigstore provenance), a Homebrew
  formula pushed to `joshgreenwell/homebrew-tap`, and shell and PowerShell installers for hosts
  without a package manager. The Scoop manifest in `joshgreenwell/scoop-bucket` carries `checkver` and
  `autoupdate` entries, so the bucket's scheduled action tracks each release without a manual step. A
  winget manifest is an optional later channel because it requires community-repository review.
- **Install commands**: `brew install joshgreenwell/tap/observatory` on macOS and Linux;
  `scoop bucket add joshgreenwell https://github.com/joshgreenwell/scoop-bucket` then
  `scoop install observatory` on Windows; the release archive with checksum for CI runners and
  containers.
- **Upgrades** are the package manager's job: `brew upgrade observatory`, `scoop update observatory`.
  Homebrew and Scoop keep a stable binary path (`/opt/homebrew/bin/observatory`, the Scoop shim), so
  the installed scheduler entry never breaks. The Observatory shows "update available" when an
  install's reported version is behind the latest release. There is no self-update code in the binary.
- **Keychain access stays a subprocess.** The Claude Code credential item was created through the
  `security` command, so `/usr/bin/security` is already in its access list. Reading it through the
  Security framework from our own binary would trigger an access prompt on every new build and fail
  silently under a LaunchAgent; `security find-generic-password` does not.
- **Python remains only for the optional detailed monthly analyzers**, which the companion runs as
  subprocesses when that setting is on. Python stops being a requirement for the core.

### Workspace layout

| Crate | Contents |
| --- | --- |
| `observatory` (binary) | `clap` command tree; each subcommand is a thin function over the library crates |
| `observatory-contract` | Wire types for the v2 envelope as serde structs and one tagged enum on `record_type`, `deny_unknown_fields` everywhere, newtypes for SHA-256, UUID, and timestamps; the vendored `usage-v2.schema.json`; validation helpers used by tests |
| `observatory-core` | `config` (local file, deny list), `settings` (fetch, cache, merge), `discovery`, `credentials`, `state` (rusqlite), `sink` (validation, identity, isolation), `outbox`, `http`, `lock`, `service` (LaunchAgent, Task Scheduler, systemd user timer) |
| `observatory-adapters` | One module per adapter in section 5 behind the `Adapter` trait |

```rust
pub trait Adapter: Send + Sync {
    fn id(&self) -> AdapterId;
    /// Prerequisites and credentials, reported as a coverage state; never performs collection.
    fn preflight(&self, ctx: &RunContext) -> Preflight;
    /// Emits normalized records into the sink and returns coverage plus the next cursor.
    fn collect(&self, ctx: &RunContext, cursor: Option<Cursor>, sink: &mut dyn Sink) -> Result<Outcome, AdapterError>;
}
```

### Command surface

`observatory connect` (pair this machine with a one-time code), `setup` (discovery, bindings,
confirmations, first run, scheduler), `run` (one collection cycle), `serve` (later phase), `service
install|uninstall|status` (LaunchAgent, Task Scheduler, systemd user timer), `statusline` (Claude Code
statusline command), `hook claude|cursor` (tool hook receivers), `status`, `doctor`, `settings show`,
`version`. The statusline and hook subcommands do no network I/O and no SQLite writes beyond an
append to the local inbox; they exit in about a millisecond so a defect elsewhere cannot slow an
agent session.

### Contract sharing

`lib/usage-contract.ts` is the single authority. A build step exports it with `z.toJSONSchema` to
`lib/generated/usage-v2.schema.json`; the same bytes are vendored at
`companion/crates/observatory-contract/schema/usage-v2.schema.json`, and a CI step fails when the two
differ. The Rust wire types are written by hand as serde structs, because that is the code agents will
read and edit, and the schema is enforced against them three ways in `cargo test`: every fixture in the
shared corpus deserializes into the types and re-serializes byte-stable; every envelope the companion
can build validates against the vendored schema with the `jsonschema` crate; every fixture labeled
invalid is rejected by both the Rust types and the schema. Refinements that JSON Schema cannot express
(the exclusive token sum, future timestamps, reset after observation) are implemented as constructor
checks on the Rust types and exercised by the same fixtures that `npm test` feeds to the zod schema.
Same fixture, both languages, both verdicts. `cargo typify` may be used once to scaffold the types, but
the generated output is not the source of truth.

### CI and release

A new workflow `.github/workflows/companion.yml`, path-filtered to `kit-board/companion/**`, runs
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, and `cargo deny check`
on an ubuntu/macos/windows matrix, and compares the vendored schema with `lib/generated/` on every
push. cargo-dist generates and owns the release workflow, triggered by `observatory-v*` tags, with a
token scoped to the tap repository. This mirrors the `agentlint-v*` and `agent-surface-v*` release
conventions already in the repository. Dependabot watches `Cargo.lock`.

---

## 4. Where the technology lives

```
┌────────────────────────── user machines ───────────────────────────┐
│  observatory (Rust binary) · LaunchAgent / Task Scheduler / systemd  │
│  ├─ core: config · settings · discovery · credentials · state(SQLite)│
│  │        sink · outbox · receipts · lock · http · schedule          │
│  └─ adapters (one module each, enabled by settings)                  │
│     claude_execution  claude_account  codex_execution  codex_account │
│     cursor_account    cursor_execution anthropic_api   openai_api    │
│        │ local files / SQLite          │ codex app-server (stdio)    │
│        │ ~/.claude ~/.codex Cursor     │ provider HTTPS (read-only)  │
└────────┼───────────────────────────────┼─────────────────────────────┘
         │  POST /api/v1/usage  (bearer: install key, envelope v2)
         │  GET  /api/v1/companion/config (effective settings, bindings)
         ▼
┌──────────────── Observatory · Next.js on Vercel ───────────────────┐
│ lib/usage-contract.ts  lib/usage-store.ts  lib/companion-settings.ts │
│ app/api/v1/usage  app/api/v1/companion/config  app/api/companion-…   │
│ app/(private)/usage/settings  app/(private)/usage/connections        │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │ postgres.js, serialized queue, restricted role
                                 ▼
┌──────────── Supabase Postgres · schema personal_hub (RLS) ───────────┐
│ companion_installs · companion_bindings · collection_settings        │
│ companion_runs · activity_requests · account_usage_buckets           │
│ allowance_readings · money_entries                                   │
│ (unchanged) usage_accounts · telemetry_sources · token_bucket_…      │
│             quota_samples · report_revisions · agent_routing_events  │
└──────────────────────────────────────────────────────────────────────┘
```

### Repository layout

| Path | Role | Status |
| --- | --- | --- |
| `kit-board/companion/` | Cargo workspace; `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `deny.toml`, `dist-workspace.toml`, `README.md` | New |
| `kit-board/companion/crates/observatory/` | Binary crate: `clap` command tree for `connect`, `setup`, `run`, `serve`, `service`, `statusline`, `hook`, `status`, `doctor`, `settings`, `version` | New |
| `kit-board/companion/crates/observatory-contract/` | serde wire types, vendored `schema/usage-v2.schema.json`, validation helpers | New; schema copy diff-gated against `lib/generated/` |
| `kit-board/companion/crates/observatory-core/` | `config`, `settings`, `discovery`, `credentials`, `state` (rusqlite), `sink`, `outbox`, `http`, `lock`, `service` | New; `state`, `outbox`, `lock`, `service` port v1 behavior |
| `kit-board/companion/crates/observatory-adapters/` | One module per adapter in section 5 behind the `Adapter` trait | New; `claude_execution` and `codex_execution` port `collect.py` parsing against its fixtures |
| `kit-board/companion/testdata/` | Synthetic JSONL, SQLite, app-server transcripts, provider responses, the shared wire fixtures, and `insta` snapshots | New |
| `.github/workflows/companion.yml`, `.github/workflows/release.yml` | Test matrix and checks; cargo-dist's generated release workflow on `observatory-v*` tags | New |
| `joshgreenwell/homebrew-tap`, `joshgreenwell/scoop-bucket` | Formula written by cargo-dist; Scoop manifest with `autoupdate` | New, outside this repository |
| `kit-board/scripts/telemetry/` | v1 collector | Frozen; removed after every install is on the companion |
| `kit-board/scripts/build-collector-bundles.py` | Unchanged until retirement; the companion is not a download bundle | Unchanged |
| `kit-board/lib/usage-contract.ts` | Envelope v2, record schemas, coverage schema, JSON Schema export | New |
| `kit-board/lib/companion-settings.ts` | Settings schema, defaults, merge rules | New |
| `kit-board/lib/usage-store.ts` | Install/binding management, ingestion, canonical reads, reconciliation | New |
| `kit-board/lib/telemetry-contract.ts`, `lib/telemetry-store.ts` | v1 contract and store | Unchanged apart from reading `disabled` on the dashboard query (section 10) |
| `kit-board/app/api/v1/usage/route.ts` | Envelope ingestion | New |
| `kit-board/app/api/v1/companion/config/route.ts` | Effective settings and bindings for one install | New |
| `kit-board/app/api/v1/companion/pair/route.ts` | Exchanges a one-time pairing code for an install key | New |
| `kit-board/app/api/companion-installs/route.ts`, `app/api/collection-settings/route.ts` | Session-authenticated, same-origin UI mutations | New |
| `kit-board/app/(private)/usage/settings/page.tsx` | Collection mode matrix | New |
| `kit-board/app/(private)/usage/connections/page.tsx` | Companion installs, bindings, per-adapter coverage, pause | Changed |
| `kit-board/supabase/migrations/<timestamp>_unified_usage.sql` | Section 6 DDL, constraint widening, grants, policies | New |
| `kit-board/companion/**` unit and snapshot tests, `tests/usage-contract.test.ts`, `tests/usage-store.integration.test.ts` | Adapter fixtures, contract parity, disposable-Postgres integration on the `test:routing:db` pattern | New |

### Runtime locations on user machines

| Item | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Binary | `/opt/homebrew/bin/observatory` (Homebrew) | Scoop shim `%USERPROFILE%\scoop\shims\observatory.exe` | Homebrew on Linux, or `/usr/bin/observatory` from `.deb`/`.rpm` |
| Config, install key, state, logs | `~/.config/personal-hub/companion/` | `%LOCALAPPDATA%\PersonalObservatory\` | `~/.config/personal-hub/companion/` |
| Scheduler | LaunchAgent `com.personal-observatory.companion.<install-id>` | Task Scheduler `Personal Observatory Companion <install-id>` | systemd user timer `personal-observatory-companion.timer` |
| Claude Code stores read | `~/.claude/projects/**`, Keychain item `Claude Code-credentials` | `%USERPROFILE%\.claude\projects`, `.claude\.credentials.json` | `~/.claude/projects`, `~/.claude/.credentials.json` |
| Codex stores read | `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.codex/auth.json`, `codex` executable | same under `%USERPROFILE%` | same |
| Cursor stores read | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, `~/.cursor/ai-tracking/ai-code-tracking.db` | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`, `%USERPROFILE%\.cursor\ai-tracking\` | `~/.config/Cursor/User/globalStorage/state.vscdb`, `~/.cursor/ai-tracking/` |
| API Admin keys (opt-in) | `~/.config/personal-hub/companion/secrets.json` (0600) | `%LOCALAPPDATA%\PersonalObservatory\secrets.json` | `~/.config/personal-hub/companion/secrets.json` (0600) |

Store paths are discovered at setup, can be overridden per binding in the local config, and are never
uploaded. The server knows a binding's account and provider, not its paths.

---

## 5. The companion

### Run loop (`run`)

1. Acquire the single-run lock (SQLite `BEGIN IMMEDIATE`, as v1).
2. Fetch `GET /api/v1/companion/config` with the install key. On success, cache it. On failure, use
   the cached document; with no cache, run only default-on local execution readers.
3. Compute the effective mode for every adapter: `server setting` AND `not in local deny list` AND
   `prerequisite present` (store found, executable found, credential readable). Record the reason
   when an adapter does not run.
4. Run the enabled adapters concurrently on scoped threads, each with its own deadline (HTTP
   timeouts, subprocess kill-on-timeout, and a cancellation flag checked between files). An adapter
   returns normalized records, coverage, and an updated cursor. An adapter failure or timeout is a
   coverage entry, not a run failure.
5. The sink validates each record against the vendored schema, assigns observation identity and
   semantic identity, stores the normalized record and (bounded) raw observation in SQLite, and
   isolates anything invalid so that it can never poison a batch.
6. Derive v1-compatible hourly buckets from request records by `(session_hash, hour, model)`.
7. Batch buckets, records, and coverage into envelopes; write them to the outbox; upload in order;
   store receipts; delete acknowledged bodies. Records the server rejects are marked locally with the
   server's reason and are not retried.
8. Write a run summary for `status` and `doctor`.

Account readers are rate-limited to at most one read per hour per meter regardless of run cadence.
Execution readers run every cycle. A run makes no inference request, starts no session, and never
calls a mutating method on any provider interface.

### Adapters

| Adapter | Options (research IDs) | Channel | Prerequisite | Credential it reads | Emits | Default |
| --- | --- | --- | --- | --- | --- | --- |
| `claude_execution` | C1 local JSONL; C2 statusline snapshot inbox | `local_file`, `hook_snapshot` | `~/.claude/projects` or configured roots | none | buckets, `activity.request`, statusline `allowance.reading` | on |
| `claude_account` | C3 `GET api.anthropic.com/api/oauth/usage` | `provider_api` (private interface) | Claude Code signed in | Claude Code OAuth access token (Keychain or `.credentials.json`), read only | `allowance.reading` for every returned window (`five_hour`, `seven_day`, model-scoped, extra usage) | off until confirmed at setup |
| `codex_execution` | O1 JSONL under `CODEX_HOME`, including `archived_sessions`; storage-version detection; read-only `thread/list`/`thread/read` through the app-server when history has migrated | `local_file`, `app_server` | `~/.codex` or configured home | none | buckets, `activity.request`, embedded `rate_limits` as `allowance.reading` (reader `embedded`) | on |
| `codex_account` | O2 app-server `account/read`, `account/rateLimits/read`; O3 `chatgpt.com/backend-api/wham/usage` as fallback | `app_server`; `provider_api` for O3 | `codex` executable on PATH or configured | app-server uses the CLI's own login; O3 reads `~/.codex/auth.json` | `allowance.reading` per `rateLimitsByLimitId` entry, credits when returned | app-server on; O3 off |
| `cursor_account` | U1 `cursor.com/api/usage-summary` and paginated `get-filtered-usage-events`; U2 DashboardService RPC as alternative | `provider_api` (private interface) | Cursor signed in | Cursor desktop session token from `state.vscdb`, read only | `allowance.reading`, `account.usage_bucket` (per event and per summary), `money.entry` (`chargedCents` vs `totalCents` kept separate) | off until confirmed at setup |
| `cursor_execution` | U5 `state.vscdb` conversation data, `ai-code-tracking.db`; project hooks optional | `local_db`, `hook_snapshot` | Cursor installed | none | `activity.request` (token basis `unknown` when absent), tool counts, adoption sidecar | on |
| `anthropic_api` | C4 `/v1/organizations/usage_report/messages`, `/v1/organizations/cost_report` | `provider_api` (official) | Admin key in `secrets.json` | Anthropic Admin API key | `account.usage_bucket`, `money.entry` | off |
| `openai_api` | O4 `/v1/organization/usage/completions`, `/v1/organization/costs` | `provider_api` (official) | Admin key in `secrets.json` | OpenAI Admin API key | `account.usage_bucket`, `money.entry` | off |

Adapter rules that hold everywhere:

- **Read WAL-mode SQLite safely.** Copy `state.vscdb`, `-wal`, and `-shm` to a private temp directory
  and open the copy read-only. Never open the live file with `immutable=1`, which misses the WAL.
- **Codex app-server is a protocol client, not a subscription.** `codex_account` spawns
  `codex app-server`, sends `initialize`, reads, and exits with a 20-second budget. Preserve
  `rateLimitsByLimitId` and window durations; the two-window `rateLimits` object is compatibility
  output only. Never call thread-starting or reset-redeeming methods. One `CODEX_HOME` per binding.
- **Never refresh a token.** `claude_account` and `cursor_account` read the access token and its
  expiry; an expired or missing token yields coverage state `credential_unavailable`, and the
  statusline inbox (Claude) or embedded limits (Codex) remain the passive fallbacks.
- **Identity is pinned at setup.** Each binding stores `identity_hash`, a SHA-256 of the provider
  identity evidence the user confirmed (the signed-in email or account id). If the evidence changes,
  that binding pauses with coverage state `identity_changed` until the user re-confirms. Historical
  rows keep their original account.
- **Parsers carry versions.** Every record carries `parser_version`; Codex storage layout and Cursor
  schema versions are detected and reported, never assumed.
- **Counting rules from v1 stay.** Codex cumulative counters become deltas within one accumulation
  epoch; fork parents before the child's own first task are excluded; repeated Claude message ids
  collapse to one record with component-wise maxima; archived copies add nothing.

### Credential classification

| Credential | Scope it actually grants | Where the companion reads it | What the companion does | Never |
| --- | --- | --- | --- | --- |
| Observatory install key | Upload to this install's bindings; read its own config | `companion.json` | Bearer on every request | Appears in logs or coverage |
| Claude Code OAuth access token | Claude account API access beyond usage reporting | macOS Keychain via `security find-generic-password`, or `.credentials.json` | One `GET …/api/oauth/usage` per hour when the mode is on | Refresh, persist a copy, upload, use other routes |
| Codex CLI login | Whatever the CLI can do | Not read; the app-server uses it internally | Read-only RPC methods | Start threads, redeem resets |
| Codex `auth.json` access token | ChatGPT backend access | `~/.codex/auth.json` | O3 fallback only when enabled | Refresh, persist, upload |
| Cursor desktop session token | Cursor account dashboard and API | `state.vscdb` `ItemTable` | Usage summary and usage events hourly when on | Refresh, persist, upload, settings mutations |
| Anthropic / OpenAI Admin keys | Organization-wide reporting (and more, depending on key) | `secrets.json` 0600, user-pasted once | Usage and cost reads | Appear anywhere outside that file |

The Claude and Cursor readers reuse credentials that are broader than reporting. That is why they are
individually toggleable, off until the user confirms them at setup, and labeled in the UI as "uses
your existing <app> sign-in (private interface)".

---

## 6. Data model

### 6.1 Wire contract v2 (`POST /api/v1/usage`)

Written as zod in `lib/usage-contract.ts`; JSON Schema is generated from it. `stamp` and `counter`
are the v1 helpers. The v1 `bucketSchema` is reused verbatim.

```ts
export const adapters = ['claude_execution','claude_account','codex_execution','codex_account',
  'cursor_account','cursor_execution','anthropic_api','openai_api'] as const;
export const channels = ['local_file','local_db','app_server','provider_api','hook_snapshot'] as const;
export const providers = ['claude','codex','cursor','anthropic_api','openai_api'] as const;
const uuid = z.uuid(), sha256 = z.string().regex(/^[a-f0-9]{64}$/), code = z.string().regex(/^[a-z0-9_.:-]{1,64}$/);
const nullableCounter = counter.nullable();                 // unknown is null, never zero

const header = {
  record_id: uuid,                                          // observation identity, stable per source record + channel
  binding_id: uuid,
  adapter: z.enum(adapters), channel: z.enum(channels),
  observed_at: stamp,                                       // measurement time, not upload time
  basis: z.enum(['exact','reported','estimated','unknown']),
  parser_version: z.string().max(30),
};

export const activityRequestSchema = z.object({ ...header, record_type: z.literal('activity.request'),
  semantic_key: sha256,                                     // sha256(provider, account, provider request/message/turn id)
  product: code, surface: z.enum(['cli','ide','desktop','sdk','ci','cloud','unknown']),
  execution_host: z.enum(['local','cloud','self_hosted','unknown']),
  session_hash: sha256, session_identity: z.enum(['provider','derived','synthetic']),
  parent_session_hash: sha256.nullable(),
  model_requested: z.string().max(100).nullable(), model_actual: z.string().min(1).max(100),
  started_at: stamp.nullable(), ended_at: stamp.nullable(),
  tokens: z.object({ input_fresh: nullableCounter, input_cached: nullableCounter,
    input_cache_write: nullableCounter, output: nullableCounter, reasoning: nullableCounter }).strict(),
  tool_calls: nullableCounter,
  tools: z.array(z.object({ name: z.string().regex(/^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$/), calls: counter }).strict()).max(50).optional(),
  project_hash: sha256.nullable(), client_version: z.string().max(40).nullable(),
  latency_ms: nullableCounter, outcome: z.enum(['completed','failed','cancelled','unknown']),
}).strict().refine(r => r.tokens.reasoning === null || r.tokens.output === null || r.tokens.reasoning <= r.tokens.output,
  'Reasoning is a subset of output');

export const accountUsageBucketSchema = z.object({ ...header, record_type: z.literal('account.usage_bucket'),
  report_source: code,                                      // cursor_usage_events, anthropic_usage_report, openai_usage_completions, …
  bucket_start: stamp, bucket_end: stamp, provider_timezone: z.string().max(40).nullable(),
  dimensions: z.object({ model: z.string().max(100).nullable(), product: code.nullable(), client: code.nullable(),
    user_ref: sha256.nullable(), workspace_ref: sha256.nullable(), api_key_ref: sha256.nullable() }).strict(),
  measures: z.object({ requests: nullableCounter, input_tokens: nullableCounter, cached_tokens: nullableCounter,
    cache_write_tokens: nullableCounter, output_tokens: nullableCounter, reasoning_tokens: nullableCounter,
    total_tokens: nullableCounter }).strict(),
  provider_event_id: z.string().max(120).nullable(), provider_refreshed_at: stamp.nullable(),
}).strict().refine(b => Date.parse(b.bucket_end) > Date.parse(b.bucket_start), 'Empty bucket');

export const allowanceReadingSchema = z.object({ ...header, record_type: z.literal('allowance.reading'),
  meter_key: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),  // provider limit id + window, e.g. codex:codex:10080, claude:seven_day_opus
  label: z.string().min(1).max(120),
  kind: z.enum(['percent_used','count_remaining','credits_remaining','currency_allowance','unlimited','unavailable']),
  value: z.number().nullable(), unit: z.enum(['percent','requests','credits','USD']).nullable(),
  capacity: z.number().nullable(),
  window_minutes: z.number().int().positive().max(525600).nullable(),
  window_started_at: stamp.nullable(), resets_at: z.iso.datetime({ offset: true }).nullable(),
  reader: z.enum(['statusline','oauth_usage','app_server','embedded','web_backend','usage_summary','dashboard_rpc']),
  raw_window_id: z.string().max(120).nullable(),
}).strict().refine(r => r.kind !== 'percent_used' || (r.value !== null && r.value >= 0 && r.value <= 100), 'Percent out of range')
  .refine(r => !r.resets_at || Date.parse(r.resets_at) > Date.parse(r.observed_at), 'Expired reading');

export const moneyEntrySchema = z.object({ ...header, record_type: z.literal('money.entry'),
  entry_kind: z.enum(['estimate','included_usage','metered_charge','credit_grant','credit_consumption','adjustment','invoice_line']),
  amount: z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/),    // decimal string; negative adjustments are valid money data
  unit: z.enum(['USD','credits']), source_unit: code.nullable(),   // e.g. cents
  price_basis: code,                                        // provider_reported, invoice, list_price_2026_09, …
  period_start: stamp.nullable(), period_end: stamp.nullable(),
  reference: z.object({ kind: z.enum(['activity_request','usage_bucket','provider_event','none']), key: z.string().max(160).nullable() }).strict(),
  sku: code.nullable(), model: z.string().max(100).nullable(),
}).strict();

export const adapterCoverageSchema = z.object({
  adapter: z.enum(adapters),
  state: z.enum(['ok','partial','disabled_by_setting','denied_locally','prerequisite_missing',
    'credential_unavailable','identity_changed','rate_limited','failed']),
  detail_code: code.nullable(),                             // bounded code, never free text
  stores_discovered: counter, files: counter, bytes_read: counter, records_emitted: counter,
  malformed: counter, rejected_by_server: counter, duration_ms: counter,
  cursor_state: z.enum(['complete','more','unknown']), probe_requests: counter, parser_version: z.string().max(30),
}).strict();

export const usageEnvelopeSchema = z.object({
  schema_version: z.literal(2),
  run: z.object({ run_id: uuid, started_at: stamp, finished_at: stamp, companion_version: z.string().max(30),
    platform: z.enum(['darwin','windows','linux']), arch: z.enum(['arm64','amd64']), settings_version: counter }).strict(),
  buckets: z.array(z.object({ binding_id: uuid, bucket: bucketSchema }).strict()).max(500).default([]),
  records: z.array(z.discriminatedUnion('record_type',
    [activityRequestSchema, accountUsageBucketSchema, allowanceReadingSchema, moneyEntrySchema])).max(2000).default([]),
  coverage: z.array(adapterCoverageSchema).max(32),
}).strict();
```

Response:

```json
{ "ok": true, "schema_version": 2, "run_id": "…",
  "accepted": { "buckets": 120, "records": 338 }, "duplicates": 14,
  "rejected": [ { "record_id": "…", "reason": "binding_not_enabled" } ] }
```

Validation happens per record. An envelope whose `run` block and shape are valid is accepted even if
some records are rejected; the companion stores each rejection reason locally and does not retry that
record. Body limit 2 MB, measured while streaming as in `readJson`.

### 6.2 Companion config (`GET /api/v1/companion/config`)

```json
{ "schema_version": 2, "settings_version": 7,
  "install": { "id": "…", "machine_label": "mac-workstation", "paused": false },
  "bindings": [
    { "binding_id": "…", "account_id": "claude-primary", "provider": "claude", "enabled": true, "identity_hash": "…" },
    { "binding_id": "…", "account_id": "codex-primary",  "provider": "codex",  "enabled": true, "identity_hash": "…" },
    { "binding_id": "…", "account_id": "cursor-primary", "provider": "cursor", "enabled": true, "identity_hash": "…" } ],
  "settings": { "…effective settings document from section 7…" },
  "companion": { "latest_version": "2.0.0" } }
```

`ETag`/`If-None-Match` avoid re-downloading an unchanged document. The companion treats the document
as data: a setting can only turn an adapter on or off within the modes defined in section 7; it cannot
name paths, endpoints, or commands.

### 6.2a Pairing (`POST /api/v1/companion/pair`)

The Connections page issues a one-time code (eight characters, ten-minute expiry, stored as a hash).
`observatory connect --url <observatory> --code <code>` posts the code with the machine label,
platform, and architecture and receives the install id and key, which the companion writes to its
config directory with `0600` permissions. The code is single-use; the endpoint is rate-limited through
the existing `login_limits` pattern. This replaces downloading and moving a connection JSON file.

### 6.3 Database tables

One migration. Existing tables are untouched except for two widened `CHECK` constraints, located by
name through `pg_constraint` inside the migration because both were created inline and unnamed.

```sql
-- Widen enums on existing tables without changing any other predicate.
DO $$ DECLARE c text; BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'personal_hub.usage_accounts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%provider%';
  EXECUTE format('ALTER TABLE personal_hub.usage_accounts DROP CONSTRAINT %I', c);
  ALTER TABLE personal_hub.usage_accounts ADD CONSTRAINT usage_accounts_provider_check
    CHECK (provider IN ('codex','claude','cursor','anthropic_api','openai_api'));
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'personal_hub.telemetry_sources'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%mode%';
  EXECUTE format('ALTER TABLE personal_hub.telemetry_sources DROP CONSTRAINT %I', c);
  ALTER TABLE personal_hub.telemetry_sources ADD CONSTRAINT telemetry_sources_mode_check CHECK (mode IN ('local','browser','companion'));
END $$;

CREATE TABLE personal_hub.collection_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  settings jsonb NOT NULL, settings_version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE personal_hub.companion_installs (
  id uuid PRIMARY KEY, machine_label text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('darwin','windows','linux')),
  arch text NOT NULL CHECK (arch IN ('arm64','amd64')),
  key_hash text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,          -- partial override of collection_settings.settings
  paused boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
  companion_version text,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, last_config_fetch_at timestamptz
);

CREATE TABLE personal_hub.companion_pairing_codes (
  code_hash text PRIMARY KEY, machine_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  used_at timestamptz, install_id uuid REFERENCES personal_hub.companion_installs(id)
);

CREATE TABLE personal_hub.companion_bindings (
  id uuid PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  -- Every binding owns a v1 source row (mode 'companion') so hourly buckets and quota readings
  -- keep flowing into the existing ledgers and canonical queries. That row's key_hash is a random,
  -- never-issued value: only the install key authenticates, and only through /api/v1/usage.
  source_id uuid NOT NULL UNIQUE REFERENCES personal_hub.telemetry_sources(id),
  provider text NOT NULL CHECK (provider IN ('codex','claude','cursor','anthropic_api','openai_api')),
  identity_hash text, enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (install_id, account_id)
);

CREATE TABLE personal_hub.companion_runs (
  id uuid PRIMARY KEY, install_id uuid NOT NULL REFERENCES personal_hub.companion_installs(id),
  run_id uuid NOT NULL UNIQUE, started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
  companion_version text NOT NULL, settings_version integer NOT NULL,
  coverage jsonb NOT NULL,                                 -- validated adapterCoverageSchema[]
  accepted_buckets integer NOT NULL, accepted_records integer NOT NULL, rejected_records integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companion_runs_recent ON personal_hub.companion_runs (install_id, finished_at DESC);

-- Ledger 1: request activity. One row per observation; canonical selection at read time.
CREATE TABLE personal_hub.activity_requests (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL, channel text NOT NULL,
  record_id uuid NOT NULL, semantic_key text NOT NULL,
  product text NOT NULL, surface text NOT NULL, execution_host text NOT NULL,
  session_hash text NOT NULL, session_identity text NOT NULL CHECK (session_identity IN ('provider','derived','synthetic')),
  parent_session_hash text, model_requested text, model_actual text NOT NULL,
  started_at timestamptz, ended_at timestamptz, observed_at timestamptz NOT NULL,
  input_fresh_tokens bigint CHECK (input_fresh_tokens >= 0), input_cached_tokens bigint CHECK (input_cached_tokens >= 0),
  input_cache_write_tokens bigint CHECK (input_cache_write_tokens >= 0), output_tokens bigint CHECK (output_tokens >= 0),
  reasoning_tokens bigint CHECK (reasoning_tokens >= 0),
  total_tokens bigint GENERATED ALWAYS AS (
    CASE WHEN input_fresh_tokens IS NULL OR input_cached_tokens IS NULL OR input_cache_write_tokens IS NULL OR output_tokens IS NULL THEN NULL
         ELSE input_fresh_tokens + input_cached_tokens + input_cache_write_tokens + output_tokens END) STORED,
  basis text NOT NULL CHECK (basis IN ('exact','reported','estimated','unknown')),
  tool_calls integer, tools jsonb, project_hash text, client_version text, latency_ms integer,
  outcome text NOT NULL CHECK (outcome IN ('completed','failed','cancelled','unknown')),
  parser_version text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL,
  CHECK (reasoning_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens <= output_tokens),
  UNIQUE (account_id, semantic_key, channel, content_hash)
);
CREATE INDEX activity_requests_canonical ON personal_hub.activity_requests (account_id, semantic_key, observed_at DESC);
CREATE INDEX activity_requests_time ON personal_hub.activity_requests (account_id, observed_at DESC, model_actual);

-- Ledger 2: provider-reported account usage. Revisable within its exact scope; never joined into ledger 1.
CREATE TABLE personal_hub.account_usage_buckets (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL, report_source text NOT NULL,
  bucket_start timestamptz NOT NULL, bucket_end timestamptz NOT NULL, provider_timezone text,
  model text, product text, client text, user_ref text, workspace_ref text, api_key_ref text,
  dimensions_hash text NOT NULL,                           -- sha256 of the six dimension columns
  requests bigint, input_tokens bigint, cached_tokens bigint, cache_write_tokens bigint,
  output_tokens bigint, reasoning_tokens bigint, total_tokens bigint,
  provider_event_id text, provider_refreshed_at timestamptz,
  basis text NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  CHECK (bucket_end > bucket_start)
);
CREATE UNIQUE INDEX account_usage_revision ON personal_hub.account_usage_buckets
  (account_id, report_source, bucket_start, bucket_end, dimensions_hash, coalesce(provider_event_id, ''), content_hash);
CREATE INDEX account_usage_current ON personal_hub.account_usage_buckets (account_id, report_source, bucket_start DESC, dimensions_hash, provider_refreshed_at DESC NULLS LAST, observed_at DESC);

-- Ledger 3: typed allowance readings. Coexists with v1 quota_samples through a compatibility view.
CREATE TABLE personal_hub.allowance_readings (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL, reader text NOT NULL,
  meter_key text NOT NULL, label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('percent_used','count_remaining','credits_remaining','currency_allowance','unlimited','unavailable')),
  value double precision, unit text, capacity double precision,
  window_minutes integer CHECK (window_minutes > 0), window_started_at timestamptz, resets_at timestamptz,
  raw_window_id text, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL,
  CHECK (kind <> 'percent_used' OR (value BETWEEN 0 AND 100)),
  CHECK (resets_at IS NULL OR resets_at > observed_at),
  UNIQUE (account_id, meter_key, reader, observed_at)
);
CREATE INDEX allowance_history ON personal_hub.allowance_readings (account_id, meter_key, observed_at DESC);

CREATE VIEW personal_hub.allowance_percent_view WITH (security_invoker = true) AS
  SELECT id, account_id, window_key, label, observed_at, used_percent, resets_at, window_minutes, 'quota_samples' AS origin
    FROM personal_hub.quota_samples
  UNION ALL
  SELECT id, account_id, meter_key, label, observed_at, value, resets_at, window_minutes, 'allowance_readings'
    FROM personal_hub.allowance_readings WHERE kind = 'percent_used' AND resets_at IS NOT NULL AND window_minutes IS NOT NULL;

-- Ledger 4: money. Append-only; estimates and provider charges are different entry kinds.
CREATE TABLE personal_hub.money_entries (
  id uuid PRIMARY KEY,
  account_id text NOT NULL REFERENCES personal_hub.usage_accounts(id),
  binding_id uuid NOT NULL REFERENCES personal_hub.companion_bindings(id),
  provider text NOT NULL, adapter text NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('estimate','included_usage','metered_charge','credit_grant','credit_consumption','adjustment','invoice_line')),
  amount numeric(18,6) NOT NULL, unit text NOT NULL CHECK (unit IN ('USD','credits')), source_unit text,
  price_basis text NOT NULL, period_start timestamptz, period_end timestamptz,
  reference_kind text NOT NULL CHECK (reference_kind IN ('activity_request','usage_bucket','provider_event','none')), reference_key text,
  sku text, model text, basis text NOT NULL,
  observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), content_hash text NOT NULL
);
CREATE UNIQUE INDEX money_entry_revision ON personal_hub.money_entries
  (account_id, entry_kind, reference_kind, coalesce(reference_key, ''), content_hash);
CREATE INDEX money_period ON personal_hub.money_entries (account_id, period_start DESC, entry_kind);

-- Grants and policies follow the existing pattern: RLS on, public grants revoked, SELECT/INSERT for
-- personal_hub_app on every table and SELECT on the view; UPDATE only on collection_settings,
-- companion_installs, companion_bindings, companion_pairing_codes. Ledgers are append-only for the
-- application role.
```

### 6.4 Companion local state (SQLite, one database per install)

| Table | Purpose | Carried from v1 |
| --- | --- | --- |
| `meta` | install identity, pinned backfill start, schema version | yes |
| `settings_cache` | last fetched config document, `settings_version`, ETag, fetched_at | new |
| `adapter_state` | per adapter: effective mode, reason, last run, last status, opaque cursor (pagination cursor, app-server storage version, account-reader last-read hour) | new |
| `files` | path, size, mtime, inode, offset, parser context | yes |
| `observations` | raw provider payload for a record, bounded by `local_raw_retention_days`; never uploaded; exists so a corrected parser can reparse without re-reading stores that may have aged out | new |
| `records` | normalized record, `record_type`, `semantic_key`, `content_hash`, `published_hash`, `rejected_reason` | replaces `events` |
| `allowance_slots` | one reading per meter per UTC hour, freshest wins (v1 `quotas` generalized) | yes |
| `outbox`, `receipts`, `runs` | exact bodies awaiting upload, server receipts, run summaries | yes |

Schema creation is `CREATE TABLE IF NOT EXISTS` with a `meta.schema_version` for forward migrations; a
companion state database is a new file (`<install-id>.sqlite3`), so no v1 state is migrated in place.
Hourly buckets are a projection of `records` grouped by `(session_hash, hour, model)` and are
recomputed every run, exactly as v1's `bucket_rows` does today.

### 6.5 Identity, precedence, and deduplication

**Semantic key per provider.** Claude: `sha256(provider, account, message.id)`; Codex: the turn id
when present, else `sha256(provider, account, thread id, token_count timestamp, cumulative counters)`
as v1; Cursor: `sha256(provider, account, composer id, bubble id)` for local conversation rows and the
provider event id for account events. `session_hash` is computed exactly as v1
(`sha256([provider, account, session_id])`) so that a v1 collector and the companion observing the same
session deduplicate in `token_bucket_revisions`. A session whose id had to be guessed from a filename is
typed `synthetic`; a `provider` or `derived` identity always wins over it at read time.

**Declared precedence, per ledger.**

| Ledger | Canonical unit | Selection rule |
| --- | --- | --- |
| Request activity | `(account_id, semantic_key)` | Channel rank `provider_api` > `app_server` > `local_file` = `local_db` > `hook_snapshot`, then session identity rank, then latest `observed_at`. Disabled bindings are excluded by join. Tokens from a lower-ranked row never fill gaps in a higher-ranked row unless the higher row's token basis is `unknown`. |
| Account usage | `(account_id, report_source, bucket, dimensions_hash)` | Latest `provider_refreshed_at`, then latest `observed_at`. A later row with the same scope is a revision, not an addition. |
| Allowance | `(account_id, meter_key)` | Reader rank `app_server` = `oauth_usage` = `usage_summary` = `dashboard_rpc` > `statusline` > `embedded` > `web_backend`, then freshest `observed_at` within a two-hour freshness window; staler readings are shown as history, never as current. |
| Money | append-only | `invoice_line` > `metered_charge` > `included_usage` > `estimate` for display; all kinds retained and labeled. |
| Hourly buckets (v1) | `(account_id, session_hash, hour, model)` | Existing query, unchanged, plus the disabled-source join. |

**Reconciliation is a query, not a write.** For a matching window, account, product, and token class,
`account_usage − covered requests = unattributed account usage`. The remainder is reported as such;
it is never allocated to a surface, converted from a percentage, or written into the request ledger.

**Token rules carried forward.** Four exclusive input/output classes; reasoning is a subset of output;
Codex `input_tokens` already includes cached input, so the companion subtracts cached and cache-write
tokens before producing the exclusive classes; a missing counter is `null`, never zero; a failed or
cancelled request keeps the tokens it consumed.

---

## 7. Settings: collection modes

### 7.1 Settings document

Stored in `collection_settings.settings` (global defaults) and `companion_installs.settings` (partial
per-install override), validated by `lib/companion-settings.ts`, served merged to the companion.

```ts
export const collectionSettingsSchema = z.object({
  schema_version: z.literal(1),
  paused: z.boolean(),                                           // global kill switch
  cadence_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  providers: z.object({ claude: z.boolean(), codex: z.boolean(), cursor: z.boolean(),
    anthropic_api: z.boolean(), openai_api: z.boolean() }).strict(),
  execution: z.object({
    claude_local_logs: z.boolean(), codex_local_history: z.boolean(), cursor_local_state: z.boolean(),
    include_subagents: z.boolean(),
    detail_level: z.enum(['buckets_only','requests','requests_with_tools']),
    tool_detail: z.enum(['off','builtin_only','hashed_custom']),
    project_attribution: z.enum(['off','hashed']),
  }).strict(),
  allowance: z.object({
    claude_reader: z.enum(['off','statusline','oauth_usage']),   // oauth_usage keeps statusline as passive fallback
    codex_reader: z.enum(['off','embedded','app_server','web_backend']),
    cursor_reader: z.enum(['off','usage_summary','dashboard_rpc']),
  }).strict(),
  account_history: z.object({ cursor_usage_events: z.boolean(), lookback_days: z.number().int().min(1).max(90) }).strict(),
  billing: z.object({ anthropic_admin_api: z.boolean(), openai_admin_api: z.boolean() }).strict(),
  hooks: z.object({ claude_statusline: z.boolean(), cursor_project_hooks: z.boolean() }).strict(),
  detailed_monthly_report: z.boolean(),                          // existing analyzer adapter, per install
  live_mode: z.boolean(),                                        // serve subcommand; later phase
  local_raw_retention_days: z.union([z.literal(0), z.literal(7), z.literal(14), z.literal(30)]),
  update_notice: z.enum(['off','notify']),                       // never 'auto'
}).strict();
export const installOverrideSchema = collectionSettingsSchema.partial().strict();   // same keys, all optional
```

### 7.2 Recommended defaults

| Group | Setting | Default | Notes |
| --- | --- | --- | --- |
| Runtime | `paused` | `false` | Pausing keeps state and receipts; nothing is collected or uploaded. |
| Runtime | `cadence_minutes` | `60` | Account readers never exceed one read per hour per meter, whatever the cadence. |
| Providers | `claude`, `codex` | `true` | |
| Providers | `cursor` | `true` when Cursor is discovered | Setup proposes it; the user confirms. |
| Providers | `anthropic_api`, `openai_api` | `false` | Requires an Admin key in `secrets.json`. |
| Execution | `*_local_logs`, `*_local_history`, `*_local_state` | `true` | Official local routes, no credential. |
| Execution | `include_subagents` | `true` | Child session files are read; `parent_session_hash` keeps the tree. |
| Execution | `detail_level` | `buckets_only` | Matches the current privacy posture: hourly partition only. `requests` adds per-request rows with hashed session ids; `requests_with_tools` adds tool counts. |
| Execution | `tool_detail` | `builtin_only` | Known built-in tool names as-is; MCP and custom tools omitted. `hashed_custom` sends `h:<16 hex>`. Only effective at `requests_with_tools`. |
| Execution | `project_attribution` | `off` | `hashed` sends a SHA-256 of the project path per request; repository names are never uploaded. |
| Allowance | `claude_reader` | `statusline` | `oauth_usage` is offered at setup as "uses your Claude Code sign-in (private interface)". |
| Allowance | `codex_reader` | `app_server` | Official local protocol. `embedded` uses only the `rate_limits` already in local history. `web_backend` is a private interface and off. |
| Allowance | `cursor_reader` | `off` | `usage_summary` is offered at setup as "uses your Cursor sign-in (private interface)". |
| Account history | `cursor_usage_events` | follows `cursor_reader` | Paginated account events; `lookback_days` 30 at first run, then incremental. |
| Billing | both | `false` | |
| Hooks | `claude_statusline` | `true` | Installed by setup only while preserving any existing statusline command. |
| Hooks | `cursor_project_hooks` | `false` | Writes `.cursor/hooks.json` into repositories; explicit opt-in per machine. |
| Reports | `detailed_monthly_report` | `false` | Requires the installed analyzers and a separate publisher key, as today. |
| Runtime | `live_mode` | `false` | |
| Runtime | `local_raw_retention_days` | `14` | Raw provider payloads stay on the machine for reparsing; never uploaded. |
| Runtime | `update_notice` | `notify` | The Connections page shows "update available" when an install is behind the latest release; upgrading is `brew upgrade observatory` or `scoop update observatory`. |

### 7.3 Precedence

```
effective(adapter, mode) =
      server value (install override, else global default)
  AND adapter mode not in companion.json "deny"
  AND binding enabled and identity unchanged
  AND prerequisite present (store, executable, credential)
```

- The local deny list can only remove. Example: `"deny": ["allowance.claude_reader.oauth_usage", "execution.project_attribution"]`
  guarantees this machine never reads the Claude OAuth token or sends project hashes, whatever the
  Observatory says.
- Settings changes take effect on the companion's next run, so within one cadence interval. The run
  envelope carries the `settings_version` it applied; the Connections page shows when each install
  caught up.
- Every adapter reports its effective state in coverage, so "off" is always distinguishable from
  "broken": `disabled_by_setting`, `denied_locally`, `prerequisite_missing`, `credential_unavailable`,
  `identity_changed`, `rate_limited`, `failed`, `partial`, `ok`.

### 7.4 Settings UI and API

- `/usage/settings` shows the groups above as a matrix: one column for global defaults and one per
  install override, with each cell a switch or a select. Private-interface readers carry the
  "uses your existing sign-in" label and a link to the credential table in this document. Saving
  increments `settings_version`.
- `/usage/connections` lists companion installs with version, platform, last run, applied
  `settings_version`, each binding's account and identity state, and the per-adapter coverage state
  from the latest run. Actions: pause/resume install, disable install, enable/disable binding,
  re-confirm identity, download companion, download connection file.
- `PUT /api/collection-settings` and `POST/PATCH/DELETE /api/companion-installs` require the site
  session and `requireSameOrigin`, like `/api/usage-connections` today. `GET /api/v1/companion/config`
  and `POST /api/v1/usage` use the install bearer key only.

---

## 8. What the user has to do

### One-time, per machine

1. Install the companion with the platform's package manager. No other runtime is required.

   ```bash
   # macOS and Linux
   brew install joshgreenwell/tap/observatory
   # Windows (PowerShell)
   scoop bucket add joshgreenwell https://github.com/joshgreenwell/scoop-bucket
   scoop install observatory
   ```

2. In Observatory → Usage → Connections, choose **Add companion**, give the machine a label, and copy
   the one-time pairing code it shows (valid for ten minutes).
3. Pair the machine, then run setup:

   ```bash
   observatory connect --url https://<your-observatory> --code XXXX-XXXX
   observatory setup
   ```

   `connect` stores the install key in the private config directory (section 4) with `0600`
   permissions. `setup` discovers installed products and stores, reads the signed-in identity of each
   (display only), and proposes account bindings using existing account ids when the Observatory already
   has them. It asks, one question each, whether to enable the private-interface readers (Claude OAuth
   usage, Cursor usage summary), whether to install the Claude Code statusline hook (preserving any
   existing statusline command), and confirms the schedule. It then runs a dry run, a first publish, and
   `service install`. Every answer becomes this install's settings on the server and can be changed later
   in the UI. `observatory setup --yes --bind claude=claude-primary --bind codex=codex-primary` is the
   non-interactive form for a second machine.
4. If a v1 collector schedule exists on the same machine, setup offers to uninstall it so the machine
   does not report the same logs twice. Declining is allowed; the server still deduplicates the hourly
   buckets, and the Connections page flags the overlap.

### Ongoing

Nothing recurring. The companion runs on its schedule, catches up after sleep, retries uploads from
its outbox, and follows settings changes made in the UI. The three situations that need a person are:

- **A provider sign-in expired or changed.** Sign in again in Claude Code, Codex, or Cursor as usual.
  The Connections page shows `credential_unavailable` or `identity_changed` for that binding until
  then; passive fallbacks keep running. The companion never asks for a pasted token.
- **An update is available.** Run `brew upgrade observatory` or `scoop update observatory` when the
  Connections page says so. Older companions keep working until then.
- **Enabling API billing.** Paste an Anthropic or OpenAI Admin key once into `secrets.json`
  (`observatory setup --secrets` creates the file with `0600`) and turn the billing setting on.

### Other cases

- **Another machine or account:** repeat the one-time steps with the same account ids.
- **Remote hosts, containers, CI:** install the companion there with its own install key, or the
  activity is uncollected and coverage says so. A laptop install cannot see a cloud runner.
- **Removing a machine:** `observatory service uninstall` removes the schedule and hooks it
  installed and leaves state for the user to delete; `brew uninstall` or `scoop uninstall` removes the
  binary; disabling the install in the UI revokes its key and removes its rows from dashboards while
  retaining history.

---

## 9. Security and privacy boundaries

- Uploaded: counters, hashed identifiers, model names, allowlisted or hashed tool names, allowance
  readings, provider-reported aggregates and charges, coverage codes, versions. Not uploaded: prompts,
  responses, file paths, repository names (unless hashed and opted in), credentials, raw provider
  payloads, free-text errors.
- Install keys are random, stored as SHA-256 hashes, revocable, and can only write to the bindings of
  their own install; a rejected record names the reason `binding_not_enabled` rather than silently
  accepting data for an account the install does not own.
- Provider credentials are read at run time from their owning application's store, used for one
  read, and dropped. No refresh, no copy, no log line containing one. Coverage reports only codes.
- `companion.json` and `secrets.json` are `0600`; the state database is `0600`; logs contain counters
  and codes. These match the v1 posture.
- All ledgers are append-only for the application role; the read side chooses canonical rows.
  Settings, installs, and bindings are the only updatable tables.
- The companion never downloads or executes code. Upgrades arrive through the package manager,
  which verifies the release checksum; releases are cosign-signed and carry an SBOM.
- Pairing codes are single-use, expire in ten minutes, and are stored hashed; the install key they
  produce is shown to nobody and written only to the companion's `0600` config file.

---

## 10. Compatibility and migration from v1

- **Server accepts before the companion sends.** The migration, contract, endpoints, and settings UI
  ship first and are inert. The companion is released only against a deployed server.
- **v1 keeps working.** `POST /api/v1/telemetry`, `quota_samples`, browser connections, and installed
  v1 schedules are untouched. The two widened `CHECK` constraints change no existing predicate.
- **Dedupe across v1 and v2** relies on identical `session_hash` derivation; a parity test runs the v1
  Python parser and the companion's Rust parser over the same fixtures and asserts identical bucket rows.
- **The one change to an existing read:** the dashboard query in `lib/telemetry-store.ts` joins
  `telemetry_sources.disabled` so that disabling a connection removes its readings from the dashboard,
  which v1 does not do today. This is a correctness fix and lands with the migration phase.
- **Old downloads:** the `local` bundle remains downloadable until every install has moved; then the
  download, `scripts/telemetry/`, and the `local` branch of `build-collector-bundles.py` are removed in
  a separate commit. The browser bundle is untouched.

---

## 11. Delivery phases

Each phase leaves the system working and older collectors valid.

| Phase | Delivers | Done when |
| --- | --- | --- |
| 0. Contract and storage | `lib/usage-contract.ts`, generated JSON Schema and parity test, `lib/companion-settings.ts`, migration, `lib/usage-store.ts` ingestion, `POST /api/v1/usage`, `GET /api/v1/companion/config`, `POST /api/v1/companion/pair`, settings and installs APIs and pages, disabled-source join | Disposable-Postgres integration test passes; fixtures accepted and rejected as labeled; deployed; no collector change |
| 1. Companion core | Cargo workspace, contract crate with schema parity tests, cargo-dist pipeline, tap and bucket repositories, `connect`/`setup`/`run`/`service`/`status`/`doctor`, settings fetch and deny list, state, sink, outbox, schedulers for three platforms, ported `claude_execution` and `codex_execution` with v1 parity fixtures and `insta` snapshots, `statusline` subcommand, benchmark fixtures, `cargo deny` policy | Same fixtures yield identical buckets in v1 and companion; `brew install` on a Mac and `scoop install` on Windows publish with receipts; statusline under 5 ms and 1 GB backfill under 10 s on the owner's Mac; v1 schedule removed on those machines |
| 2. Allowance | `codex_account` app-server reader; `claude_account` OAuth reader behind setup confirmation; embedded and statusline readers write `allowance_readings`; dashboard reads `allowance_percent_view` and shows non-percent meters | Readings appear within one cadence after a real Codex or Claude response; reader ranking verified with both readers on |
| 3. Cursor | `cursor_execution`, `cursor_account` behind setup confirmation, usage events with `chargedCents`/`totalCents` kept separate, Cursor in every dashboard selector | Controlled Cursor workload reconciles account events against local conversation rows; charges never summed with estimates |
| 4. Detail | `detail_level` `requests` and `requests_with_tools`, tool allowlist, project hashing, dashboard per-model/per-tool/per-source views, reconciliation view | Request rows dedupe across channels; unattributed remainder displayed as such |
| 5. Billing | `anthropic_api`, `openai_api`, `secrets.json`, money ledger views | Costs shown separately from estimates with units and price basis |
| 6. Optional | `serve` live mode with Codex `thread/tokenUsage/updated`; OTel intake as a separate receiver; enterprise adapters as credentials allow | Each behind a setting, each with its own coverage state |
| 7. Retirement | Remove `local` bundle download and `scripts/telemetry/`; keep `/api/v1/telemetry` while any source uses it | No active v1 local source for 30 days |

---

## 12. Validation before claiming coverage

Run one controlled workload per surface and account: a short prompt, a tool call, a model switch, a
nested agent, a failed or cancelled run, and a cache-heavy continuation. For local readers, add a fork,
an archived session, a resumed session, a duplicated file, and a second machine. Then check:

- **Completeness.** Every adapter reports `ok`, `partial`, or a specific non-running state; an empty
  page never hides a permission failure.
- **Arithmetic.** A request seen by two channels counts once; cumulative counters and fork replays do
  not inflate totals; bucket totals equal the sum of canonical request rows for the same hour when
  `detail_level` is `requests`.
- **Identity.** Switching the signed-in account pauses the binding without reassigning history.
- **Reconciliation.** Account usage and covered requests are compared only at matching scope;
  remainders are labeled, never allocated.
- **Recovery.** Expired credentials, rate limits, truncated JSONL, SQLite rotation and WAL, interrupted
  pagination, and a rejected record all leave the last trustworthy state with visible staleness.
- **Revision.** Late provider data and adjustments update their exact scope without duplication.
- **Settings.** Turning a mode off in the UI stops that adapter on the next run and its coverage says
  `disabled_by_setting`; a local deny overrides a server-enabled mode and says `denied_locally`.
- **Credential hygiene.** A grep of logs, state, coverage, and uploaded bodies for any token fragment
  returns nothing.

Feasibility checks that decide optional adapters and must run first on the owner's machines: Keychain
access to the Claude Code item from a LaunchAgent context; the installed Codex storage version and
app-server method set; the Cursor `state.vscdb` key names and session cookie format on the installed
version; Admin key scopes for the two billing APIs. Performance checks in the same pass: statusline
and hook invocation latency, 1 GB synthetic JSONL backfill time, and resident memory of `serve`, on
both the Mac and the Windows machine.

---

## 13. Open decisions

- Whether the private-interface readers (Claude OAuth usage, Cursor usage summary) should default on
  after setup confirmation or require a second explicit UI step; this design asks once at setup.
- Whether `detail_level` should default to `requests` for the owner's own installs; this design keeps
  `buckets_only` to match the current posture and leaves the upgrade to the settings page.
- Retention for `activity_requests` at `requests_with_tools`; a heavy month is in the low hundreds of
  thousands of rows, which Postgres handles, but a 13-month rolling window is proposed.
- Whether to commit the September 11 research report into `docs/` so the option identifiers used
  here resolve inside the repository.
- Linux targets: `gnu` (chosen above) or `musl` for a fully static binary on older distributions.
- When to add Apple Developer ID and Authenticode signing. Not required for Homebrew or Scoop
  installs; required before offering a browser download.
- Whether to submit a winget manifest once the Scoop bucket has been exercised.
