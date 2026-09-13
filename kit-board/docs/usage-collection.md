# Usage collection

Collection uses **zero model calls**. The `observatory` companion reads provider-owned local stores, checkpoints progress in SQLite, and publishes cumulative hourly buckets plus independent allowance, aggregate, and money records. Public feed fetching and browser quota collection also use ordinary code, with no AI inference.

For what each collector can and cannot attribute (tokens, allowances, money, project, surface) per provider and surface, and the process behind each cell, see [usage coverage](usage-coverage.md).

## Companion install (v2, one binary per machine)

The `observatory` companion (`companion/`, see its README) replaces the local script, the statusline hook, and the schedule installer. Pairing and settings live in the Observatory:

1. Usage → Connections → **Add companion**: label the machine and copy the one-time code (ten minutes, single use).
2. On the machine: `observatory connect --url https://<observatory> --code XXXX-XXXX`, then `observatory setup`. From a Claude Code session inside the Claude desktop app on Windows, add `--config-dir %USERPROFILE%\.config\personal-hub\companion` to both: the app redirects new `%LOCALAPPDATA%` folders into its private store, and the companion refuses to set up there. Setup discovers Claude Code and Codex stores, proposes bindings, asks once about the private-interface readers, the Claude statusline hook (an existing statusline command is preserved), and the schedule, then runs a dry run, a first publish, and `service install`. The first run pins the backfill start (`--since YYYY-MM-DD` on `connect`, default the first day of the current UTC month) and reads every local transcript from that date on; the schedule then keeps up hourly. To reach further back later, remove the install's state database and run again.
3. Usage → Settings holds the collection modes: global defaults plus a per-install override. Every install fetches the effective document on each run; a local `deny` list in `companion.json` can only remove modes.
4. Connections shows each install's version, platform, last run, applied settings version, "update available", every binding's identity state, and the per-adapter coverage from the latest run. "Off" is always distinguishable from "broken".

The companion emits the same hourly buckets the v1 script published, plus allowance readings, provider aggregates, and money as separate ledgers. The legacy local and browser collector credentials were disabled on September 13, 2026; the website no longer creates connection files, serves collector bundles, or accepts `POST /api/v1/telemetry`.

The Claude statusline hook publishes every window Claude Code reports, including the model-scoped weekly windows (for example the Fable weekly cap), each as its own card under Current allowances with a `model-scoped weekly` badge. A scoped window is never added to the pooled weekly window.

With the **Detailed monthly report (analyzer)** setting on (global or per install), each run also executes the detailed analyzer adapter for every binding whose `companion.json` entry carries a `detailed_report` block. Setup can copy that block from an old connection during migration, but the old connection and collector directory are not needed afterward. The analyzer, its provider configuration, and the usage-publisher credential remain protected local dependencies.

**Add browser** issues a code for the v2 browser collector workstream. It does not reactivate or authorize the retired v1 Claude extension.

## Retired v1 cleanup

Do not reinstall `collect.py`, `install_schedule.py`, `statusline.py`, or the unpacked Claude quota extension. Their production source credentials are disabled. Remove their Task Scheduler tasks or LaunchAgents first, then archive and delete the old collector directory after confirming the companion has a recent accepted receipt and an empty outbox.

The supported local footprint is intentionally small: the installed `observatory` binary, one companion config/state directory, one protected usage-publisher credential when detailed reports are enabled, and the provider-owned `.codex` / `.claude` stores that are the source data. The companion config directory contains its JSON config, SQLite checkpoint/receipt state, lock, inbox, logs, safety backups, and detailed-report retry state; these are one managed runtime tree, not separate installs. The old `PersonalObservatory` or `~/.config/personal-hub/telemetry` tree is not part of v2.

## Detailed monthly report, refreshed hourly

The **Monthly report** page (`/usage`) keeps the complete uploaded analysis: token composition, daily activity, models and pricing dimensions, projects, task families, work modes, agent orchestration, and source coverage. It reads the latest existing machine/month envelopes through `/api/reports`, refreshing once per visible minute. `/usage/reports` redirects to the same page. Current-month snapshots are explicitly month-to-date; percentage comparisons against a full prior month are suppressed until the month closes.

