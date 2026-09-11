# Start or recover Personal Observatory

Updated 2026-09-10 for the move into `joshgreenwell/ai-kits`, at repository-root `kit-board/`. Commands below run from that directory unless stated otherwise. The npm package, database schema/role, cookie names, config directories and deployed URLs still use their existing names. No kit framework or AI execution harness was introduced.

## What this checkout provides

The application, lockfile, six ordered database migrations, local hourly collectors, Claude browser extension, report publisher, audit asset publisher, readings renderer, generated download bundles, fonts/notices, and tests are included. It receives externally produced reports and can run bounded deterministic feed/ingestion calculations. It does not run agents, scan email, modify Jira, or read an Obsidian vault itself.

A fresh clone has **no private report history, configured accounts, password, publisher credentials, provider logs, or external analyzers**. The app can build without them; a working authenticated dashboard needs a configured database and login. Existing history requires restoring the existing database through its operator, not replaying empty migrations over production.

## Application setup

Prerequisites: Node **22.x**, npm, Python **3.10+** for collectors/tests (standard library only). Native PostgreSQL tools are optional for the disposable database test. From a fresh checkout:

```bash
cd ai-kits/kit-board
npm ci
cp .env.example .env.local
npm test
npm run test:collector
npm run typecheck
npm run build
npm run dev
```

Fill the ignored `.env.local` before attempting sign-in or data access. Development serves `http://localhost:3100`; `npm start` serves the production build on port 3100. Production cookies require HTTPS. The placeholders in `.env.example` are not valid credentials. Keep generated report content out of `public/`.

| Variable | Required for | Configuration |
| --- | --- | --- |
| `DATABASE_URL` | Login rate limiting and persisted reports | Restricted `personal_hub_app` connection, never an administrator URL |
| `DATABASE_CA_CERT` | Database TLS verification | Correct database CA PEM; escaped `\n` is supported. TLS verification stays enabled |
| `SITE_URL` | Same-origin checks and collector download origin | Exact origin, e.g. `http://localhost:3100` for development or HTTPS hosting origin |
| `SITE_PASSWORD_HASH` | UI login | `scrypt:<32 hex salt>:<128 hex derived hash>` as produced by `hashPassword` in `lib/crypto.ts` |
| `SESSION_SECRET` | Signed sessions | Independent cryptographically random secret |
| `INGEST_KEYS_JSON` | Existing report publishers | Object mapping producer names to `{ "hash": "sha256 of key", "kinds": ["usage"] }`; other kinds are `tasks`, `standup`, `readings`, `audit` |
| `CRON_SECRET` | Optional deterministic cron endpoints | Separate random bearer secret |
| `LEGACY_USAGE_CONFIG_JSON` | Optional old-site compatibility sync | `endpoint`, `api_key`, `sites_bypass_token`; endpoint is deliberately pinned in `lib/legacy-usage.ts` |

Create login and publisher secrets in a protected local setup session, then store values through the local/hosting secret manager. The implementation in `lib/crypto.ts` is authoritative; the site password is scrypt, producer hashes are SHA-256. A telemetry connection key is created through the authenticated Connections UI and is not interchangeable with a report publisher key. Do not place secrets in shell history or `NEXT_PUBLIC_*` variables.

## Database bootstrap and recovery

The app uses postgres.js directly, not a public Supabase Data API. Use an isolated Supabase/Postgres database for development. Its administrator applies **all** SQL files in `supabase/migrations/` in lexicographic filename order, beginning with `20260908050538_personal_hub_report_history.sql` and ending with `20260910193058_agent_routing_events.sql`. Each is a migration, not an idempotent initialization script: track applied filenames and do not rerun them against an existing database. Supabase provides `anon` and `authenticated`; vanilla Postgres needs those roles before these migrations. Keep `personal_hub` unexposed, RLS enabled and public grants revoked.

The second migration creates `personal_hub_app` without a password. Set a strong password using the administrator's protected channel (for example an interactive psql `\password personal_hub_app` session), then configure the application with only that restricted identity and the correct verified TLS connection. Retain the connection queue and disabled prepared statements in `lib/db.ts`.

To verify all migrations and routing behavior safely, install `initdb`, `pg_ctl`, `psql`, and `createdb` on PATH and run:

```bash
npm run test:routing:db
```

This helper creates its own temporary Unix-socket-only cluster, applies every migration, runs integration tests, and removes its cluster. It accepts no production URL. It does not provision the application's TLS database. Normal `npm test` deliberately skips the database integration test unless its dedicated test environment exists.

For recovery of an existing installation, preserve the private database backup/history, credential configuration, local collector SQLite checkpoints, pending uploads and successful receipts. Reuse existing account/source/machine identities. A fresh connection and empty checkpoint is a new installation, not evidence of restored coverage. Production's applied migration status must be checked independently; the imported routing migration was part of local working-tree changes.

