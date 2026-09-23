# Personal report schedules

## Current usage status — September 13 recovery update

The canonical usage process inventory is [Usage: how the system actually works](usage-system.md#verified-operational-state). [V1 retirement](usage-v1-retirement.md) owns removal instructions for OS tasks, Codex automations, all Claude schedule surfaces, browser collectors, and hosting crons. This page retains the historical registry for the other report areas.

- Windows v2 runs hourly at minute 10. The first natural occurrence after publication recovery ran at 6:10 PM Central and exited `0` with no missed runs. Its production response accepted ten buckets and two usage records with no duplicates or rejections, and the changed detailed September report uploaded with a receipt. The local telemetry outbox was empty and no detailed artifact remained pending. Two old v1 tasks remain enabled and failed again at 6:07 PM. They have **not** been uninstalled.
- Both Mac and Windows companion receipts exist in production; the Mac OS scheduler was not inspected in this audit.
- Windows “Monthly AI Usage” remains an active separate Codex automation. The companion's detailed publication credential was recovered through an isolated release: the exact pending September artifact received a production receipt, later snapshots published, and the latest Windows September report is selected. Telemetry and monthly-report receipts remain independent. See [USG-002 recovery evidence](usage-evidence/usg-002-2026-09-13.md).
- Work and Personal Claude browser sources are enabled v1 producers. V2 browser settings/pairing do not control or replace them.
- Checked-in Vercel cron entries: reset feeds 13:15 UTC, companion release lookup 13:45 UTC, old-site usage sync 18:00 UTC. The v2 companion has no hourly feed-refresh path. Deployment/last cron executions were not checked here.

## Current daily reports — September 23 update

| Report | Scheduler | Schedule | Publishing |
| --- | --- | --- | --- |
| Daily personal assistant, with the standup | Codex `daily-personal-assistant` | Daily, 9:00 AM; standup on weekdays | Publishes the merged briefing and, on weekdays, the exact final standup text. `/tasks` shows each day's standup above its briefing; `/standup` redirects there |
| Daily tech intel snapshot | Claude Desktop scheduled task `daily-tech-intel-snapshot`; needs Mac and the Claude app | Daily, 9:00 AM (the app runs it at 9:08 AM) | Publishes readings directly with the `claude-readings` producer; no Slack delivery |

- The separate Codex `daily-standup-update` job is retired; the standup is produced inside the daily personal assistant.
- The Claude cloud routine for the tech intel snapshot is disabled, not deleted. Its prompt still posts to Slack, so do not re-enable it alongside the Mac task.
- The Codex readings publication relay is retired: paused, then archived outside Codex under this Mac's `.local/backups/codex-automations/`.
- The Mac task keeps each edition under `.local/readings/` and its last successful run in `.local/readings/state.json`, which sets the next coverage window. A failed publish keeps the publisher's outbox copy for retry. If the app is closed at the scheduled time, the task runs on next launch.

## Historical registry — September 8–13

The remainder is dated operational evidence, not current installation guidance or permission to recreate old jobs. Where it conflicts with the current usage audit or the September 23 daily-report update, those take precedence. Human-facing times use America/Chicago. Supabase is the shared published report store; each producer retains its existing scheduler and local artifacts.

| Report / step | Scheduler | Schedule | Publishing |
| --- | --- | --- | --- |
| Codex monthly AI usage | Codex `monthly-ai-usage` | 1st, 9:00 AM | This Mac uploads directly; original report schema unchanged |
| Claude monthly usage | macOS LaunchAgent | Installed schedule: 2nd–5th, 9:15 AM | Direct upload with its own usage credential |
| Claude usage ledger harvest | macOS LaunchAgent | Daily, 9:05 PM | Local prerequisite; no report upload |
| Claude work briefing contribution | Claude Desktop task | Daily, 8:45 AM; needs Mac | Feeds the existing local briefing merge |
| Daily personal assistant | Codex `daily-personal-assistant` | Daily, 9:00 AM | Publishes merged JSON and complete HTML after validation |
| Daily standup | Codex `daily-standup-update` | Weekdays, 9:00 AM | Publishes the exact final standup text |
| Daily tech intel snapshot | Claude cloud task | Daily, 10:00 AM | Existing generation and Slack DM delivery retained |
| Readings publication relay | Codex standalone local job | Daily, 12:15, 3:15, 6:15 PM; needs Mac | Copies the completed Claude edition, with source IDs and actual timestamp; later checks catch delayed editions |
| Weekly Luumen AI audit | Codex `weekly-luumen-ai-audit` | Tuesday, 9:00 AM | Publishes one complete report and linked private evidence files |
| Other-computer usage compatibility sync | Vercel Cron | Daily, 18:00 UTC (1 PM CDT / noon CST) | Reads the old Token Observatory; appends only changed reports |

The Monday `luumen-audit` remains the separate suite-wide assurance workflow. The Tuesday AI audit keeps its lightweight comparison with Monday's completed AI findings; it does not run the Monday workflow again. Its existing recurrence, model settings, and task destination were preserved.

The paused local predecessor of the Claude tech snapshot stays paused. The active cloud task is `[private task ID omitted]`; the briefing contributor is `[private task ID omitted]`. No Slack message was sent while setting up this site.

## Publisher configuration

- Private site: https://personal-observatory-jg.vercel.app
- Shared client: `scripts/publish.mjs`
- Protected local credentials: `~/.config/personal-hub/publish.json`
- Codex usage config: `~/.codex/token-usage-upload.json`
- Claude usage config: `~/.config/personal-hub/claude-usage-upload.json`, referenced by its existing exporter config
- Audit downloads: `scripts/publish-assets.mjs`

The publisher enforces report kind, actual observation timestamp, byte limits, and idempotency. It keeps failed reports in a protected local outbox and stores successful receipts. Retry publication independently of source gathering. Audit evidence uploads are restricted to explicit linked files inside the approved report root.

The installed Claude monthly plist still uses 2nd–5th catch-up days. It has not been silently replaced with a schedule prepared in another task. The nightly harvest also remains unchanged.

## Migration and verification

Initial history includes five machine/month usage records, the September 7 evening daily briefing, the September 7 standup, the complete six-message September 7 Claude readings edition, and the consolidated AI audit with 35 supporting files. The daily briefing and audit retain partial coverage. The September 8 briefing was not imported because its source fragment declared a future timestamp when inspected; original source files remain intact.

The audit's default view was corrected on September 8 to the full August 28 scored capability report requested by Josh, including its supplementary September 7 reconciliation tabs and 35 linked evidence files. Its original August 28 assessment timestamp and candidate SHA remain visible. The condensed September 7 report remains in history. The Tuesday publisher now explicitly checks the full reference report's depth and responsive navigation before marking a report as the next full assessment.

Production checks verified: private page redirects; unauthenticated API/artifact denial; wrong-password rejection; secure HttpOnly cookie; correct sign-in and sign-out; all report sections; five monthly records; authenticated evidence download; producer scope; duplicate upload receipts. Supabase security advisors returned no findings. The compatibility sync read all five old reports and skipped all five as already imported.

Configured publishing is not a claim that the next scheduled occurrence has already run. The September 8 readings relay completed at 12:17 PM and correctly found only the already-published September 7 edition. Later afternoon publication checks were added to catch delayed editions, with one missing-edition notice per day and deduplication of repeated checks. Mac-based jobs depend on the Mac and their original apps being available.

The September 8 daily briefing occurrence began at 9:08 AM, then answered a side question and ended without producing or publishing a fresh briefing. Recovery resumed the same task and published the validated report at 3:18 PM, receipt `[private source/receipt ID omitted]`, preserving the 3:08 PM observation timestamp and partial coverage. Its schedule now explicitly preserves the pending report objective through side questions and requires validated dated artifacts plus a publication receipt before recording a successful occurrence.

On September 8, Claude's 10:17 AM readings occurrence was waiting for permission to fetch its public news sources; the missing edition was upstream of publication. Its separate 8:45 AM work-source task was visibly paused. Resuming that paused task awaits Josh's clarification; it is not assumed active from an older handoff. The paused local readings predecessor remains paused.

## Usage telemetry added September 9

The separate `codex-primary` and `claude-primary` collectors are installed as macOS LaunchAgents, each every 3,600 seconds and at load. Their source IDs are `[private source/receipt ID omitted]` and `[private source/receipt ID omitted]`; labels are `com.personal-observatory.usage.<source-id>`. Both first scheduled runs exited 0 and received production receipts on September 9. Configuration, SQLite checkpoints, receipts, and logs are under `~/.config/personal-hub/telemetry/`. The interpreter is `/opt/homebrew/bin/python3`. Existing monthly and daily report jobs remain separate.

Backfill starts September 1. Initial indexing took about four seconds for Codex and one second for Claude. Verified incremental scheduled runs scanned in 0.58s / 0.47s, uploaded 1.9KB / 1.1KB, and completed including the network in 1.79s / 0.99s. These are observations from this Mac, not guarantees. Canonical database totals and call counts matched both local ledgers; a duplicate upload inserted no extra buckets. Collection makes no AI calls.

The Codex collector triggers public feed checks hourly. Vercel also checks `/api/internal/sync-reset-feeds` daily at 13:15 UTC (8:15 AM CDT / 7:15 AM CST), independently of the daily legacy sync. All four public sources were successfully fetched; reads use a shared 30-minute refresh lease. Source health appears in Reset intelligence. Runtime checks covered authentication, account/provider scope, browser quota-only restrictions, same-origin mutations, canonical counts, duplicate receipts, and protected collector downloads.

The primary Claude Code statusline hook was installed without replacing an existing custom statusline; original settings are backed up privately. It waits for the next eligible Code response to provide actual allowance readings. No AI request was started to populate it.

On September 9 at 3:07 PM CDT, Windows local connections for `codex-primary` and `claude-personal` checked in. Codex supplied 97 bucket revisions; the Claude connection supplied no token records. This proves upload connectivity, not installation or execution of the hourly Windows task. The Mac statusline configuration and its matching quota inbox were rechecked; the inbox still had no allowance samples. The old personal browser connection was observed disabled, so future browser readings require a new paired browser connection. Cloud estimates are deployed but await Claude allowance readings and a user-confirmed local-only baseline.

`claude-personal` is a separate browser-only connection, source `[private source/receipt ID omitted]`. Its extension and private connection file are ready, but installation and explicit account/organization pairing are pending. No secondary-account quota or token data has been claimed. Chrome/Edge on either Mac or Windows can host it; moving the account to Windows is unnecessary.

## Full hourly monthly detail enabled September 10

The existing Mac `codex-primary` and `claude-primary` LaunchAgents now opt into full current-month analyzer publication as well as their hourly buckets. Their original 3,600-second schedules and monthly/daily jobs were preserved. Both first manual collector runs succeeded against the production report endpoint: Codex receipt `[private source/receipt ID omitted]` in 19.1 seconds overall, Claude Code receipt `[private source/receipt ID omitted]` in 6.0 seconds. Authenticated retrieval confirmed September envelopes for `mac-workstation` and `mac-workstation-claude-code`, full detailed fields and partial-month collection metadata.

Settings and exact previous config backups are private under `~/.config/personal-hub/telemetry/`; each source has a `.detailed` state/outbox directory. Only changed analysis is published. These runs prove publication works, not that a later hourly occurrence has already run. Windows detailed refresh has not been enabled or verified. Browser-only Claude activity still supplies quota readings only. The restored dashboard and explicit API partial-status handling were deployed September 10 in `[historical deployment ID omitted]` (release commit `80b2ab8`). The usual Observatory alias resolves to that production deployment. Verification covered authenticated current-month full reports, private-route access control, the `/usage/reports` redirect, calendar day selection, Spark hidden by default and its toggle, responsive allowance charts, and exact collector download contents. All 39 release JavaScript tests and 12 collector tests passed; Vercel build/typechecking passed. The deployment-scoped error query returned no entries during verification.

## Rollback and retirement

Exact prior producer settings and automation files are retained under the app's protected `.local/backups/` directory. Preserve pending outbox reports. Do not restore an old endpoint without confirming publication failure. The temporary Vercel sync holds the old dashboard credentials with explicit user approval; remove that cron and those credentials after every other computer has switched to direct uploads. Do not retire the original site before that cutover.

On September 13, the remaining v1 `local` telemetry sources and the unused browser source were disabled in production; both companion installs and all six v2 bindings remained enabled. Production probes with the retired Windows Codex and Claude keys return `410 Gone`. The Work browser and Personal browser quota sources were resumed as a temporary bridge and can be paused or resumed from Connections; they upload allowance readings only. The website no longer offers v1 creation/download UI. Remaining machine cleanup is limited to the old local collectors: remove the two `Personal Observatory Usage ...` Windows tasks, the matching macOS `com.personal-observatory.usage.*` LaunchAgents, and then the old collector/config/state directories. Preserve the two active unpacked browser extensions until the v2 replacement is live.
