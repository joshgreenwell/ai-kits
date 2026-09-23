# V2 usage collection

This is the current companion operating guide. Start with [how Usage actually works](usage-system.md) for the feature inventory and verified status. All old collector, data-migration, and scheduler-removal instructions live separately in [v1 retirement](usage-v1-retirement.md).

The `observatory` companion uses **zero model calls**. It reads provider-owned local stores, checkpoints progress in SQLite, and publishes cumulative hourly buckets and independent allowance readings; request records are optional. Provider account aggregates and money have server contracts but their adapters are not implemented. Public feed fetching and the existing v1 browser quota collector also use ordinary code. Separate AI monthly automations still exist and do invoke a model session; they are not part of the companion run loop.

For what each collector can and cannot attribute (tokens, allowances, money, project, surface) per provider and surface, and the process behind each cell, see [usage coverage](usage-coverage.md).

## Companion install (v2, one binary per machine)

The `observatory` companion (`companion/`, see its README) replaces the local script, the statusline hook, and the schedule installer. Pairing and settings live in the Observatory:

1. Settings → Connections → **Add companion**: label the machine and copy the one-time code (ten minutes, single use).
2. On the machine: `observatory connect --url https://<observatory> --code XXXX-XXXX`, then `observatory setup`. Use one explicit config directory on Windows as shown below: packaged apps can redirect new `%LOCALAPPDATA%` folders into a private store. Setup discovers stores, proposes bindings, asks about reader modes, the Claude statusline hook and schedule, then performs a dry run, a first publish, and `service install`. Cursor hosted collection stays off until Settings; `web_backend` stays unimplemented. See the capability table below. The first run pins the backfill start (`--since YYYY-MM-DD` on `connect`, default the first day of the current UTC month) and reads available local transcripts from that date. It does not import old collector state or prove historical parity. Do not delete the state database to extend backfill: preserve checkpoints, outboxes and receipts and follow the migration/recovery process first.
3. Settings → Collection holds the collection modes: global defaults plus a per-install override. Every install fetches the effective document on each run; a local `deny` list in `companion.json` can only remove modes.
4. Connections shows each install's version, platform, last run, applied settings version, "update available", every binding's identity state, and the per-adapter coverage from the latest run. "Off" is always distinguishable from "broken".