## Operator location map

These are locations verified on the migration Mac, not portable defaults. Replace the home/workspace prefixes on another machine. **Neither brain repository nor vault content is bundled.** The app needs published artifacts, not access to the whole vault.

| Resource | Existing location / role |
| --- | --- |
| New application | `/Users/joshgreenwell/github/ai-kits/kit-board` |
| Previous application location | `/Users/joshgreenwell/github/luumen-workspace/personal-hub`; compatibility may be retained there for old job commands |
| Registered, open Obsidian vault | `/Users/joshgreenwell/Obsidian/Work`, verified from Obsidian's local `obsidian.json` path metadata |
| Personal assistant working repository | `/Users/joshgreenwell/github/personal-assistant-brain`; its README says it can itself be opened as an Obsidian vault. This is distinct from the registered Work vault |
| Assistant merge contract | `personal-assistant-brain/reference/briefing-data-contract.md` under that repository |
| Luumen agent brain | `/Users/joshgreenwell/github/luumen-brain`; separate private context, not an Observatory runtime dependency |
| Generic publisher configuration | `~/.config/personal-hub/publish.json`; override with `--config` or `PERSONAL_HUB_CONFIG` |
| Telemetry connections and state | `~/.config/personal-hub/telemetry/`; pass the chosen private connection file to `--config` |
| Codex report publisher | `~/.codex/token-usage-upload.json` |
| Claude report publisher | `~/.config/personal-hub/claude-usage-upload.json` |
| Private app runtime/archive | `.env.local`, `.local/` under the application; ignored, independently backed up |

Obsidian's local registration file is `~/Library/Application Support/obsidian/obsidian.json`. Recheck its path metadata on another computer; do not assume that opening the assistant repository moves the Work vault. Existing report generators own their selected vault sources. Their private configuration and reports remain outside this repository.

## Usage: hourly counters and allowance

The complete instructions are in [usage collection](usage-collection.md). Included scripts are `scripts/telemetry/collect.py`, `detailed_report.py`, `statusline.py`, and `install_schedule.py`. Download bundles contain the same scripts and the setup guide. Python is the only collector dependency.

```bash
python3 scripts/telemetry/collect.py --config /private/path/connection.json --dry-run
# With a configured destination, publish the measured counters:
python3 scripts/telemetry/collect.py --config /private/path/connection.json
# Install an hourly task only when ready to enable this connection:
python3 scripts/telemetry/install_schedule.py --config /private/path/connection.json
```

A dry run still reads logs and may build local checkpoints; it does not prove remote acceptance. Default sources: `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.claude/projects`. Use `roots` for other account-owned paths before the initial scan. Never assign identical logs to two accounts. Keep old state when relocating scripts; reinstall each task with the same connection only after verifying the old schedule so it cannot run twice. The current Mac hourly tasks use `com.personal-observatory.usage.<source-id>`; Windows uses Task Scheduler. Existing monthly finalizers and daily harvest jobs remain independent.

Claude allowance statusline: preserve the user's existing wrapper and call `statusline.py --inbox /private/path/claude-quota`; configure the matching `quota_inbox`. Browser-only quota: load `browser/claude-quota/` unpacked in Chrome/Edge, import the browser connection, explicitly pair the intended account/organization, and retain a signed-in Claude tab. Local and browser connection files are different. Browser activity is not exact token history.

## Usage: external detailed analyzers and monthly jobs

These are existing locally installed scripts, **not npm dependencies and not included in the collector ZIP**. Their paths and launchers were verified on the migration Mac. No public install source or redistribution license was established in this move. These existing tool directories can be preserved in a private recovery backup and restored on a fresh machine. Merely cloning `ai-kits` cannot reproduce detailed monthly attribution without them. Basic hourly telemetry works independently.

| Dependency | Verified local code / configuration |
| --- | --- |
| Codex detailed analyzer | `~/.codex/skills/analyze-monthly-token-usage/scripts/analyze_token_usage.py`; adjacent `run_analyzer.sh` and `run_analyzer.ps1` are required supported launchers |
| Claude detailed analyzer | `~/.claude/token-observatory/claude_token_observatory.py`; local `run.sh`, `install.sh`, `config.example.json`, tests and README accompany it |
| Claude private configuration | `~/.claude/token-observatory/config.json`; keep private, restore separately |
| Claude retained history | `~/.claude/token-observatory/state/ledger/`; essential if original transcripts aged out; also retain its reports and upload state |

