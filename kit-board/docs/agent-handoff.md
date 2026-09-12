# Personal Observatory agent handoff

Updated September 10, 2026. Start with [startup and recovery](startup-and-recovery.md) for the repository relocation, external dependencies and private prerequisites. Historical operational notes below are dated evidence, not a fresh production verification.

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
| Monthly AI usage | `/usage` | Full detailed monthly analysis; configured local sources refresh hourly |
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
| Telemetry contracts, storage, calculations | `lib/telemetry-contract.ts`, `lib/telemetry-store.ts`, `lib/cloud-estimate.ts`, `lib/cloud-estimate-store.ts` |
| Local collectors and Claude browser adapter | `scripts/telemetry/`, `browser/claude-quota/`, `docs/usage-collection.md` |
| Unified usage system design (companion, four ledgers, settings) | `docs/unified-usage-architecture.md` |
| Reset feeds | `lib/reset-feeds.ts`, `lib/reset-feed-store.ts`, `app/api/reset-feeds/route.ts` |
| Generic report ingestion | `lib/contracts.ts`, `lib/db.ts`, `app/api/v1/reports/[kind]/route.ts`, `scripts/publish.mjs` |
| HTML report isolation and assets | `lib/artifact.ts`, `lib/artifact-runtime.ts`, `components/report-frame.tsx`, `app/api/artifacts/`, `scripts/publish-assets.mjs` |
| Migrations and database policies | `supabase/migrations/` |
| Hosting cron schedules | `vercel.json`, `app/api/internal/` |
| Tests | `tests/*.test.ts`, `tests/*_test.py` |

`lib/generated/report-ui.json` and `lib/generated/collector-bundles.json` are checked-in generated files. Run `npm run report-ui` after changing the report UI inputs and `npm run collectors:bundle` after changing collector/browser files; commit their generated output with the source change.

## Data and security boundaries

Supabase is the canonical serving store. Obsidian and source report directories remain local working sources; do not sync whole vaults or source trees into the app. The application database role is restricted, RLS is enabled, and `anon`/`authenticated` have no table access in `personal_hub`.

The app uses these distinct credentials and never exposes them to browser code:

- Login password hash and session secret for the site UI.
- `INGEST_KEYS_JSON` producer credentials, scoped by report kind.
- Per-source telemetry upload keys, stored only as hashes in Supabase.
- Database URL and verified CA certificate, used only server-side.
- `CRON_SECRET` for Vercel internal sync endpoints.
- Temporary old-observatory credentials for the compatibility sync.

Secrets and local state are intentionally outside Git: `.env.local`, `.local/`, `~/.config/personal-hub/`, `~/.codex/token-usage-upload.json`, and other publisher/collector configuration. Never print, commit, paste into reports, or move their values into `NEXT_PUBLIC_*` variables. Do not describe secret values in a handoff or tool output.

Private endpoints must authenticate first and return `private, no-store`. Browser mutations must use `requireSameOrigin`. Preserve idempotency keys and receipts: timed-out writes are never automatically replayed. A browser telemetry source may submit quota samples only; it cannot submit buckets or invoke syncs.

## Database and migrations

Migrations are ordered in `supabase/migrations/` and have already been applied to production through:

`20260909200659_cloud_usage_calibrations.sql`

The main tables are `report_revisions`, `report_assets`, `usage_accounts`, `telemetry_sources`, `token_bucket_revisions`, `quota_samples`, `usage_calibrations`, and reset-feed state/revisions. Read the existing migrations before adding a table or grant. New private tables need RLS, revoked public grants, limited `personal_hub_app` grants, and matching policies.

Use the Supabase MCP/administrative path for DDL and write a corresponding migration. Validate privileges after DDL; the app role must not be allowed to change report history or an existing calibration coefficient. The Supabase project has no Data API requirement; keep its private schema unexposed.

The postgres.js connection is deliberately serialized in `lib/db.ts` through `lib/database-queue.ts`. Supavisor transaction pooling plus postgres.js pipelined parameterless queries previously left promises pending and caused `/api/reports` 503s. Do not remove this queue, increase parallel DB execution, enable prepared statements, or change transaction callbacks to fire unawaited queries without a targeted reproduction and soak test. See the reliability section of `docs/architecture.md`.

## Telemetry model

Uploaded monthly reports, hourly telemetry, allowance percentages, and external reset claims are different ledgers. The monthly dashboard retains detailed analyzer envelopes even when refreshed hourly. Do not combine them into a single total.

- `token_bucket_revisions` receives complete session/hour/model snapshots. Read queries select the most complete canonical revision; duplicates do not add.
- `quota_samples` contains provider percentage/reset observations, never a token conversion.
- `usage_calibrations` stores user-confirmed, local-only Claude evidence. Its provisional local-equivalent cloud/uncollected UI is paused (removed from Usage & pace); the retained backend never creates estimated buckets or modifies observed tokens.
- The cloud scenario requires real Claude allowance samples plus an explicit local-only baseline. It must pause for resets, gaps, stale readings, incomplete collectors, mismatched baselines, or insufficient allowance change. Do not introduce a provider-wide fixed conversion or sum five-hour and weekly windows.
- Browser-only Claude activity can provide allowance/reset observations, not exact historical token counts.

