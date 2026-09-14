# Personal Observatory agent handoff

Updated September 14, 2026. Start with [startup and recovery](startup-and-recovery.md) for the repository relocation, external dependencies and private prerequisites. Historical operational notes below are dated evidence, not a fresh production verification.

**Usage entrypoint:** read [the current-system audit](usage-system.md) before changing usage behavior. It separates working features, settings-only scaffolding, local scheduler evidence, and production receipts. [V2 collection](usage-collection.md) is the current operating guide; [v1 retirement](usage-v1-retirement.md) owns preservation, migration, and removal instructions. Do not infer v1 is fully retired from disabled source credentials.

The September 13 audit found an active Windows v2 schedule plus two failing v1 schedules; a failing Windows detailed monthly upload; no September Windows report; active v1 Claude browser sources; Cursor and account/API readers still stubbed; and substantial v1-only hourly history. A later same-day [USG-002 recovery](usage-evidence/usg-002-2026-09-13.md) restored authenticated Windows detailed publication, published the preserved artifact, and verified the next natural hourly trigger end to end: 10 buckets and two records accepted with no rejection. Production still uses `buckets_only` with project attribution off, and the broader historical and inaccessible-host gaps remain open. Older status notes below do not override this updated evidence.

## Scope and source

- Repository: `/Users/joshgreenwell/github/ai-kits/kit-board`
- Production: `https://personal-observatory-jg.vercel.app`
- Vercel project: `the-mindful-pug/personal-hub`
- Supabase project: discover the existing private project through the operator’s hosting configuration; project identifier omitted from public source.
- Data schema: unexposed `personal_hub`
- Runtime: Next.js 16 App Router, React 19, Node 22, TypeScript, postgres.js, shadcn/Radix source components.

This is an independent personal tool. It is not Luumen product code, even though it displays Luumen reports. Do not edit the surrounding `luumen-workspace` repository for application changes. Read `AGENTS.md`, then this file, `README.md`, `docs/architecture.md`, `docs/schedules.md`, and `docs/usage-collection.md` before changing behavior.

## What the site does

One password-protected shell combines five report areas:

| Area | Route | Data source and rendering |
| --- | --- | --- |
| Monthly AI usage | `/usage` | Detailed analyzer reports; Windows publication recovered September 13, with cross-host continuity and historical reconciliation still open |
| Usage & pace | `/usage/live` | Hourly local telemetry and visual provider allowance forecasts |
| Daily tasks | `/tasks` | Published report envelope; isolated report document |
| Standup | `/standup` | Published report envelope; isolated report document |
| Readings | `/readings` | Published report envelope; isolated report document |
| Luumen AI audit | `/audit` | Full audit report plus authenticated linked evidence assets |
| Schedules | `/schedules` | Static operating/status summary |

The global shell and usage views are native React. Stored report HTML is intentionally served as an isolated, sandboxed document. Do not insert report HTML into the portal DOM, weaken its CSP, or make artifact data public merely to simplify rendering.

## Map of important files