For Codex set `detailed_report.analyzer_path`, `codex_home`, `upload_config_path`, and the **existing** `machine_id` in the private collector connection. For Claude use `analyzer_path`, `analyzer_config_path`, `upload_config_path`, and existing Claude Code machine identity. Exact objects are in [usage collection](usage-collection.md). Report upload config uses `endpoint` (same site's `/api/reports`), `api_key`, `machine_id`, `machine_name`; the detailed adapter requires a different key from the telemetry key.

Local analyzer invocations used by the adapter (replace month and private paths):

```bash
bash "$HOME/.codex/skills/analyze-monthly-token-usage/scripts/run_analyzer.sh" --month 2026-09 --top 10 --format json --codex-home "$HOME/.codex"
python3 "$HOME/.claude/token-observatory/claude_token_observatory.py" --month 2026-09 --config "$HOME/.claude/token-observatory/config.json" --source claude-code --dry-run --no-harvest --json-out /private/path/month.json
```

These can produce private report details; redirect/store results privately. The Claude invocation explicitly selects local Claude Code, avoiding its optional Admin API source. Do not infer provider-wide coverage from either analyzer. The hourly adapter supplies `TOKEN_REPORT_PYTHON` to the Codex launcher and writes immutable report revisions separately from hourly token buckets.

Existing monthly/daily responsibilities:

- Codex `monthly-ai-usage`: first day, 09:00 local, analyzer plus independent usage upload configuration.
- Claude `~/.claude/token-observatory/run.sh --harvest`: daily 21:05 local; retains counters before transcript cleanup.
- Claude monthly `run.sh`: 2nd–5th at 09:15 local with its private exporter config. Its `codex_upload_config` key points to the chosen usage upload config; retain the existing override for the Observatory.
- Claude schedule labels: `com.apiphani.claude-token-observatory` and `com.apiphani.claude-token-observatory-harvest`; local `install.sh` owns installation. Review it and the restored config before installing, to avoid duplicate schedules or its older endpoint defaults.

These schedules are documented from prior maintained operating notes and installed script documentation, not newly enabled by this migration. [Schedules](schedules.md) also records task, standup, readings relay and audit responsibilities. Restore those external jobs with their original source permissions and publication contracts; this source move does not recreate cloud/Codex tasks.

### Back up and restore the analyzer dependency

Preserve both complete tool directories in a **private backup** before retiring this Mac. For a local ignored recovery copy, use `.local/recovery/external-tools/analyze-monthly-token-usage/` and `.local/recovery/external-tools/claude-token-observatory/`. The Claude directory can contain credentials and private retained counters, so do not stage, upload as an artifact, or add exceptions to `.local/` ignores. The operator’s migration recovery copy uses these locations, with SHA-256 records and a restore map in `.local/recovery/manifest.json`. Verify the manifest after restoring. A fresh public clone does not contain this private recovery copy.

Restore the Codex directory to `~/.codex/skills/analyze-monthly-token-usage/` and Claude to `~/.claude/token-observatory/` (or configure alternate absolute paths). Preserve file permissions and adjacent launchers. Restore the private publisher/config/state files independently, review the paths and destination origin, and only then re-enable schedules. Compare the restored files with the backup manifest; run analyzer unit tests and `--help` first, then the documented local-only analyzer invocation against a chosen month. Never replace an existing tool directory without preserving its newer changes. A local `.local` copy is not an off-machine disaster-recovery backup.

## Publish external workflow results

`scripts/publish.mjs` accepts `--kind --producer --file`, optionally `--html`, with real `--period` and `--produced-at` for non-usage reports. Always pass `--subject` for the intended report owner (the legacy default is personal). Use `--dry-run` to check input sizing/envelope construction without reading publisher credentials or uploading; this is not full server validation. The private config shape is:

```json
{"url":"https://your-observatory.example","producers":{"audit-local":{"key":"REPLACE_PRIVATELY","kinds":["audit"]}}}
```

`scripts/publish-assets.mjs --report-id <accepted-id> --html /private/report.html --allowed-root /private/report-root --producer audit-local --dry-run` inventories only explicitly linked evidence inside the approved root. Remove `--dry-run` only to publish to the configured destination. Preserve the original report and timestamps for retries; do not rerun source gathering to recover a failed upload. `scripts/render-readings.mjs` preserves the separate readings presentation flow. Pending outbox files and receipts live alongside publisher configuration.

## Hosting after relocation

For a deliberate later Vercel reconnection, select the `ai-kits` repository and set **Root Directory: `kit-board`**, framework Next.js, Node 22, install `npm ci`, build `npm run build`. Restore the existing secret environment through the hosting UI and review domains/project ownership. The included `vercel.json` preserves daily legacy sync at 18:00 UTC and reset-feed sync at 13:15 UTC. These jobs need their configured secrets and source permissions; an unconfigured fresh site does not have working syncs.

This migration does not reconnect Git integration, change project root settings, deploy, rotate credentials, reconfigure live schedules or migrate the database. The old `.vercel` project linkage is deliberately excluded. Confirm the existing live project's root and deployment before any later cutover, and retain rollback access to source history and private backups.
