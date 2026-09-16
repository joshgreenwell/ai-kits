# V1 usage retirement

Target: preserve all useful v1 data, migrate facts into appropriate current structures where possible, and remove the old collectors, schedules, endpoints, credentials, and instructions. This is an execution runbook, **not a record of completed deletion**. The [current audit](usage-system.md) states what was verified on September 13, 2026. V2 setup is separate in [usage collection](usage-collection.md).

## What belongs to v1

| Component | Current role | Retirement treatment |
| --- | --- | --- |
| `scripts/telemetry/collect.py` | Retired local collector; still used as a parity reference in tests. | Remove operational copies and eventually the reference implementation after freezing/documenting expected fixtures. |
| `scripts/telemetry/install_schedule.py` | Old per-provider schedule installer/uninstaller. | Remove after uninstalling tasks; do not install it again. |
| `scripts/telemetry/statusline.py` | Old Claude hook. | Remove only the old hook/wrapper; preserve the companion-managed statusline and unrelated user's statusline. |
| Windows `scheduled_run.py` and old runtime tree | Local wrapper and per-source connections/state/logs. | Stop jobs, preserve state and receipts, remove executable/config copies after reconciliation. |
| `browser/claude-quota/` and unpacked extensions | Active v1 Claude browser allowance producer. | Replace with a working v2 browser path, or explicitly end browser collection. Archive its historical data before removal. |
| `/api/v1/telemetry`, `/api/usage-connections`, browser control UI | Legacy quota ingress and source management. | Remove after the last browser cutover. A temporary Gone response may make old clients fail clearly. |
| `/api/collector-download` | Retired download tombstone. | Remove once old deployment/download links have been retired; never restore the bundle. |
| Old Token Observatory sync | Imports detailed reports through `lib/legacy-usage.ts` and `/api/internal/sync-legacy-usage`. | Finish report parity, switch all desired producers, remove cron/route/module/tests and `LEGACY_USAGE_CONFIG_JSON`, then retire old-site credentials. |
| AI monthly usage schedules | Separate schedules launching analyzers, potentially aimed at the old site. | Remove when deterministic report collection/finalization replaces their responsibilities. Preserve report artifacts and analyzer code still in use. |
| `scripts/telemetry/detailed_report.py` | **Active shared monthly adapter invoked by v2.** | Relocate/reclassify as the current detailed-report adapter, update references and installed paths, then remove the obsolete telemetry directory. Do not delete this dependency outright. |
| External detailed analyzers and Claude ledger harvest | Supply monthly fields not present in hourly buckets. | Preserve data and keep required capability; move scheduling into the chosen current process before removing old jobs. Their age/name does not make their output disposable. |

Do not delete `token_bucket_revisions`, `report_revisions`, provider `.codex` / `.claude` / Cursor stores, the active companion, generic report publishers, or an endpoint solely because its name contains `v1` or `legacy`. Several remain current data dependencies. Do not rewrite applied migration files; use new migrations for schema changes.

## Data preservation and migration

Before mutation, create a private, restorable database backup and a per-machine archive outside Git. Include old collector SQLite databases and WAL state, configs, inboxes, outboxes, receipts, retained analyzer ledgers, generated reports, scheduler definitions, and any secrets needed temporarily for recovery. Stop old writers before taking SQLite backups, or use SQLite's backup API. Record file hashes, row counts, observation ranges, and canonical totals. A copied live `.sqlite3` file without its WAL is not sufficient.

Keep secret values out of committed manifests. Back up **data** permanently as required; temporary executable/credential rollback copies are removed after acceptance. Never erase provider-owned histories as collector cleanup.

| V1 data | Current/target representation | Rules |
| --- | --- | --- |
| Hourly token revisions | Retain `token_bucket_revisions` as shared measured history initially. If eliminating that table is required, introduce a dedicated local-hourly representation plus legacy provenance. | Preserve account/session/hour/model keys, calls, exclusive token categories, observation/receipt times, revisions and hashes. Do not put local counters into the provider-reported `account_usage_buckets` ledger. |
| Original transcripts or sufficiently detailed retained event data | Reparse into `activity_requests` where facts are supported and request detail is enabled. | Preserve semantic identity, unknown/null fields, surface/source basis and provenance. Hourly aggregates alone cannot invent requests, project hashes, tools, exact timestamps, or agent relationships. |
| Quota samples | `allowance_readings` with `kind: percent_used`, a deliberate legacy source-to-binding mapping and provenance. | Preserve meter/window identity, label, used percentage, reset/window duration, observed and received timestamps. Use actual provider identity; do not claim a historical sample came from the new companion. Do not infer tokens from quota. |
| Detailed monthly report envelopes and artifacts | Keep complete immutable `report_revisions` and private original artifacts. | Preserve machine/month identity, partial/complete status, pricing assumptions, coverage, source timestamps, and corrections. No lossy conversion to hourly totals. |
| Pending v1 outbox | Inventory payloads and receipts; transform recoverable unsent facts through a controlled migration. | Do not retry retired keys, stamp old facts with the migration time, or drop unknown pending outcomes. Reconcile idempotency before retries. |
| Claude analyzer ledger | Retain source ledger and its report-generation dependency. | The companion does not currently replace the harvester; its monthly invocation uses `--no-harvest`. Removing harvest without replacement can lose future historical coverage. |
| Calibration/reset evidence | Preserve calibration rows, public feed revisions and source references separately. | Experimental calibration is not a token source; public reset feeds are not v1 local telemetry. |

