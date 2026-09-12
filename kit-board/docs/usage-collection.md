# Script-based usage collection

The runtime uses **zero model calls**. Python 3.10+ and its built-in SQLite store read counters locally, checkpoint JSONL offsets, and publish cumulative hourly buckets. No new Python packages are required. Public feed fetching and browser quota collection also use ordinary code, with no AI inference.

## Local setup (macOS / Windows)

1. In Observatory → AI usage → Connections, download a **local** connection for the correct account. Reuse the same account ID on multiple machines that use that account. Give each machine its own connection. Existing IDs are shown in the account selector and connection list.
2. Download and unzip the local collector. Store the connection JSON in a private local directory outside source control. It contains an upload key scoped to that account, not a provider login or DB password.
3. Run `python3 collect.py --config /absolute/path/connection.json --dry-run` (`py` can replace `python3` on Windows). The first run indexes local logs from the start of the current UTC month. `--since YYYY-MM-DD` chooses a different initial backfill date; this date is then pinned in the local state.
4. Run the same command without `--dry-run` to publish. SQLite keeps pending batches and receipts, so retries require no source reanalysis and duplicate uploads do not add tokens.
5. Run `python3 install_schedule.py --config /absolute/path/connection.json` to install an hourly macOS LaunchAgent or Windows Task Scheduler task. Add `--refresh-feeds` on one collector to trigger cached public-feed checks. Use `--uninstall` with the same config to stop that connection's schedule.

The schedule runs while the user is logged in. A sleeping/offline computer reports after it wakes. Windows requires an installed Python interpreter and a logged-in interactive session for the default task. Keep the downloaded collector and connection file at their configured paths.

### Windows: where to put the downloaded file

For a **Local script** connection, use `%LOCALAPPDATA%\PersonalObservatory` (normally `C:\Users\<you>\AppData\Local\PersonalObservatory`). Create that folder and extract the local collector ZIP there. Move the downloaded connection JSON into the same folder and rename it `connection.json`. The folder should contain `collect.py`, `install_schedule.py`, `statusline.py`, and `connection.json`. Python 3.10+ is required.

Run in PowerShell, checking each command succeeds before continuing:

```powershell
Set-Location "$env:LOCALAPPDATA\PersonalObservatory"
py -3 .\collect.py --config .\connection.json --dry-run
py -3 .\collect.py --config .\connection.json
py -3 .\install_schedule.py --config .\connection.json
```

The dry run indexes logs without uploading; the second run uploads; the last installs the hourly task. Confirm `ok: true` from the upload and a fresh Last check on the Connections page. Keep the folder outside Git, cloud-synced folders, and temporary Downloads cleanup. The JSON contains a scoped upload key. Each provider/account gets its own connection file: for example, keep `codex.json` and `claude.json` and use the corresponding filename in all commands. Do not replace a file already used by a scheduled task.

A **Browser** connection JSON is imported into the browser collector extension popup instead. It does not go into Claude settings or the Python script. Follow the browser steps below; the extension keeps its configuration after import.

Default roots are `~/.codex/sessions` plus `~/.codex/archived_sessions` for Codex, and `~/.claude/projects` for Claude. For Claude Desktop Code/Cowork or another CLI profile, add a `roots` array of absolute log directories to the connection **before the first scan**. Nested `.jsonl` files are discovered recursively. Only account-owned roots belong in a connection; the collector cannot infer the authenticated account from a token log. Changing accounts or roots requires new collector state. Do not point both Claude accounts at the same roots.

Counters retained locally: session hashes, request/message hashes, UTC hour, model, exclusive token categories, call count, file checkpoints, quota readings, and receipts. Prompt text, assistant content, repository names, and source paths are not uploaded. Local checkpoint paths stay in SQLite. Normal logs contain only counters and bounded errors.

## Claude Code allowance hook (optional)

The supported statusline JSON includes `rate_limits` after an eligible Claude.ai session has received a response. Configure the bundled `statusline.py --inbox /private/path/claude-quota` as a statusline command, or call it from an existing wrapper while preserving that wrapper's output. Add `"quota_inbox": "/private/path/claude-quota"` to that Claude connection. The hourly collector uploads the whitelisted quota fields. The hook never makes an inference request and must not overwrite an existing custom statusline without preserving it. Windows supports the same Python script.

## Second personal Claude account in a browser

1. Use Chrome or Edge in the profile signed into the intended Claude account. Windows is optional.
2. Download and unzip the browser collector. Open the browser's Extensions page, enable Developer mode, and choose **Load unpacked** for that folder. Installation is a user/browser action.
3. Download a **Claude / Browser** connection from the Observatory, then import the file in the extension popup. Use a distinct account ID such as `claude-personal` for this second account.
4. Keep a signed-in `https://claude.ai/` tab open. Click **Find my Claude account**, verify the displayed identity, and explicitly pin the correct organization. Collection then uploads a first reading and runs hourly.
5. Check the popup's last successful upload and the Observatory's account cards. If the profile changes to a different Claude account, uploads pause until explicitly paired again. Sign-in or browser verification must be completed normally in Claude.

Only numeric allowance utilization and reset times are uploaded. Claude session cookies never leave the browser. The extension stores its Observatory quota-only upload key in extension-local storage restricted to trusted extension contexts. It requests access only to Claude and this Observatory; no cookie permission or conversation API is used.

This is an **experimental web adapter**, using the same usage endpoints documented by CodexBar. Claude can change them. The official personal Settings → Usage page is authoritative. This does not use Anthropic Console's Admin Usage API, which reports separately billed API usage and is not a personal subscription token ledger. Browser-only activity cannot be reconstructed as exact token counts from quota percentages. Installing Claude Code on the second account provides future local Code token logs, not past browser-chat token history.

## Detailed monthly report, refreshed hourly

The **Monthly report** page (`/usage`) keeps the complete uploaded analysis: token composition, daily activity, models and pricing dimensions, projects, task families, work modes, agent orchestration, and source coverage. It reads the latest existing machine/month envelopes through `/api/reports`, refreshing once per visible minute. `/usage/reports` redirects to the same page. Current-month snapshots are explicitly month-to-date; percentage comparisons against a full prior month are suppressed until the month closes.

The optional `detailed_report` step in `scripts/telemetry/collect.py` runs the installed local analyzers after ordinary hourly telemetry. It makes no model calls. Codex uses the supported token-analysis launcher; Claude Code merges its retained ledger and current transcripts without modifying the daily harvester. This preserves each analyzer's attribution, versioned pricing assumptions and missing-data labels. The reduced hourly counter ledger alone cannot reconstruct these fields. Browser quota-only collectors cannot generate detailed token reports.

Add this object to an existing **local** Codex connection file, using that machine's real paths and existing report identity:

```json
"detailed_report": {
  "analyzer_path": "/absolute/path/analyze-monthly-token-usage/scripts/analyze_token_usage.py",
  "codex_home": "/absolute/path/.codex",
  "upload_config_path": "/absolute/path/token-usage-upload.json",
  "machine_id": "existing-machine-id"
}
```

For Claude Code, use its `claude_token_observatory.py` analyzer path and `analyzer_config_path` instead of `codex_home`. Pin the analyzer's Claude Code envelope identity, including its existing suffix. The separate upload config must already hold a usage-publisher credential for the same Observatory `/api/reports` origin; quota/telemetry keys cannot publish reports. The collector bundle includes the adapter, but each computer must also have its analyzer, configuration and publisher credential installed. Test with the collector's `--dry-run` before enabling its schedule.

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