| Concern | Start here |
| --- | --- |
| Global page shell, login boundary, navigation | `app/layout.tsx`, `app/(private)/layout.tsx`, `app/(private)/[section]/page.tsx`, `components/navigation.tsx`, `lib/auth.ts` |
| Shared design system | `app/theme.css`, `app/portal.css`, `app/observatory.css`, `components/ui/`, `components/page-header.tsx` |
| Monthly usage dashboard | `app/(private)/usage/page.tsx`, `app/usage-header.css`, `lib/usage.ts`, `app/api/reports/route.ts`, `scripts/telemetry/detailed_report.py` |
| Live usage views | `app/(private)/usage/live/page.tsx`, `app/(private)/usage/connections/page.tsx`, `app/(private)/usage/resets/page.tsx`, `app/telemetry.css` |
| Telemetry contracts, storage, calculations | `lib/telemetry-contract.ts`, `lib/telemetry-store.ts`, `lib/allowance-freshness.ts` (the one staleness rule), `lib/allowance-meters.ts` (canonical meter titles), `lib/routing-quota.ts`, `lib/cloud-estimate.ts`, `lib/cloud-estimate-store.ts` |
| Unified usage (envelope v2): contract, settings, ledgers, pairing | `lib/usage-contract.ts` (authority; `npm run usage-schema` writes `lib/generated/usage-v2.schema.json`), `lib/companion-settings.ts`, `lib/usage-store.ts`, `lib/knowledge-source-registry.ts`, `app/api/v1/companion/*`, `app/api/v1/usage/route.ts`, `app/api/companion-installs/route.ts`, `app/api/collection-settings/route.ts`, `app/api/usage-v2/route.ts`, `app/api/usage-knowledge-sources/route.ts`, `app/(private)/usage/settings/page.tsx`, `components/companion-installs.tsx` |
| v1 reference implementations and browser bridge | `scripts/telemetry/collect.py`, `scripts/telemetry/statusline.py` are retired and retained only for parity tests; `browser/claude-quota/` remains temporarily authorized for quota-only uploads from existing enabled browser sources |
| Companion (Rust, replaces the local collector scripts) | `companion/` (workspace, `companion/README.md`), `tests/fixtures/usage-v2/` (shared wire and parity corpus), `.github/workflows/companion.yml` |
| Usage feature/status authority; v1 retirement | `docs/usage-system.md`, `docs/usage-collection.md` (v2), `docs/usage-v1-retirement.md` |
| Usage capability and roadmap matrix, per provider, surface, and process | `docs/usage-coverage.md` (capability when enabled, not production status; update it with any collector or provider change) |
| Reset feeds | `lib/reset-feeds.ts`, `lib/reset-feed-store.ts`, `app/api/reset-feeds/route.ts` |
| Generic report ingestion | `lib/contracts.ts`, `lib/db.ts`, `app/api/v1/reports/[kind]/route.ts`, `scripts/publish.mjs` |
| HTML report isolation and assets | `lib/artifact.ts`, `lib/artifact-runtime.ts`, `components/report-frame.tsx`, `app/api/artifacts/`, `scripts/publish-assets.mjs` |
| Migrations and database policies | `supabase/migrations/` |
| Hosting cron schedules | `vercel.json`, `app/api/internal/` |
| Tests | `tests/*.test.ts`, `tests/*_test.py` |

`lib/generated/report-ui.json` is a checked-in generated file. Run `npm run report-ui` after changing the report UI inputs and commit its output with the source change. The retired collector-bundle generator and generated ZIP payload were removed; the site does not distribute v1 collectors.

## Data and security boundaries

Supabase is the canonical serving store. Obsidian and source report directories remain local working sources; do not sync whole vaults or source trees into the app. The application database role is restricted, RLS is enabled, and `anon`/`authenticated` have no table access in `personal_hub`.

The app uses these distinct credentials and never exposes them to browser code:

- Login password hash and session secret for the site UI.
- `INGEST_KEYS_JSON` producer credentials, scoped by report kind.
- Optional `USAGE_INGEST_KEYS_JSON` additive credentials, accepted only for usage-report recovery or key rotation.
- Per-source telemetry upload keys, stored only as hashes in Supabase.
- Database URL and verified CA certificate, used only server-side.
- `CRON_SECRET` for Vercel internal sync endpoints.
- Temporary old-observatory credentials for the compatibility sync.

Secrets and local state are intentionally outside Git: `.env.local`, `.local/`, `~/.config/personal-hub/`, `~/.codex/token-usage-upload.json`, and other publisher/collector configuration. Never print, commit, paste into reports, or move their values into `NEXT_PUBLIC_*` variables. Do not describe secret values in a handoff or tool output.

Private endpoints must authenticate first and return `private, no-store`. Browser mutations must use `requireSameOrigin`. Preserve idempotency keys and receipts: timed-out writes are never automatically replayed. A browser telemetry source may submit quota samples only; it cannot submit buckets or invoke syncs.

## Database and migrations

Migrations are ordered in `supabase/migrations/`. Production includes `20260909200659_cloud_usage_calibrations.sql` and `20260912230000_unified_usage.sql`; the latter was applied through the Supabase administrative path as migration-history version `20260913045514`. Post-apply validation confirmed RLS on all nine new tables, no public/anonymous grants, a security-invoker compatibility view, and no `UPDATE` or `DELETE` privilege for `personal_hub_app` on the four original v2 ledgers. The repository also contains `20260913230451_extend_usage_detail_contract.sql` for the USG-003 detail fields and three event ledgers; do not describe those additions as production-active until that migration is deployed and verified.

