# V2 usage collection

This is the current companion operating guide. Start with [how Usage actually works](usage-system.md) for the feature inventory and verified status. All old collector, data-migration, and scheduler-removal instructions live separately in [v1 retirement](usage-v1-retirement.md).

The `observatory` companion uses **zero model calls**. It reads provider-owned local stores, checkpoints progress in SQLite, and publishes cumulative hourly buckets and independent allowance readings; request records are optional. Provider account aggregates and money have server contracts but their adapters are not implemented. Public feed fetching and the existing v1 browser quota collector also use ordinary code. Separate AI monthly automations still exist and do invoke a model session; they are not part of the companion run loop.

For what each collector can and cannot attribute (tokens, allowances, money, project, surface) per provider and surface, and the process behind each cell, see [usage coverage](usage-coverage.md).

## Companion install (v2, one binary per machine)

The `observatory` companion (`companion/`, see its README) replaces the local script, the statusline hook, and the schedule installer. Pairing and settings live in the Observatory:

1. Usage → Connections → **Add companion**: label the machine and copy the one-time code (ten minutes, single use).
2. On the machine: `observatory connect --url https://<observatory> --code XXXX-XXXX`, then `observatory setup`. Use one explicit config directory on Windows as shown below: packaged apps can redirect new `%LOCALAPPDATA%` folders into a private store. Setup discovers stores, proposes bindings, asks about reader modes, the Claude statusline hook and schedule, then performs a dry run, a first publish, and `service install`. Some proposed modes are still stubs; see the capability table below. The first run pins the backfill start (`--since YYYY-MM-DD` on `connect`, default the first day of the current UTC month) and reads available local transcripts from that date. It does not import old collector state or prove historical parity. Do not delete the state database to extend backfill: preserve checkpoints, outboxes and receipts and follow the migration/recovery process first.
3. Usage → Settings holds the collection modes: global defaults plus a per-install override. Every install fetches the effective document on each run; a local `deny` list in `companion.json` can only remove modes.
4. Connections shows each install's version, platform, last run, applied settings version, "update available", every binding's identity state, and the per-adapter coverage from the latest run. "Off" is always distinguishable from "broken".