Current operational status is in `docs/schedules.md`. As of this handoff, macOS Codex and Claude collectors exist, Windows local connections have checked in, and Claude allowance samples have not yet arrived. The old browser connection is disabled; a new browser pairing is needed for the personal Claude account.

## Schedules, collectors, and reports

Keep schedules independent. The portal consumes their reports; it does not replace their source collection or merge logic.

- Local telemetry uses `scripts/telemetry/collect.py`; it reads local JSONL counters into a private SQLite checkpoint/outbox and publishes hourly. `install_schedule.py` installs a macOS LaunchAgent or Windows Task Scheduler task.
- Claude's optional `statusline.py` writes provider rate-limit fields to a local inbox. It is installed on this Mac but only produces data after an eligible local Claude Code response.
- The Claude browser extension is quota-only. Its connection JSON is imported in its options screen; it never receives Claude cookies.
- `scripts/publish.mjs` publishes generic reports with a local outbox. `publish-assets.mjs` uploads audit linked files. Preserve observation timestamps and source coverage rather than substituting publication time.
- Vercel runs the legacy usage compatibility sync daily at 18:00 UTC and reset feed sync daily at 13:15 UTC. The designated Codex local collector can additionally refresh feeds hourly.

For Windows local collection, the supported location is `%LOCALAPPDATA%\PersonalObservatory`: extracted local collector scripts and the downloaded local connection JSON live there. Browser connection JSON belongs in the extension popup, not the Python collector. See `docs/usage-collection.md` for exact commands.

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

The latest application commits are:

- `7462698 feat(usage): estimate uncollected cloud activity`
- `2b4ce7f fix(db): prevent pooled query hangs`
- `ce0816f feat(usage): add hourly telemetry and reset intelligence`

The site has a working shared shell, responsive report documents, full-depth audit selection, shadcn selects, authenticated assets, shared Supabase storage, hourly telemetry, reset intelligence, and a deployed cloud-estimate waiting state. Do not claim an estimate exists until Claude samples and a human-confirmed local-only baseline are present.

Likely next operational work:

1. Pair the new Claude browser extension with the intended personal account or trigger a local Claude Code response so allowance samples arrive.
2. Confirm the Windows Task Scheduler tasks are installed and run hourly; a one-off collector check-in does not prove scheduling.
3. Cloud/uncollected estimation is paused; do not request calibration unless the user asks to restore it.
4. Continue UI/report tuning from user feedback without flattening the separate internal navigation or report isolation boundaries.
5. Retire legacy compatibility sync and old credentials only after every desired computer uses direct uploads and parity is confirmed.

## Fast triage checklist

| Symptom | First places to inspect |
| --- | --- |
| Private page/API fails | `lib/auth.ts`, `app/proxy.ts` if present, Vercel env names, safe runtime logs |
| A report is missing or stale | `docs/schedules.md`, producer outbox/receipt under protected local config, `report_revisions`, producer scope |
| Live usage is pending/503 | `lib/db.ts`, `lib/database-queue.ts`, `lib/read-cache.ts`, new-deployment logs, `/api/usage-live` Server-Timing |
| Token totals disagree | `lib/telemetry-store.ts` canonical query, local collector SQLite state, account/source identity; never sum raw revisions |
| Claude cloud estimate is absent | Pairing/statusline readings, source freshness/coverage, `lib/cloud-estimate.ts`, confirmed baselines |
| Audit appears shallow or evidence links fail | `lib/report-selection.ts`, `lib/artifact.ts`, `lib/assets-store.ts`, audit coverage marker, protected artifact routes |
| Collector download/setup fails | `scripts/build-collector-bundles.py`, `lib/generated/collector-bundles.json`, `/api/collector-download`, `docs/usage-collection.md` |

Keep this handoff current when the data model, deployment topology, or operational status materially changes.


### Detailed monthly reporting (September 10)

The default `/usage` page retains the full uploaded-report detail and polls `/api/reports` once per visible minute. Local collectors can opt into the complete installed analyzer via `detailed_report`, with a separate existing publisher key and pinned machine identity. Current-month snapshots carry partial coverage and suppress full-prior-month percentage comparisons. `/usage/reports` is a compatibility redirect. See `docs/usage-collection.md` for setup, exact retry behavior and browser-only limitations; see `docs/schedules.md` for verified machine enablement.


### Production release (September 10)

Usage changes from commit `80b2ab8` are deployed as `[historical deployment ID omitted]` at the existing Observatory alias. The release was built from an isolated committed worktree; unrelated local agent-routing work was excluded. Reset history opens in a calendar, allowance cards show measured history and projected usage, Spark is hidden behind a toggle, and cloud/calibration UI is paused. The full monthly report now refreshes from detailed hourly Mac analyzer snapshots. See `docs/schedules.md` for production verification and remaining Windows scope.


### Compact reset calendar refinement (September 10)

Commit `da71b39` is deployed as `[historical deployment ID omitted]`. The calendar is 300px wide alongside the record, with date/type markers and separate provider/type filters; all reset types are shown initially. Normalizer v2 retains banked lifecycle, global scope and announcement/verification metadata. Existing snapshots were successfully refreshed from all four sources. Production checks confirmed distinct markers, day filtering, lease reuse and responsive layout; 40 isolated-release tests and the Vercel build passed, with no deployment error entries during verification.