The main tables are `report_revisions`, `report_assets`, `usage_accounts`, `telemetry_sources`, `token_bucket_revisions`, `quota_samples`, `usage_calibrations`, and reset-feed state/revisions. Unified usage adds `collection_settings`, `companion_installs`, `companion_pairing_codes`, `companion_bindings`, `companion_runs`, and independent ledgers that are never blindly summed: `activity_requests`, `account_usage_buckets`, `allowance_readings`, `money_entries`, `agent_events`, `tool_events`, and `resource_accesses`; plus `allowance_percent_view`, which unions v1 quota samples and v2 percent readings by window key. Agent/tool/resource rows are attribution evidence and carry no additive tokens. Ledgers are append-only for the application role; canonical rows are chosen at read time. Read the existing migrations before adding a table or grant. New private tables need RLS, revoked public grants, limited `personal_hub_app` grants, and matching policies.

Use the Supabase MCP/administrative path for DDL and write a corresponding migration. Validate privileges after DDL; the app role must not be allowed to change report history or an existing calibration coefficient. The Supabase project has no Data API requirement; keep its private schema unexposed.

The postgres.js connection is deliberately serialized in `lib/db.ts` through `lib/database-queue.ts`. Supavisor transaction pooling plus postgres.js pipelined parameterless queries previously left promises pending and caused `/api/reports` 503s. Do not remove this queue, increase parallel DB execution, enable prepared statements, or change transaction callbacks to fire unawaited queries without a targeted reproduction and soak test. See the reliability section of `docs/architecture.md`.

## Telemetry model

Uploaded monthly reports, hourly telemetry, allowance percentages, and external reset claims are different ledgers. The monthly dashboard retains detailed analyzer envelopes even when refreshed hourly. Do not combine them into a single total.

- `token_bucket_revisions` receives complete session/hour/model snapshots. Read queries select the most complete canonical revision; duplicates do not add.
- `quota_samples` contains provider percentage/reset observations, never a token conversion.
- Allowance readings belong to a verified account, not to a machine. The Claude statusline reader lives in the `claude_account` adapter and binds each sample by the identity the hook stamped on it when it observed the reading; a sample it cannot attribute is quarantined on the machine and never assigned to the first binding. `allowance_readings` retains the producer's `basis`, meter key, label, window, reset anchor, and scope untouched. One rule decides staleness everywhere (`lib/allowance-freshness.ts`): older than `max(120, 2 × cadence_minutes + 15)` minutes, or the window has already reset. Collector contact (`telemetry_sources.last_seen_at`, `companion_installs.last_seen_at`) moves on any accepted envelope, coverage-only included, and must never be presented as a fresh meter; Connections reads each binding's and browser source's newest observation from the ledgers instead.
- `usage_calibrations` stores user-confirmed, local-only Claude evidence. Its provisional local-equivalent cloud/uncollected UI is paused (removed from Usage & pace); the retained backend never creates estimated buckets or modifies observed tokens.
- The cloud scenario requires real Claude allowance samples plus an explicit local-only baseline. It must pause for resets, gaps, stale readings, incomplete collectors, mismatched baselines, or insufficient allowance change. Do not introduce a provider-wide fixed conversion or sum five-hour and weekly windows.
- Browser-only Claude activity can provide allowance/reset observations, not exact historical token counts.
- Support and health come from evidence, never from the settings matrix. Each companion build posts a strict capability document (`lib/companion-capabilities.ts`, `companion/crates/observatory-contract/src/capabilities.rs`); `usageStore.listInstalls` derives per-install `capabilities` (current only while it matches the running version and is under fourteen days old), `schedule` (installed versus desired cadence, pending flag), and `health` (paired · bindings · identity · execution · records, coverage-only, overdue). Usage → Settings labels values as supported/unsupported/unverified from those reports and never disables a control; Connections renders the ladder. The site never rewrites an OS schedule: a cadence change stays `pending` with the exact `observatory service install --config-dir …` action until the companion reports a matching interval. A new setting that needs a build capability gets a `requires` entry in `settingsMatrix`.
- Project attribution is opt-in (`execution.project_attribution: hashed`) and uploads a structured identity and basis, never the path. A local attribution deny strips it from queued records; adapter, provider, and execution-mode denies keep the denied adapter's queued records local. The server registry maps separately scoped machine paths, worktrees, and native identities to stable labels through append-only revisions. Cloud runs without a producer remain unattributed. `docs/usage-coverage.md` is the matrix.