There is still **no bulk v1-to-v2 copy, by decision** (USG-011). The v1 ledgers are read canonically in place: `token_bucket_canonical` selects one row per account/session/hour/model whichever source published it, and `allowance_percent_view` unions both allowance ledgers. `lib/usage-reconciliation.ts` produces the before/after matrix and `scripts/reconcile-usage-history.mjs outbox <source-id> <state.sqlite3>` dry-runs a retired collector's pending envelopes under that explicit source mapping, classifying each bucket as duplicate, superseded, advancing, or new key and each quota as a duplicate of the v1 ledger, a duplicate of a v2 reading, or new; `--apply` appends only new keys and advancing revisions, in one transaction, with the envelope's own observation time, never copies a quota the companion already holds, and never advances collector contact. The companion reparses available logs; it does not import historical v1 SQLite state. An import into `allowance_readings` would need a `binding_id` and must not fabricate a live installation or use re-enrollment to disguise legacy origin; none is planned while the canonical read suffices. On September 14 both Windows outboxes (34 cumulative envelopes each) held nothing production lacked; see the [evidence](usage-evidence/usg-011-2026-09-14.md).

Since `20260914030000_reconcile_historical_ledgers.sql`, `allowance_percent_view` keeps history from disabled sources, bindings, and installs and flags it `history_only`; the readers use those rows for cycle history and never as a current allowance, and a v1 sample that a v2 reading duplicates exactly appears once, as the v2 reading. Disabling a producer is therefore a safe way to stop uploads without hiding observations once that migration and the matching server build are deployed. Preserve RLS, security-invoker views, restricted grants, and append-only ledgers.

Acceptance for data migration:

1. Restore the private backup into an isolated database successfully.
2. Compare canonical totals by account/session/hour/model and report machine/month, not sums of raw revisions. Investigate the audit's 704 Codex and 80 Claude v1-only hourly keys.
3. Compare quota counts, meter mapping, observed/reset ranges, and visibility before/after source disablement. Verify duplicate selection for migrated observations.
4. Re-run the import; no new logical facts or double counting. Roll back the test transaction/restore and verify original data is intact.
5. Verify report detail and history through authenticated monthly/live endpoints. Test scope, auth, and invalid/duplicate ingestion with synthetic fixtures.
6. Keep original data until the accepted migration and a tested recovery path exist. “Companion outbox empty” by itself is not migration parity.

## Inventory every scheduler

Use exact task identity and command/prompt contents to classify jobs. A name containing “usage,” “Claude,” or “Codex” alone is not a deletion criterion. In particular, Windows has unrelated operating-system usage tasks.

| Scheduler surface | Inspect | Remove only these responsibilities |
| --- | --- | --- |
| Windows Task Scheduler | Task name/path, executable, arguments, repetition, last result. | Old collector wrappers and superseded usage analyzer/harvest jobs. Keep `Personal Observatory Companion ...`. |
| macOS launchd | User LaunchAgents and any explicitly installed system jobs; inspect Label and ProgramArguments. | `com.personal-observatory.usage.*` and separately verified obsolete monthly/harvest labels. Keep `com.personal-observatory.companion.*`. |
| Linux / WSL | `crontab -l`, user systemd timers/services and inspected unit files; repeat in each used distribution. | Verified old usage commands only. |
| Codex automations | Every relevant host's `$CODEX_HOME/automations/*/automation.toml` (default `~/.codex`) plus the app's automation UI. | Old collector/report jobs and usage-specific heartbeat monitors. |
| Claude Code Desktop | Code → Routines → Local, on every used machine/profile. | Verified usage collection/report/harvest tasks. |
| Claude Code remote routines | Routines → Remote / `claude.ai/code/routines`, in each relevant account. | Usage-specific scheduled, API, or GitHub-triggered routines. |
| Claude Code session tasks | `CronList` in relevant active/resumed CLI sessions. | Usage `/loop` or directly scheduled jobs; cancel exact IDs with `CronDelete`. |
| Claude Cowork | Scheduled in every relevant account. | Usage-specific recurring tasks. |
| Hosting and CI | Checked-in `vercel.json`, deployed cron settings, GitHub workflow `schedule` entries. | Old-site usage compatibility sync and explicitly identified legacy usage workflows. Keep current reset/release checks and build CI. |