The companion emits the same *shape and intended identity rules* for hourly buckets as the v1 script, plus typed allowance readings and optional requests. This is compatibility, not proof that historical backfill matches; the current audit found many v1-only keys. `/api/v1/usage` is the v2 endpoint despite the API namespace. All old runtime and data dependencies are listed in the [retirement inventory](usage-v1-retirement.md#what-belongs-to-v1).

The Claude statusline hook publishes every window Claude Code reports, including the model-scoped weekly windows (for example the Fable weekly cap), each as its own card under Current allowances with a `model-scoped weekly` badge. A scoped window is never added to the pooled weekly window. Each sample carries the identity of the account signed in when it was observed, and the run binds it to that account's binding or holds it back; see [allowance readers, identity, and freshness](#allowance-readers-identity-and-freshness).

With the **Detailed monthly report (analyzer)** setting on (global or per install), each run also executes the detailed analyzer adapter for every configured binding. Setup can copy an old connection's configuration, but the `script` path may still point into the old directory. Verify and relocate all such dependencies before deleting it. The adapter, analyzer, provider configuration, and usage-publisher credential remain protected local dependencies.

**Add browser** issues a code of kind `browser` for the v2 browser collector: the Claude quota extension at version 2.0.0 (`browser/claude-quota/`, see [its README](../browser/claude-quota/README.md) for installation and the per-profile cutover). The extension claims the code through `POST /api/v1/companion/pair`, binds the signed-in claude.ai account through `POST /api/v1/companion/bindings` with the same identity hash the companion posts for that account, reads the install's effective settings from `GET /api/v1/companion/config` on every run (kill switch, pause, `providers.claude`, cadence), and uploads envelope v2 to `POST /api/v1/usage` under the install key: `allowance.reading` records only (adapter `claude_browser`, channel `browser_session`, reader `web_backend`), one per recognized window with the companion's meter keys and labels, plus coverage. The server refuses any other record type from a browser install. Existing v1 browser sources keep their separate controls on the legacy card; a profile may publish both during reconciliation, and a v1 sample the v2 reading duplicates is shown once, as the v2 reading (v2 wins on a tie). This checkout carries the collector and its tests; a real scheduled reading from each used browser profile is production verification still owed by USG-010.

## Windows commands

For this installed Windows companion, use ordinary PowerShell and pin the same directory everywhere:

```powershell
$companionExe = Join-Path $env:LOCALAPPDATA 'Programs\observatory\observatory.exe'
$companionDir = Join-Path $env:USERPROFILE '.config\personal-hub\companion'
& $companionExe --config-dir $companionDir status
& $companionExe --config-dir $companionDir doctor
```

For a **new** install, after issuing a code in Connections:

```powershell
& $companionExe --config-dir $companionDir connect --url https://personal-observatory-jg.vercel.app --code XXXX-XXXX
& $companionExe --config-dir $companionDir setup
```

Do not re-pair a working install for troubleshooting. After changing cadence in Settings, apply it to Task Scheduler with `& $companionExe --config-dir $companionDir service install`. The same command rewrites an older task that opened a console window; a scheduled run must not show UI. Normal `run` fetches collection settings but does not rewrite the OS schedule. Inspect the next scheduled run and the detailed-report result separately.

### Update an existing Windows install

An update keeps `companion.json`, the install key, SQLite checkpoints, receipts, inbox, and detailed-report state. Do **not** run `connect` or delete the config directory. For a tagged release installed through Scoop, use `scoop update observatory`, then run the three commands below with the path returned by `scoop which observatory`.

Until a tagged release exists, build the current checkout and replace the executable already named by Task Scheduler. First confirm the companion task is not running and preserve the old binary as a rollback copy:

```powershell
cd C:\path\to\ai-kits\kit-board\companion
cargo test --workspace
cargo build --release --locked

$companionDir = Join-Path $env:USERPROFILE '.config\personal-hub\companion'
$companionExe = Join-Path $env:LOCALAPPDATA 'Programs\observatory\observatory.exe'
$backupDir = Join-Path (Split-Path $companionExe) 'backups'
New-Item -ItemType Directory -Force $backupDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $companionExe (Join-Path $backupDir "observatory-before-update-$stamp.exe")
Copy-Item .\target\release\observatory.exe $companionExe -Force

& $companionExe --config-dir $companionDir service install
& $companionExe --config-dir $companionDir run
& $companionExe --config-dir $companionDir doctor
```

`service install` is intentionally repeated after replacing the binary: it refreshes the task command and cadence, reads the task back, and immediately reports the new build's capabilities. The first run after a parser-generation change replays retained source files and can take longer than a normal hourly run.

### Upgrading to 2.2.0: back up, gate, then install

Companion 2.2.0 adds readable names beside the hashes, the projects you create in the Codex app, and nested Codex MCP calls (see [usage coverage P13](usage-coverage.md#p13-app-projects-and-readable-names)). Its labels can only name hashes computed under the salt the state database holds, so **back up the state database before every upgrade**; the backup carries the salt (`meta.privacy_salt`). The server migrations `20260923090000` to `20260923090300` and the server deploy go first; a 2.1.0 companion keeps working against them and its machine shows "companion update needed" under Projects until it upgrades.

1. Pause the scheduled task, keep the old binary, and back up the state database with SQLite's own backup (the file is in WAL mode, so a plain file copy is not a backup):

   The companion opens its state at `<config-dir>/<install_id>.sqlite3`, with `install_id` taken from `companion.json`, so derive the path rather than globbing for it:

   ```powershell
   $installId = (Get-Content (Join-Path $companionDir 'companion.json') -Raw | ConvertFrom-Json).install_id
   $state = Join-Path $companionDir "$installId.sqlite3"
   sqlite3 $state ".backup '$state.before-2.2.0'"
   ```

2. Build two copies in a scratch config directory and record the cutoff, the `finished_at` of the last run in `runs`. The dry-run copy must carry the same `<install_id>.sqlite3` name, because that is the only file `run --config-dir $scratch` opens; under any other name the dry run creates a fresh, empty database and the gate checks an untouched copy. The baseline copy is never run; it holds what the server received and is what lets the gate check that no tool row changed its calling request. `VACUUM INTO` refuses an existing file, so clear old copies first:

   ```powershell
   $scratch = Join-Path $env:TEMP 'observatory-gate'; New-Item -ItemType Directory -Force $scratch | Out-Null
   $gateState = Join-Path $scratch "$installId.sqlite3"
   $baseline = Join-Path $scratch 'baseline.sqlite3'
   Remove-Item $gateState, "$gateState-wal", "$gateState-shm", $baseline -ErrorAction SilentlyContinue
   sqlite3 $state "VACUUM INTO '$gateState'"
   sqlite3 $state "VACUUM INTO '$baseline'"
   Copy-Item (Join-Path $companionDir 'companion.json') $scratch
   $cutoff = sqlite3 $state "SELECT max(finished_at) FROM runs"
   ```

3. With the 2.2.0 build, run the dry run on the scratch directory, then the gate on that same file with the baseline:

   ```powershell
   & $newExe --config-dir $scratch run --dry-run --offline
   & $newExe upgrade-gate --state $gateState --baseline $baseline --cutoff $cutoff
   & $newExe --config-dir $scratch projects --apps
   ```

   `$newExe` is the 2.2.0 build, for example `.\target\release\observatory.exe`. **Any failure aborts the install**: restore the task and stop. The gate allows exactly the ledger changes the release intends (PowerShell and NotebookRead tool events gaining their name, and new nested MCP tool events) and fails on any request or agent revision, any older record newly keyed, or, because `--baseline` is given, any tool row whose calling request changed. Without `--baseline` that last check does not run and the gate's JSON shows `caller_request_changes: null`, so check that it is a number (normally `0`). Also check that the gate's `pending_side` lists the new side record types (`name.label`, `project.catalog`, `project.membership`) with the production settings (`hashed_custom`, `hashed`): an empty `pending_side` means the dry run did not touch this file. `projects --apps` reads the same dry-run file and prints counts only (projects, roots, threads, requests by resolution, forked rollouts, unresolved reasons) for comparison with the owner's expectations.
4. Only then replace the binary and run `service install`, `run` and `doctor` as in the update steps above. The first run replays retained rollouts under the lock and can take several minutes.
5. Check Settings > Companion: the machine shows "Names: sent" and a deferral count of 0; Settings > Projects lists the app projects and no longer shows the machine under "Machine not upgraded".

After the server deploy, re-run the backfill statement at the end of `supabase/migrations/20260923090200_tool_invocation_parent.sql` once (it is idempotent; `refreshAddedToolColumns()` in `lib/usage-canonical.ts` runs the same statement): tool rows ingested between `supabase db push` and the deploy were written by the old code without `parent_invocation_key`.

## macOS install, update, and run

Use the same config directory for every command. An update must reuse the existing directory; it must not pair a second install.

For a tagged Homebrew release:

```bash
brew update
brew upgrade joshgreenwell/tap/observatory

companion_dir="$HOME/.config/personal-hub/companion"
observatory --config-dir "$companion_dir" service install
observatory --config-dir "$companion_dir" run
observatory --config-dir "$companion_dir" doctor
```

If Homebrew reports that the formula is not installed, use `brew install joshgreenwell/tap/observatory`. Only a new, unpaired Mac then needs `connect` and `setup` from the installation steps above.

To install the current unreleased checkout instead of the last tagged release:

```bash
cd /path/to/ai-kits/kit-board/companion
cargo test --workspace
cargo install --path crates/observatory --locked --force

companion_exe="$HOME/.cargo/bin/observatory"
companion_dir="$HOME/.config/personal-hub/companion"
"$companion_exe" --config-dir "$companion_dir" service install
"$companion_exe" --config-dir "$companion_dir" run
"$companion_exe" --config-dir "$companion_dir" doctor
```

Before upgrading a Mac to 2.2.0, follow the backup and gate steps above. The state file is `<config-dir>/<install_id>.sqlite3`, and the dry-run copy must keep that exact name inside the scratch directory, or the dry run opens a fresh database and the gate checks an untouched copy:

```bash
companion_dir="$HOME/.config/personal-hub/companion"
install_id="$(sed -n 's/.*"install_id" *: *"\([^"]*\)".*/\1/p' "$companion_dir/companion.json")"
state="$companion_dir/$install_id.sqlite3"
sqlite3 "$state" ".backup '$state.before-2.2.0'"

scratch="$(mktemp -d)"
sqlite3 "$state" "VACUUM INTO '$scratch/$install_id.sqlite3'"
sqlite3 "$state" "VACUUM INTO '$scratch/baseline.sqlite3'"
cp "$companion_dir/companion.json" "$scratch/"
cutoff="$(sqlite3 "$state" "SELECT max(finished_at) FROM runs")"

new_exe=/path/to/2.2.0/observatory
"$new_exe" --config-dir "$scratch" run --dry-run --offline
"$new_exe" upgrade-gate --state "$scratch/$install_id.sqlite3" --baseline "$scratch/baseline.sqlite3" --cutoff "$cutoff"
"$new_exe" --config-dir "$scratch" projects --apps
```

Paste back only the counts-only output of `projects --apps` and the gate, and check the gate's `caller_request_changes` is a number, not `null`.

The LaunchAgent installed by `service install` pins both that executable and `--config-dir`. Keep the checkout update (`git pull`, merge, or branch switch) separate from the install command so local changes are reviewed before the binary is replaced. The first upgraded run may be slow while newer parsers replay retained Claude and Codex histories; wait for its JSON result and require `"ok": true`, no retained outbox, a non-pending schedule, and no unexplained `failed` or `partial` state from an enabled execution adapter before considering the update complete.

The supported local footprint is the installed `observatory` binary, one companion config/state directory, the detailed adapter/analyzer and protected usage-publisher credential when enabled, and the provider-owned `.codex` / `.claude` stores that are the source data. The companion config directory contains its JSON config, SQLite checkpoint/receipt state, lock, inbox, logs, safety backups, and detailed-report retry state; these are one managed runtime tree, not separate installs.

The directory boundary must be verified per machine: `%LOCALAPPDATA%\PersonalObservatory` is the CLI's Windows **default v2** directory. Do not delete a directory by its name. This Windows install uses the explicit profile-root directory above.

## Implemented versus selectable

| Capability | Current implementation |
| --- | --- |
| Claude Code / Codex local counters | Implemented; optional request detail and hashed projects. |
| Claude statusline allowance | Implemented in the `claude_account` adapter, which binds each reading to the account that was signed in when the hook observed it (below). |
| Codex embedded allowance | Implemented; the readings remain a by-product of the `codex_execution` rollout scan. |
| Claude OAuth, Codex app-server | Implemented in this checkout. `oauth_usage` calls `GET /api/oauth/usage` with the existing Claude Code sign-in. Observatory never POSTs a refresh_token; `allowance.claude_oauth_keepalive` may spawn Claude Code so *it* refreshes the store. Statusline stays the documented fallback, and the site says so when OAuth failed. `app_server` talks to `codex app-server` (`account/rateLimits/read`). `web_backend` stays unimplemented. Settings chips follow each build's capability report. |
| Cursor local state and hosted history | Implemented in this checkout: local `state.vscdb` counters as requests (not billed, not hourly buckets), observed at the bubble's or composer's own store time and emitted once per content change (companion 2.1.0, parser `+cursor-local2`). Current Cursor builds write zero for every local token counter, so the local store yields request existence only; token evidence comes from the hosted reader (`/api/usage-summary` and dashboard usage events using the Cursor session). A real authorized receipt has not been stored, so USG-027 stays Planned. |
| Anthropic/OpenAI Admin usage and billing | Implemented in this checkout from `secrets.json` Admin keys into `account.usage_bucket` and `money.entry`. Tokens query unions those buckets with local hours and never treats them as the same work. USG-030/031 stay Planned until a real authorized org receipt exists. |
| V2 browser collection | Implemented in this checkout for Claude: the quota extension 2.0.0 pairs as a browser install and uploads `allowance.reading` records only ([README](../browser/claude-quota/README.md)). Codex and Cursor browser adapters have contracts and no collector. A production receipt from a real browser profile is not stored yet, so USG-010 stays In progress. |
| Tool extraction / knowledge-source access | Implemented for Claude and Codex local histories at `requests_with_tools`; access rows need sources configured on the machine (below). |
| Cursor project hooks / live `serve` | Not implemented; no build reports either feature, so both switches read `unsupported`. |
| Detailed monthly analysis | Implemented adapter with external local dependencies; publication can fail independently. |

For each setting's meaning and currently active values, see [the system guide](usage-system.md#settings--usagesettings). The technical roadmap belongs in [usage coverage](usage-coverage.md), not install promises.

### Capability reports, health, and cadence

Each companion build describes itself instead of the site guessing. After every online run, and on `service install` / `uninstall` and `setup`, the companion posts a capability document to `POST /api/v1/companion/capabilities` (`lib/companion-capabilities.ts`, mirrored as `observatory_contract::CapabilitiesDocument`): the build (version, target, scheduler kind), each adapter with the modes it implements and which are denied locally, feature lists (detail levels, tool detail, project attribution, hooks, live mode, detailed report), the settings it is actually running under (`effective`: applied settings version, config source `server` / `cache` / `defaults`, detail level, readers, resource count), the recognized local deny entries as dotted mode paths, per-binding identity state, detailed-report status per binding, the installed schedule as read back from the OS, queue depth, and backfill progress. The document names codes, counts, and ids only; a path, token, label, or free-text field is rejected by both the strict Rust type and the zod schema (`tests/fixtures/usage-v2/capabilities/`). Posting is best effort: dry runs and `--offline` skip it, a failure never blocks the upload, and an unchanged document is posted once a day rather than every run.

The server keeps the current document per install with its digest, the previous digest, and when it changed. A report only counts while it describes the running build: `never_reported` (an older companion), `version_mismatch` (the report's version differs from the install's last-seen version), and `stale` (no report in fourteen days) all fall back to what the run evidence can prove. From that, three things on the site become truthful:

- **Support chips** on Settings → Collection: each value that needs an adapter mode or feature shows `supported n/m` (of the installs with a current report), `unsupported`, or `unverified` (no report yet). A control is never disabled; a value no build implements is saved and shows as unsupported on its next run, and the switched-off value of any row needs nothing. The per-install table below the matrix shows the settings version each machine applied, its effective settings, its local deny list, and its schedule verdict.
- **The health ladder** on Connections: `paired` (a key exists), `bindings` (complete / partial / none against the enabled providers), `identity` (confirmed / unconfirmed / changed / reset / mixed, from server state and the companion's last report), `execution` (ok / partial / failed / off / unknown over the adapters the build implements with their mode on; `never` before the first run), and `records` (fresh / stale / observed / none: the newest ledger evidence, with allowance freshness judged at the cadence the OS actually installed). A run that uploaded coverage only is labelled `last run accepted no records`; missing two cadences marks the install overdue. Detailed-report health is a separate line per binding. Rejected records are counted by reason (`binding_not_owned`, `invalid`, …) beside the per-type totals.
- **The cadence verdict**: the site does not rewrite OS schedules. The companion reads back what the scheduler holds (`task_scheduler`, `launchd`, or `systemd`) and reports the installed interval and whether the job pins this config directory; the server compares it with the desired cadence (the install override merged with the global document) and shows `cadence pending` with the exact action — `observatory service install` with the same `--config-dir` (`observatory doctor` prints it) — until the next report matches. `status` and `doctor` print the same verdict locally.

### Knowledge sources

A knowledge source is a named vault or corpus the companion classifies tool calls against. It is local configuration, not a setting: the Observatory settings document can never name a path, so each machine's `companion.json` carries a `resources` list of `{ "key", "label", "roots", "connectors", "source" }` entries. `key` is the privacy-safe identity the Observatory labels (`^[a-z0-9_.:-]{1,64}$`); `roots` are absolute or `~/`-anchored directories whose files count as the source; `connectors` are `mcp:<namespace>` (MCP tools served under that namespace) or `url:<prefix>` (fetched URLs by prefix); `label` and `source` are informational. A source needs at least one root or connector. Roots, labels, and connector ids never leave the machine.

- `observatory setup` reads Obsidian's own vault registry (`obsidian.json` under Roaming AppData on Windows, Application Support on macOS, `~/.config` on Linux) and offers each vault not yet configured as a source keyed `obsidian.<vault id>`, with the folder name as the local label and `obsidian:<vault id>` as the source; a vault already configured under its source id or default key is not proposed again. Each question defaults to no, and `setup --yes` prints a hint instead of adding anything, so an unattended setup never tracks a vault.
- `observatory resources` lists every source with its roots (and whether each root directory exists), the local deny state, and, once a run has created the state, each key's current configuration token and per-binding access counts by key, kind, and evidence basis plus inspection counts by class. `observatory resources add --key <key> --root <dir>... [--connector <id>]... [--label <text>] [--source <text>]` adds a source or replaces the one with that key after validation; `observatory resources remove --key <key>` deletes it. Both edit `companion.json` in place.
- Access rows hang off tool invocations, so they upload only while `execution.detail_level` is `requests_with_tools`; at `requests` or `buckets_only` the companion still classifies locally and reports the `resource` capability as disabled by setting. The local deny entry `execution.resource_attribution` (or the `execution` prefix) keeps every row on the machine, at emit time and again when queued records are rebuilt for upload.
- What leaves the machine per matched call: the source key, an opaque `cfg:<16 hex>` configuration token the state assigns at random on first sight of that source's configuration, the access kind (`read`, `search`, `write`, `unknown`), the evidence basis (`explicit_argument`, `connector`, `indirect_shell`), the invocation's outcome, and the invocation join. Being inside a vault is context only: a working directory resolves relative arguments and is never access by itself.
- Changing a source's roots, connectors, or key, or adding or removing a source, changes the scan generation: the next run drops the binding's local resource rows and inspections and replays retained transcripts from the start, which is one full local rescan. Rows queued under the replaced generation are marked `superseded_configuration` until the replay re-emits them; rows under an earlier token or a removed key stay marked and never upload. Removing a source stops future uploads for its key but never retracts rows the Observatory already holds; the server ledger is append-only.
- On the Observatory, each `(install, key)` pair is an identity; `GET` and `PUT /api/usage-knowledge-sources` create, rename, map, and unmap stable labeled sources across identities and machines, and the read model reports current-configuration rows, earlier-configuration rows, overlap (one call touching several sources), and detection coverage separately. The settings UI for this is USG-015.

### Allowance readers, identity, and freshness

The Claude statusline reader moved out of `claude_execution` into the `claude_account` adapter, which now owns the Claude allowance meter: parser version `2.1.0+statusline1`, adapter `claude_account`, channel `hook_snapshot`, reader `statusline`. Record ids are unchanged, because what derives them — the binding, the channel, and a locator of reader, meter key, and observation time — did not move with the adapter, so a reading the Observatory already holds keeps its id. `allowance.claude_reader` gates that adapter now: `off` is the only value that stops it, and selecting `oauth_usage` also calls the private OAuth usage interface while the statusline reader keeps running as the documented fallback (`reader_fallback_statusline` when the OAuth call has no credential). Observatory never POSTs a refresh_token; `allowance.claude_oauth_keepalive` may spawn Claude Code so *it* refreshes the store. Connections and Allowances call the fallback out when OAuth failed. Codex embedded readings stay in `codex_execution`, because they are a by-product of the same rollout scan. `codex_account` refreshes the same meters through app-server when selected; `codex_execution` still reports `reader_fallback_embedded` in that mode because the embedded row is a by-product of the rollout scan. `web_backend` stays unimplemented.

**The identity stamp.** `observatory statusline` resolves the Claude config file in order — `OBSERVATORY_CLAUDE_CONFIG_FILE` (a test and override seam), `$CLAUDE_CONFIG_DIR/.claude.json` (the profile the session that runs the hook is using), then `~/.claude.json` — and takes the account uuid out of `oauthAccount`; nothing else from that file is kept. Each sample gains `identity_hash`, the same `sha256(stableJson([provider, account uuid]))` a binding confirms; v1 `collect.py` ignores the field and the six-field slot digest excludes it, so an identical reading stays one reading. The file is parsed only when its `stat` changed since the cache `<config dir>/claude-identity-cache.json` (`0600`, `{ "<config file path>": { mtime_ns, size, evidence_hash|null } }`), so the usual cost is one `stat`; a signed-out file caches `null`, a file over 8 MB is not parsed, and a half-written file yields nothing and leaves the cache alone. Keying the cache by path means two `CLAUDE_CONFIG_DIR` profiles sharing one companion directory each keep their own change detection.

**Binding, quarantine, and release.** A stamped sample binds to the enabled Claude binding whose confirmed server hash equals the stamp and that is free of identity conflict — whichever account happens to be signed in at run time. Several such bindings hold it as `identity_ambiguous`, none holds it as `unpaired_identity`. An unstamped sample (an older hook, an unreadable config) binds only when the install has exactly one enabled Claude binding and that binding is confirmed; a lone unconfirmed binding holds it as `identity_unconfirmed` with that binding recorded as its only possible candidate, and several bindings hold it as `identity_ambiguous`. Held samples live in a separate state table (schema 8), never reach the dirty slots, and are never emitted. Every run re-evaluates them: a stamped row is released once its hash binds, an unstamped `identity_unconfirmed` row is released only to the candidate binding it was held for and only once that binding is confirmed, and an unstamped `identity_ambiguous` row is never released, because no later change of bindings can say whose reading it was. Held rows are pruned after `max(local_raw_retention_days, 7)` days unless their stamp still pairs with an enabled binding's hash, so a binding waiting for a conflict to clear keeps its readings. A sample whose digest is already stored or already held is skipped before any binding decision, so replaying a retained inbox emits nothing twice.

**One identity per binding.** The companion does not post the local evidence as a binding's identity when another binding of the same install and provider already holds that hash (enabled or not), or when another *enabled* binding of the same provider still has a null hash: in the second case the evidence is ambiguous between the two candidates. Both bindings stay `Unconfirmed`, and the allowance row says what it cannot tell apart. To recover, either disable one of the bindings in the Observatory and run again, or sign into the other account and run. The Observatory refuses the same case from its side: `POST /api/v1/companion/bindings/<id>/identity` answers 409 `identity_taken` for a hash a sibling binding of that install already holds, and Connections marks such a binding with the recovery hint.

**What the hook writes.** Instead of overwriting one file per UTC hour, the hook writes one part file per change, `<inbox>/<YYYY-MM-DDTHH>-<observed microseconds>.json` (an array, `0600`, written atomically), so concurrent Claude Code sessions never share a file. A window is written only when its `(used_percent, resets_at)` differs from the last kept reading or that reading is older than fifteen minutes, so an idle meter still proves the hook runs without writing on every render. Two files sit beside the inbox rather than inside it, where neither the reader nor v1 `collect.py` would parse them as samples: the status sidecar `claude-statusline-status.json` and the kept state `claude-statusline-latest.json` (`{ "<identity stamp or empty>": { "<window key>": { used_percent, resets_at, kept_at } } }`). The identity cache sits in the configuration directory itself. All three are `0600`. The run prunes the inbox after the adapters — retention `max(local_raw_retention_days, 2)` days, compared by the thirteen-character hour prefix of each file name — so a blocked or locally denied reader never lets part files accumulate, and files without an hour prefix are left alone.

**Reader health.** The adapter that reads a meter reports an `allowance` capability row, the eighth and last dimension: `claude_account` for Claude and `codex_execution` for the Codex embedded reader. `claude_execution` no longer reports one, because it no longer reads a meter. The detail level does not gate the row, so an install at `buckets_only` still reports its meters. For `claude_account` the row reads evidence first: `disabled_by_setting` / `reader_off` when the reader is off; otherwise, when this run bound, released, or held a sample, or the sidecar shows an invocation inside the freshness threshold, the first applicable of `identity_ambiguous`, `identity_unconfirmed`, `unpaired_identity`, `quarantined_samples`, `no_samples_offered`, `reader_fallback_statusline` (mode `oauth_usage`), and `hook_config_dir_mismatch`, else `complete` with `no_recent_samples` only when the newest bound sample is past the threshold. With no evidence at all the hook installation speaks: `unsupported` / `hook_not_installed` when no `statusLine.command` runs the `statusline` subcommand with a `--config-dir` (the executable path is never matched), `partial` / `hook_config_dir_mismatch` when it names another directory, and `unknown` / `hook_not_executing` when the command is installed but the sidecar is missing or stale — which is where Windows MSIX redirection surfaces. `codex_execution` reports `reader_off`, `reader_fallback_embedded` while `app_server` or `web_backend` is selected, or `complete` with the same `no_recent_samples` rule. `observatory doctor` prints a `claude_statusline` block with the hook state, the directory it names, the sidecar counters, and the held-sample counts by reason, and `doctor --offline` reads the cached config document instead of fetching it.

**Local deny entries.** `allowance.claude_reader.statusline`, or a dotted prefix of it such as `allowance.claude_reader`, now removes the statusline reader even when the server has selected `oauth_usage`, whose gate names the other reader; it also keeps statusline readings already queued in the outbox on the machine, whichever reader the server selects. As always the deny list can only remove, never add.

**Attainable refresh, per reader.** The statusline reader observes on every Claude Code render while a session is in use, writes on a changed value or every fifteen minutes, and uploads at the collection cadence. The Codex embedded reader observes on each rollout write and uploads at the cadence. The browser collector runs an alarm at the install's cadence (v1-only profiles: hourly) and reads through a signed-in `claude.ai` tab that must be open in that browser profile: the v2 path posts a coverage-only body naming the reason when it cannot read (no tab, signed out, account mismatch, unrecognized shape), which is contact and never a reading; the v1 path posts an empty sample set for usage it cannot parse and nothing at all without a tab. `oauth_usage` observes at the collection cadence through the existing Claude Code sign-in. Observatory never POSTs a refresh_token; with `allowance.claude_oauth_keepalive` on it may spawn Claude Code (`claude auth status`) so Claude Code refreshes its own store, then retries the usage call. `app_server` observes at the cadence through `codex app-server`. Cursor `usage_summary` and `dashboard_rpc` observe at the cadence through the Cursor session. `web_backend` stays unimplemented; selecting it reports `not_implemented`.

**Freshness, selection, and meters.** One rule decides staleness everywhere: a reading is stale when its age exceeds `max(120, 2 × cadence_minutes + 15)` minutes, or when its own window has already reset. The companion's `no_recent_samples` uses the same formula. The current reading per account and meter is the newest `observed_at` among enabled bindings of live installs whose reader is one of `statusline`, `oauth_usage`, `app_server`, `usage_summary`, `embedded`, `web_backend`, or `dashboard_rpc`; an exact tie falls to that reader order, and an unrecognized reader never wins. That selection is the v2-only read model behind `/api/usage-v2`; the live page's cards read the compatibility view, which is the union of those readings with the v1 browser samples (reader `v1`), keeps rows from a disabled source, binding, or install as `history_only` (cycle history, never the current reading), and shows a v1 sample that a v2 reading duplicates exactly once. The producer's meter key, label, duration, unit, reset anchor, raw window id, and scope are stored untouched; card titles come from a canonical label per meter key, so a label difference between readers never renames a card. Between readers, `five_hour` and `seven_day` match; a model-scoped weekly window is `seven_day_<slug of the display name>` from the statusline, the OAuth reader, and the browser collector alike (one slug rule, `observatory-core::inbox::window_slug`, mirrored by `normalize.js`), and the v2 browser collector also emits the companion's labels, so a window read by two readers is one meter; a statusline key that carries a provider model key instead of a display name can still differ, and then shows as its own meter. `extra_usage` is a browser-only meter. The v1 browser sample of a window keeps the v1 label, which the canonical title hides.

**Receipts are not readings.** An install's and a source's `last_seen_at` mean the collector contacted the server, and a coverage-only envelope advances them. The meter's own freshness comes from the ledgers instead: Connections shows each binding's newest `last_observation.allowance` (with its reset and reader) and `last_received.allowance` beside "last contact", each browser source the same way, and each run's `accepted_by_type` counts accepted, duplicate, and rejected records per record type (plus `invalid` for records that failed to parse), merged key-wise across the envelopes of one run.

**Deployment order.** The server and the `20260914010000_allowance_basis_and_run_counts.sql` migration go first, and the migration before the server code that writes `basis`: envelope v2 has no runtime negotiation and `ConfigDocument` rejects unknown fields, so a companion carrying the new `allowance` coverage row must not be installed before the server that accepts it. No production activation happens here; that is USG-025.

## Detailed monthly report, refreshed hourly

The **Monthly report** page (`/usage`) keeps the complete uploaded analysis: token composition, daily activity, models and pricing dimensions, projects, task families, work modes, agent orchestration, and source coverage. It reads the latest existing machine/month envelopes through `/api/reports`, refreshing once per visible minute. `/usage/reports` redirects to the same page. Current-month snapshots are explicitly month-to-date; percentage comparisons against a full prior month are suppressed until the month closes.

The companion's optional `detailed_report` adapter runs the installed local analyzers after ordinary hourly telemetry. It makes no model calls. Codex uses the supported token-analysis launcher; Claude Code merges its retained ledger and current transcripts without modifying the daily harvester. This preserves each analyzer's attribution, versioned pricing assumptions and missing-data labels. The reduced hourly counter ledger alone cannot reconstruct these fields. Browser quota-only collectors cannot generate detailed token reports.

The equivalent `detailed_report` block lives on the Codex binding in `companion.json`, using that machine's real paths and existing report identity:

```json
"detailed_report": {
  "script": "/absolute/path/to/current/detailed_report.py",
  "analyzer_path": "/absolute/path/analyze-monthly-token-usage/scripts/analyze_token_usage.py",
  "codex_home": "/absolute/path/.codex",
  "upload_config_path": "/absolute/path/token-usage-upload.json",
  "machine_id": "existing-machine-id"
}
```

For Claude Code, use its `claude_token_observatory.py` analyzer path and `analyzer_config_path` instead of `codex_home`. Pin the analyzer's Claude Code envelope identity, including its existing suffix. The separate upload config must already hold a usage-publisher credential for the same Observatory `/api/reports` origin; companion install keys cannot publish reports. Each computer must also have its analyzer, provider configuration, and publisher credential installed. Test with `observatory run --dry-run` before enabling the service.

Analysis uses each analyzer's local calendar month. Unchanged measured content creates no revision. Changed snapshots use the existing immutable report store; exact attempted artifacts are persisted privately and retried before reanalysis after uncertain upload outcomes. The previously active month receives one final snapshot after rollover; this does not backfill arbitrary missed complete months. Redundant monthly finalizers are retirement candidates only after this behavior covers their responsibilities. Detailed-report failures are logged separately and preserve the previous published snapshot; collector success and an empty telemetry outbox do not prove detailed publication succeeded. Snapshot change time appears on each machine card.

These reports cover available local logs and retained analyzer ledgers, not all possible browser/cloud activity. Missing source fields remain missing or labeled estimates. Never add these monthly snapshots to the separate hourly token ledger or invent hourly detail from daily totals.

## Allowance outlook

Usage → Allowances shows each account/window’s observed remaining allowance, a cycle chart and the remaining percentage projected at its reset. Every level is what is left: the summary meter starts a window full and empties as the allowance is spent, and the chart’s Y axis is remaining percentage points, 100% at the cycle start descending toward the reset. The solid line contains recorded readings. The dashed continuation uses either the measured percentage-point burn from the current reset window, a labeled prior derived from comparable completed cycles, or a blend of the two while a new window accumulates evidence. The dotted guide is the even-pace diagonal descending from 100% at the window start to 0% at the reset. Below 0% represents demand beyond capacity, with the estimated exhaustion time shown separately. Burn rates and completed-cycle point totals stay consumption; only levels are stated as remaining. Forecasts remain anchored to provider observations, so refreshing the page alone does not create new evidence.

Each account and window is independent. Forecasts require fresh readings and at least 30 minutes of usable history; no readings, stale data, resets, decreases and collection gaps produce explicit waiting states. Accounts without quota readings are shown as awaiting collection. Token report averages are not converted into subscription capacity. The old custom daily-token budget comparison has been removed; full monthly reports remain accessible through Monthly report. Codex Spark allowance cards are hidden by default and can be shown with the toggle.

### Paused cloud estimate

The experimental cloud/uncollected token-equivalent card and calibration controls have been removed from the allowance view. Existing calibration evidence and API support remain stored for potential later use; no estimate is displayed or included in token totals or allowance projections.

## Accounting and predictions

- Token categories are exclusive: fresh input, cached input, cache-write input, output. Output already includes reasoning; do not add reasoning tokens a second time.
- Codex cumulative counters become deltas; repeated counters add nothing. Forked parent history before the child's own task starts is excluded. Claude repeated message IDs contribute one canonical counter record.
- Hourly snapshots are complete for the collector's covered source ledger. The server retains revisions and chooses the greatest call count, then greatest token total per account/session/hour/model, then latest observation. Mirrored partial copies never add to each other. Downward accounting corrections require a future explicit reconciliation; this experimental collector intentionally does not silently replace a more complete snapshot with a smaller one.
- The full detailed monthly reports remain at `/usage` and may be refreshed hourly by configured local analyzers. They are never expanded into invented hours or added to live totals. No quota percentage is calculated from tokens.
- Token velocity uses the last six complete UTC hours, including idle hours; the 24-hour card uses complete hours as well. Current partial hours remain visible in the chart. Missing local logs, cloud/browser activity, malformed records, or unavailable roots produce incomplete coverage. A fresh upload is not proof all usage is covered.
- A measured current-window quota pace needs at least 30 minutes of samples within one reset window, with no gap above three hours, no decrease, and fresh data (at most two hours old). Until then, the page can show a clearly labeled historical seed from up to eight comparable completed cycles in the 35-day read horizon. The estimator uses a weighted median, shows the historical range, blends the prior out as the first 10% of the new cycle elapses, and never bridges a reset when measuring the live slope. A single sample therefore never produces a measured current-window pace, although it can inherit a historical seed. Provider reset timestamps stay authoritative; public global-reset forecasts do not change them.

## Public reset feeds

The active source allowlist, provider mappings, calendar behavior, normalization, failure handling, and verification evidence live in [reset feeds](reset-feeds.md). Keep that document authoritative instead of copying provider-specific instructions here. Current concurrent source changes select NextReset for Codex and retain Reset Radar for Claude; deployment of those changes was not verified by this usage audit.

Checked-in Vercel configuration schedules a daily feed check at 13:15 UTC. Opening the reset calendar (`/usage/allowances#reset-calendar`) or Settings → Reset feeds can request a refresh, constrained by a shared 30-minute lease. The v2 companion does not implement hourly feed refresh; that old claim referred to the v1 collector's `--refresh-feeds` option.

Feed fetching and normalization use no model calls. These are attributed public reset/announcement claims, never personal allowance observations, token counts, or permission to redeem a credit. Retained source snapshots are separate historical evidence.