Current operational status is in `docs/schedules.md`. As of September 13, both machines have enabled companion installs and account bindings. Every legacy `local` source is disabled in production, and the old Windows Claude and Codex keys return 410. The existing Work and Personal browser quota sources are enabled as a temporary bridge. Remove the remaining v1 local schedules and files from each machine rather than troubleshooting them, but preserve the active unpacked browser extensions until their replacement is live.

## Schedules, collectors, and reports

Keep schedules independent. The portal consumes their reports; it does not replace their source collection or merge logic.

- The `observatory` companion under `companion/` replaces `collect.py`, `statusline.py`, and `install_schedule.py`: one binary per machine, adapters per provider, envelope v2 to `POST /api/v1/usage`. The server side and unified migration are live. The website no longer creates or serves v1 collectors. Legacy local telemetry receives 410, while enabled v1 browser sources may send quota-only Claude readings until the v2 browser collector ships. See `companion/README.md`.
- The companion-managed Claude statusline hook writes provider rate-limit fields to its own inbox. Do not restore the old Python statusline hook.
- Legacy local collector sources were disabled in production on September 13. Remove their schedules through the retirement runbook; preserve and reconcile their SQLite events, pending uploads, inboxes, receipts, and analyzer ledgers before removing runtime files. A recent v2 receipt does not prove historical parity. Existing enabled v1 browser quota sources remain an explicit migration dependency.
- `scripts/publish.mjs` publishes generic reports with a local outbox. `publish-assets.mjs` uploads audit linked files. Preserve observation timestamps and source coverage rather than substituting publication time.
- Checked-in Vercel schedules are legacy usage compatibility sync at 18:00 UTC, reset feeds at 13:15 UTC, and companion-release lookup at 13:45 UTC. Opening Reset intelligence can also refresh feeds. The v2 companion has no hourly feed-refresh implementation; deployed cron execution must be verified separately.

For Windows local collection, use one non-virtualized companion directory such as `%USERPROFILE%\.config\personal-hub\companion` and pass it consistently with `--config-dir`. Provider-owned `.codex` and `.claude` stores remain in place as inputs; do not copy them into the companion tree. See `docs/usage-collection.md` for exact commands.

## Development and verification

```bash
npm ci
npm run dev
npm test
npm run test:collector
npm run typecheck
npm run build
```

`npm run build` runs `npm run report-ui` first. Run the focused tests covering a change before the full suite. For changes to routes, auth, ingestion, telemetry, or database behavior, also perform an authenticated local HTTP check using the existing ignored verification helpers only if their required local runtime configuration exists. Do not manufacture credentials.

Use a production build (`npm run build && npx next start --port <unused-port>`) when testing client-to-API behavior. The live views intentionally retry one transient GET failure, bound reads, avoid overlapping refreshes, and show an error/retry control instead of leaving a permanent loading state.

Deployment is separate from this source relocation. Set the Vercel project Root Directory to `kit-board` when deliberately reconnecting this repository; see [startup and recovery](startup-and-recovery.md). No hosting change is implied by this checkout.

## Current baseline and open work