The companion emits the same *shape and intended identity rules* for hourly buckets as the v1 script, plus typed allowance readings and optional requests. This is compatibility, not proof that historical backfill matches; the current audit found many v1-only keys. `/api/v1/usage` is the v2 endpoint despite the API namespace. All old runtime and data dependencies are listed in the [retirement inventory](usage-v1-retirement.md#what-belongs-to-v1).

The Claude statusline hook publishes every window Claude Code reports, including the model-scoped weekly windows (for example the Fable weekly cap), each as its own card under Current allowances with a `model-scoped weekly` badge. A scoped window is never added to the pooled weekly window.

With the **Detailed monthly report (analyzer)** setting on (global or per install), each run also executes the detailed analyzer adapter for every configured binding. Setup can copy an old connection's configuration, but the `script` path may still point into the old directory. Verify and relocate all such dependencies before deleting it. The adapter, analyzer, provider configuration, and usage-publisher credential remain protected local dependencies.

**Add browser** currently issues a code for an unimplemented v2 browser collector. It is not a usable new installation path. Existing v1 browser sources use their separate controls and are not governed by v2 browser switches.

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

Do not re-pair a working install for troubleshooting. After changing cadence in Settings, apply it to Task Scheduler with `& $companionExe --config-dir $companionDir service install`. Normal `run` fetches collection settings but does not rewrite the OS schedule. Inspect the next scheduled run and the detailed-report result separately.

The supported local footprint is the installed `observatory` binary, one companion config/state directory, the detailed adapter/analyzer and protected usage-publisher credential when enabled, and the provider-owned `.codex` / `.claude` stores that are the source data. The companion config directory contains its JSON config, SQLite checkpoint/receipt state, lock, inbox, logs, safety backups, and detailed-report retry state; these are one managed runtime tree, not separate installs.

The directory boundary must be verified per machine: `%LOCALAPPDATA%\PersonalObservatory` is the CLI's Windows **default v2** directory. Do not delete a directory by its name. This Windows install uses the explicit profile-root directory above.

## Implemented versus selectable

| Capability | Current implementation |
| --- | --- |
| Claude Code / Codex local counters | Implemented; optional request detail and hashed projects. |
| Claude statusline / Codex embedded allowance | Implemented within the execution adapters. |
| Claude OAuth, Codex app-server/web backend | Stub adapters; settings do not make them functional. |
| Cursor local state and hosted history | Discovery and binding only; both collectors are stubs. |
| Anthropic/OpenAI Admin usage and billing | Stubs. |
| V2 browser collection | Not implemented. |
| Tool extraction / Cursor project hooks / live `serve` | Not implemented. |
| Detailed monthly analysis | Implemented adapter with external local dependencies; publication can fail independently. |

For each setting's meaning and currently active values, see [the system guide](usage-system.md#settings--usagesettings). The technical roadmap belongs in [usage coverage](usage-coverage.md), not install promises.

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

Usage & pace shows each account/window’s observed remaining allowance, a cycle chart and projected percentage used by its reset. The solid line contains recorded readings. The dashed continuation uses either the measured percentage-point burn from the current reset window, a labeled prior derived from comparable completed cycles, or a blend of the two while a new window accumulates evidence. The dotted guide spreads 100% evenly across the cycle. Above 100% represents demand beyond capacity, with the estimated exhaustion time shown separately. Forecasts remain anchored to provider observations, so refreshing the page alone does not create new evidence.

Each account and window is independent. Forecasts require fresh readings and at least 30 minutes of usable history; no readings, stale data, resets, decreases and collection gaps produce explicit waiting states. Accounts without quota readings are shown as awaiting collection. Token report averages are not converted into subscription capacity. The old custom daily-token budget comparison has been removed; full monthly reports remain accessible through Monthly report. Codex Spark allowance cards are hidden by default and can be shown with the toggle.

### Paused cloud estimate

The experimental cloud/uncollected token-equivalent card and calibration controls have been removed from Usage & pace. Existing calibration evidence and API support remain stored for potential later use; no estimate is displayed or included in token totals or allowance projections.

## Accounting and predictions

- Token categories are exclusive: fresh input, cached input, cache-write input, output. Output already includes reasoning; do not add reasoning tokens a second time.
- Codex cumulative counters become deltas; repeated counters add nothing. Forked parent history before the child's own task starts is excluded. Claude repeated message IDs contribute one canonical counter record.
- Hourly snapshots are complete for the collector's covered source ledger. The server retains revisions and chooses the greatest call count, then greatest token total per account/session/hour/model, then latest observation. Mirrored partial copies never add to each other. Downward accounting corrections require a future explicit reconciliation; this experimental collector intentionally does not silently replace a more complete snapshot with a smaller one.
- The full detailed monthly reports remain at `/usage` and may be refreshed hourly by configured local analyzers. They are never expanded into invented hours or added to live totals. No quota percentage is calculated from tokens.
- Token velocity uses the last six complete UTC hours, including idle hours; the 24-hour card uses complete hours as well. Current partial hours remain visible in the chart. Missing local logs, cloud/browser activity, malformed records, or unavailable roots produce incomplete coverage. A fresh upload is not proof all usage is covered.
- A measured current-window quota pace needs at least 30 minutes of samples within one reset window, with no gap above three hours, no decrease, and fresh data (at most two hours old). Until then, the page can show a clearly labeled historical seed from up to eight comparable completed cycles in the 35-day read horizon. The estimator uses a weighted median, shows the historical range, blends the prior out as the first 10% of the new cycle elapses, and never bridges a reset when measuring the live slope. A single sample therefore never produces a measured current-window pace, although it can inherit a historical seed. Provider reset timestamps stay authoritative; public global-reset forecasts do not change them.

## Public reset feeds

The active source allowlist, provider mappings, calendar behavior, normalization, failure handling, and verification evidence live in [reset feeds](reset-feeds.md). Keep that document authoritative instead of copying provider-specific instructions here. Current concurrent source changes select NextReset for Codex and retain Reset Radar for Claude; deployment of those changes was not verified by this usage audit.

Checked-in Vercel configuration schedules a daily feed check at 13:15 UTC. Opening Reset intelligence can request a refresh, constrained by a shared 30-minute lease. The v2 companion does not implement hourly feed refresh; that old claim referred to the v1 collector's `--refresh-feeds` option.

Feed fetching and normalization use no model calls. These are attributed public reset/announcement claims, never personal allowance observations, token counts, or permission to redeem a credit. Retained source snapshots are separate historical evidence.