Deleting local script files does not remove AI schedules. Deleting a Codex task or archiving a conversation is not proof that its automation is gone. Claude cloud schedules are not discoverable by listing Windows files.

## Windows: uninstall the old local tasks

Run in ordinary PowerShell. This example inventories only the old collector task-name format in the root scheduler folder:

```powershell
$legacyTasks = Get-ScheduledTask -TaskPath '\' | Where-Object {
    $_.TaskName -match '^Personal Observatory Usage [0-9a-f-]{36}$'
}
$legacyTasks | Select-Object TaskName, TaskPath, State,
    @{Name='Execute';Expression={$_.Actions.Execute}},
    @{Name='Arguments';Expression={$_.Actions.Arguments}}
```

On the audited Windows host there are exactly two matches, invoking `Documents\PersonalObservatory\collector\scheduled_run.py` with separate Claude and Codex configs. Before proceeding, verify those exact actions and archive their definitions. This next block **uninstalls those matched tasks**; run it only after reviewing the inventory:

```powershell
$archiveRoot = Join-Path $env:USERPROFILE 'Observatory-retirement-backup'
New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
foreach ($task in $legacyTasks) {
    $archiveFile = Join-Path $archiveRoot ($task.TaskName + '.xml')
    Export-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath |
        Set-Content -LiteralPath $archiveFile -Encoding utf8
    Disable-ScheduledTask -InputObject $task | Out-Null
    Stop-ScheduledTask -InputObject $task
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
}
Get-ScheduledTask -TaskPath '\' | Where-Object {
    $_.TaskName -match '^Personal Observatory Usage [0-9a-f-]{36}$'
}
```

Verify no old collector process remains. Back up and reconcile the old state after stopping writers. Inspect the old tree before deleting any child: this host's `Documents\PersonalObservatory` also contains `claude-quota`, an active unpacked browser extension. The CLI's Windows default `%LOCALAPPDATA%\PersonalObservatory` can also be a **v2** config directory on another machine. Never recursively delete either parent by name alone.

Remove only explicitly reviewed old files/directories with PowerShell `Remove-Item -LiteralPath`; first resolve each absolute target and verify it lies beneath the inspected old runtime root, is not a junction/reparse point, and is not referenced by companion/analyzer/browser configuration. Start with `-WhatIf`. Preserve the archive and the active `%USERPROFILE%\.config\personal-hub\companion` tree. Do not pipe discovered paths to another shell for removal.

Verify the retained service separately:

```powershell
$companionExe = Join-Path $env:LOCALAPPDATA 'Programs\observatory\observatory.exe'
$companionDir = Join-Path $env:USERPROFILE '.config\personal-hub\companion'
& $companionExe --config-dir $companionDir status
& $companionExe --config-dir $companionDir doctor
```

## macOS: uninstall the old local LaunchAgents

Inspect filenames and `plutil -p` output first. Substitute each exact verified label; monthly analyzer/harvest labels may differ and must be discovered on that Mac.

```bash
find "$HOME/Library/LaunchAgents" -maxdepth 1 -name 'com.personal-observatory.usage.*.plist' -print
plutil -p "$HOME/Library/LaunchAgents/<verified-label>.plist"
```

Archive the verified plist, unload its service, and remove that exact definition:

```bash
mkdir -p "$HOME/Observatory-retirement-backup"
cp -p "$HOME/Library/LaunchAgents/<verified-label>.plist" "$HOME/Observatory-retirement-backup/"
launchctl bootout "gui/$(id -u)/<verified-label>"
rm "$HOME/Library/LaunchAgents/<verified-label>.plist"
launchctl print "gui/$(id -u)/<verified-label>"
```

The final command should report no service. If `bootout` fails, check whether it is already unloaded rather than assuming success. Inspect for old running processes. Preserve/migrate the state and adapter dependencies under `~/.config/personal-hub/telemetry` before removing reviewed files. Never delete `~/.claude/token-observatory/state/ledger` as script cleanup.

For Linux/WSL, inspect `crontab -l` and `systemctl --user list-timers --all`, export the relevant definitions, then edit only the old usage crontab entries or disable/remove the exact verified timer/service. Recheck the schedule inventory afterward.

## Remove AI usage schedules completely

### Codex