The companion's optional `detailed_report` adapter runs the installed local analyzers after ordinary hourly telemetry. It makes no model calls. Codex uses the supported token-analysis launcher; Claude Code merges its retained ledger and current transcripts without modifying the daily harvester. This preserves each analyzer's attribution, versioned pricing assumptions and missing-data labels. The reduced hourly counter ledger alone cannot reconstruct these fields. Browser quota-only collectors cannot generate detailed token reports.

The equivalent `detailed_report` block lives on the Codex binding in `companion.json`, using that machine's real paths and existing report identity:

```json
"detailed_report": {
  "analyzer_path": "/absolute/path/analyze-monthly-token-usage/scripts/analyze_token_usage.py",
  "codex_home": "/absolute/path/.codex",
  "upload_config_path": "/absolute/path/token-usage-upload.json",
  "machine_id": "existing-machine-id"
}
```

For Claude Code, use its `claude_token_observatory.py` analyzer path and `analyzer_config_path` instead of `codex_home`. Pin the analyzer's Claude Code envelope identity, including its existing suffix. The separate upload config must already hold a usage-publisher credential for the same Observatory `/api/reports` origin; companion install keys cannot publish reports. Each computer must also have its analyzer, provider configuration, and publisher credential installed. Test with `observatory run --dry-run` before enabling the service.

Analysis uses each analyzer's local calendar month. Unchanged measured content creates no revision. Changed snapshots use the existing immutable report store; exact attempted artifacts are persisted privately and retried before reanalysis after uncertain upload outcomes. The previously active month receives one final snapshot after rollover. Existing monthly finalizers remain unchanged. Detailed-report failures are logged separately and preserve the previous published snapshot; collector success alone does not prove detailed publication succeeded. Snapshot change time appears on each machine card.

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

Allowlisted sources: Codex Reset `/api/timeline`, `/api/feed`, `/api/forecast`; Reset Radar `/feed.json`. Only reset history, reset/banked-reset announcements, expectations, and forecasts are shown. Unrelated posts and general model news are excluded. Feed code validates schema, bounds response size and runtime, rejects redirects, supports conditional requests, and keeps prior data on failure. A database lease prevents duplicate refreshes for 30 minutes.

Vercel runs one daily feed check; the designated hourly local collector and opening the reset view provide more frequent checks. Feed runtime uses no AI. External sources may use their own models; their forecasts and classifications are attributed as external claims. Immutable normalized snapshots retain corrections; the current UI uses the newest snapshot. Source check times and upstream forecast timestamps are displayed separately. The reset page opens with a compact 300px calendar beside the event record, showing all reset types. Day cells contain date numbers and small type markers; provider and event type remain separate filters. Codex global resets, banked resets, announced updates, watches/signals, forecasts and credits are distinct. Claude counter events are labeled as allowance-window flushes, even when the source calls them broadly observed or “global”; they do not imply a Codex-style goodwill reset or that an individual weekly allowance reset. Banked lifecycle state, Codex global scope and verification metadata are retained from the source. Banked credits never count as an observed global reset. Announcements and later observations can share a source URL without one hiding the other; duplicate references within the same event stage prefer the curated timeline. Calendar and record dates use UTC: reported history uses effective time when available, and announcements/forecasts use publication time. Select a day for details or use Show more for older records. Empty days mean no matching saved entry, not proof that no reset occurred.

The Codex Reset model's 24-hour and 48-hour global-reset probabilities appear in a small panel with the calendar. They are an external likelihood forecast, not an announced window and not a personal allowance reset. The previous large empty forecast card is removed. An announcement banner appears only when the forecast feed contains an active official signal. During local development, `?preview=announcement` shows sample banner copy for design review; the preview is disabled in production builds and never changes stored feed data.

Normalizer version 4 triggers a bounded refresh of older saved payloads and omits their conditional upstream headers, so previously discarded or corrected type fields can be recovered. Failed upgrades keep the previous payload and normal retry delay; the error records the normalizer version. No database migration is required.