The historical commit list and release notes below explain earlier decisions. Current usage status and ordered work are maintained only in [the system audit](usage-system.md#reconciliation-order), including monthly-publication recovery, v1 data reconciliation, scheduler cleanup, and unimplemented provider readers.

The latest application commits are:

- `7462698 feat(usage): estimate uncollected cloud activity`
- `2b4ce7f fix(db): prevent pooled query hangs`
- `ce0816f feat(usage): add hourly telemetry and reset intelligence`

The site has a working shared shell, responsive report documents, full-depth audit selection, shadcn selects, authenticated assets, shared Supabase storage, hourly telemetry, reset intelligence, and a deployed cloud-estimate waiting state. Do not claim an estimate exists until Claude samples and a human-confirmed local-only baseline are present.

Historical follow-ups (superseded for usage by the September 13 audit):

1. Pair the new Claude browser extension with the intended personal account or trigger a local Claude Code response so allowance samples arrive.
2. Confirm the Windows Task Scheduler tasks are installed and run hourly; a one-off collector check-in does not prove scheduling.
3. Cloud/uncollected estimation is paused; do not request calibration unless the user asks to restore it.
4. Continue UI/report tuning from user feedback without flattening the separate internal navigation or report isolation boundaries.
5. Retire legacy compatibility sync and old credentials only after every desired computer uses direct uploads and parity is confirmed.

## Fast triage checklist

NextReset is the primary and only Codex reset-feed provider. The retired Codex
Reset endpoints (including forecast) are no longer polled or shown in feed health.
See [reset-feed sources](reset-feeds.md) for transport, history preservation,
freshness, classification and verification boundaries (September 13, 2026).

| Symptom | First places to inspect |
| --- | --- |
| Private page/API fails | `lib/auth.ts`, `app/proxy.ts` if present, Vercel env names, safe runtime logs |
| A report is missing or stale | `docs/schedules.md`, producer outbox/receipt under protected local config, `report_revisions`, producer scope |
| Live usage is pending/503 | `lib/db.ts`, `lib/database-queue.ts`, `lib/read-cache.ts`, new-deployment logs, `/api/usage-live` Server-Timing |
| Token totals disagree | `lib/usage-store.ts` canonical query, companion SQLite state, account/binding identity; never sum raw revisions |
| Claude cloud estimate is absent | Pairing/statusline readings, source freshness/coverage, `lib/cloud-estimate.ts`, confirmed baselines |
| Audit appears shallow or evidence links fail | `lib/report-selection.ts`, `lib/artifact.ts`, `lib/assets-store.ts`, audit coverage marker, protected artifact routes |
| Companion setup fails | `companion/README.md`, `observatory doctor`, the configured companion directory, `/api/v1/companion/*`, `docs/usage-collection.md` |

Keep this handoff current when the data model, deployment topology, or operational status materially changes.


### Detailed monthly reporting (September 10)

The default `/usage` page retains the full uploaded-report detail and polls `/api/reports` once per visible minute. Local collectors can opt into the complete installed analyzer via `detailed_report`, with a separate existing publisher key and pinned machine identity. Current-month snapshots carry partial coverage and suppress full-prior-month percentage comparisons. `/usage/reports` is a compatibility redirect. See `docs/usage-collection.md` for setup, exact retry behavior and browser-only limitations; see `docs/schedules.md` for verified machine enablement.


### Production release (September 10)

Usage changes from commit `80b2ab8` are deployed as `[historical deployment ID omitted]` at the existing Observatory alias. The release was built from an isolated committed worktree; unrelated local agent-routing work was excluded. Reset history opens in a calendar, allowance cards show measured history and projected usage, Spark is hidden behind a toggle, and cloud/calibration UI is paused. The full monthly report now refreshes from detailed hourly Mac analyzer snapshots. See `docs/schedules.md` for production verification and remaining Windows scope.


### Compact reset calendar refinement (September 10)

Commit `da71b39` is deployed as `[historical deployment ID omitted]`. The calendar is 300px wide alongside the record, with date/type markers and separate provider/type filters; all reset types are shown initially. Normalizer v2 retains banked lifecycle, global scope and announcement/verification metadata. Existing snapshots were successfully refreshed from all four sources. Production checks confirmed distinct markers, day filtering, lease reuse and responsive layout; 40 isolated-release tests and the Vercel build passed, with no deployment error entries during verification.


### Project attribution and coverage matrix (September 12)

The companion records each request's project evidence as working-directory identity, known No project, or Unknown, and records its surface (`cli`, `desktop`, `ide`, `sdk`) from Claude Code's `entrypoint` and Codex's `originator`. Only explicit `cwd: null` means No project; malformed and missing values remain Unknown. Native project identity is retained when a supported future source supplies it; current local transcript formats do not expose one. State schema 6 keeps the structured key and basis while the local `projects` table, listed by `observatory projects`, is the only path-to-hash map. The server stores stable project labels, scopes identities so matching folder names on different machines stay distinct, and applies append-only mapping revisions through `activity_request_project_resolution`. That view canonicalizes request revisions with richer project evidence first, treats retained legacy hashes as working-directory identities without editing raw facts, and reads mappings by database revision order. The authenticated `/api/usage-projects` route names and maps those identities; its UI belongs to USG-015. `docs/usage-coverage.md` records what is collected and the remaining cloud and allowance gaps. Keep it current with any collector or provider change.


### Knowledge-source access (September 14)

Knowledge sources are local configuration, not a setting: `companion.json` `resources` entries carry a privacy-safe key, local roots, `mcp:`/`url:` connectors, a label, and an informational source; `setup` proposes Obsidian vaults from the application's own registry as `obsidian.<vault id>` (never under `--yes`), and `observatory resources [add|remove]` lists and edits them on the machine. The companion classifies supported Claude and Codex tool arguments against those roots and connectors while they are in memory (explicit path arguments, patch headers, shell tokens with `cd` tracking, `tools.*` calls inside Codex `exec` scripts, MCP namespaces, fetched URLs) and keeps, in state schema 7, one (invocation, source) row and one inspection class per invocation, never a path. A working directory only resolves relative arguments and is never access by itself. Rows upload at `requests_with_tools` as `resource.access` with the key, an opaque random `cfg:` configuration token, access kind, evidence basis, outcome, and invocation join; the local deny entry `execution.resource_attribution` keeps them on the machine; a configuration change replays retained transcripts and supersedes stale queued rows, while rows the server already holds are append-only and never retracted. The server scopes identities per `(install, key)`, keeps stable labels and append-only mapping revisions, resolves accesses through `resource_access_source_resolution` with a `current_configuration` flag, and exposes the authenticated `/api/usage-knowledge-sources` naming/mapping route; its UI belongs to USG-015 and USG-022. Neither the companion build nor the server migration carrying this has been deployed.


### Allowance identity and freshness (September 14)

The Claude statusline allowance reader moved from `claude_execution` to the `claude_account` adapter (parser version `2.0.0+statusline1`, channel `hook_snapshot`, reader `statusline`, record ids unchanged), which also reports the new `allowance` capability dimension; the per-adapter coverage maximum is now eight rows, and `codex_execution` reports the embedded Codex row. `allowance.claude_reader` gates that adapter, `off` being the only value that stops it, and `oauth_usage` keeps the statusline reader running as the documented fallback; the local deny entry `allowance.claude_reader.statusline`, or a dotted prefix, removes it in either mode and holds queued statusline readings on the machine. `observatory statusline` now stamps each sample with the account signed in when it observed the reading (config file resolved as `OBSERVATORY_CLAUDE_CONFIG_FILE`, `$CLAUDE_CONFIG_DIR/.claude.json`, `~/.claude.json`; evidence cached by `stat`) and writes one part file per changed reading, on a changed value or a fifteen-minute heartbeat, with its kept state and sidecar beside the inbox; the run prunes the inbox afterwards. The run binds a stamped sample to the binding holding that hash and holds everything else in the schema-8 `allowance_quarantine` table (`identity_ambiguous`, `identity_unconfirmed`, `unpaired_identity`), re-evaluating and releasing on later runs rather than assigning a reading to the first Claude binding. Its local replay key includes the stamp so equal readings from separate accounts remain distinct. It also declines to confirm an identity a sibling binding already holds or that two enabled unconfirmed siblings could both claim; the Observatory serializes binding creation and confirmation per install and refuses a sibling hash as 409 `identity_taken`. Server side, `20260914010000_allowance_basis_and_run_counts.sql` keeps `basis` on `allowance_readings` and in the compatibility view, adds `companion_runs.accepted_by_type`, and indexes both ledgers by `(binding_id, observed_at DESC)`; one shared rule decides staleness (`lib/allowance-freshness.ts`), the current reading is the newest observation among the `statusline`, `embedded`, and `web_backend` readers with ties by that order, and Connections separates collector contact from each binding's and browser source's newest observation. This migration and the companion build carrying the `allowance` row are not deployed; the server and migration must go first, and fresh production readings are gated on USG-025.