The audited Windows automation is **Monthly AI Usage**, local id `a`; its prompt runs the monthly analyzer and uploads a schema-v2 report to Token Observatory. On the Mac, the historical registry names `monthly-ai-usage`; its present state must be checked there. The unrelated **Watch routing intelligence** heartbeat is outside usage retirement.

1. Inspect the automation's full prompt, host, cadence and any linked usage-specific monitors. Preserve its existing reports and the exact pending publication artifacts.
2. Establish the replacement's successful detailed current-month upload and completed-month behavior. The present Windows `HTTPError` means that replacement check has not passed.
3. Use the app's automation management UI or the supported `automation_update` delete operation for the **resolved exact id**. If a tool only pauses, finish deletion in the UI. Verify it is absent in the app and host automation inventory. Do not assume removing `automation.toml` alone updates the scheduler.
4. Remove usage-specific follow-up/heartbeat automations separately; check other hosts. Do not remove general monthly-analysis skill files while the companion still invokes their analyzer.

The app's automation tool is the authority for Codex task management in this environment. [Official scheduled-task documentation](https://learn.chatgpt.com/docs/automations?surface=app) is broader product context; UI labels can differ between task types.

### Claude Code Desktop, remote routines, CLI, and Cowork

- **Code Desktop local:** open Code → Routines, inspect the usage task, and use its detail-page **Delete** control. After separately preserving needed artifacts, select **Also delete files on disk** to remove its task definition/associated directory too. Deleting only `~/.claude/scheduled-tasks/<name>/SKILL.md` does not remove scheduler metadata. [Desktop instructions](https://code.claude.com/docs/en/desktop-scheduled-tasks).
- **Remote routines:** inspect `claude.ai/code/routines` or Routines → Remote in each account. Remove the exact usage routine and verify its scheduled/API/GitHub triggers no longer exist. Local file deletion cannot cancel it; past sessions may remain as history. [Routine instructions](https://code.claude.com/docs/en/routines).
- **CLI `/loop` and scheduled prompts:** list with `CronList`, cancel each usage job by exact ID with `CronDelete`, then list again. Do not rely on closing a session or pressing Escape as complete removal. [CLI instructions](https://code.claude.com/docs/en/scheduled-tasks).
- **Cowork:** open Scheduled, inspect the exact usage task, and delete it; check other accounts/profiles. [Cowork instructions](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork).

Keep daily work briefing, personal assistant, standup, tech readings, and audit jobs; they are separate report areas. A Claude nightly **usage ledger harvest** is in scope, but its preservation function needs a replacement before deletion. Archive historical artifacts separately rather than erasing them with task-associated data.

## Browser, hosting, code, and final acceptance

1. Preserve all v1 browser quota samples and establish their migration/visibility rules. Implement and verify the replacement, or explicitly end that coverage; the current “Add browser” code alone is not a replacement.
2. Disable each old browser source in the site. Remove the exact unpacked **Claude quota** extension from every Chrome/Edge profile and machine, using that browser's extension-management page. Do not remove a general Claude browser integration by name confusion. Verify there are no new source receipts; preserve any required options/data before extension removal, then delete its reviewed unpacked directory.
3. Once direct monthly report parity is established for every desired machine/month, remove the legacy-sync cron/route/module, deploy the change, confirm the deployed cron is absent, and remove only its dedicated legacy credentials/config. Keep `CRON_SECRET` for reset-feed and release checks and current report publisher credentials.
4. Relocate the active detailed adapter out of `scripts/telemetry`, update `DetailedReportConfig.script` on installed companions and all source/test/doc references, and verify retries and month finalization. Then delete the old collector/installer/hook reference code and adapt `companion/scripts/fixtures.py` and collector tests to an immutable, provenance-documented parity corpus. Keep the expected data and Rust parity checks.
5. Remove legacy browser code/UI/tests and compatibility-view fallback after their dependencies have migrated. Remove obsolete cloud-estimation code if it is deliberately retired, while retaining calibration evidence; it is a separate feature decision, not required to preserve observed usage.
6. Search repository, installed runtime trees, scheduler definitions, and AI prompts for old commands/endpoints. Classify remaining matches: historical data provenance, migration history and canonical fixtures are valid; active installers, schedules, credentials, misleading setup guidance and unused runtime code are not.
7. Run the affected ingestion/store, parity, detailed-report, auth and history tests; build/typecheck UI changes and verify private pages against the migrated data. Record production deployment and at least one scheduled receipt per retained collector plus detailed publication receipts where configured.

Retirement is complete only when no old producers/schedulers can run, no v1-only runtime code is needed, original data remains recoverable, accepted history remains visible without double counting, and documentation has one current collection path. Until then, list the remaining dependency explicitly rather than declaring v1 deleted.
