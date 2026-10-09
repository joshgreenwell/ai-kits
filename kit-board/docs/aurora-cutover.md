# Move the database from Supabase to Aurora

Started September 29, 2026. The site's Postgres moves from Supabase to an Aurora PostgreSQL Serverless v2 cluster in AWS. **Production has run on Aurora since September 30.** The app uses only Postgres there: no Supabase Storage, Auth or Data API. So the move covers the `personal_hub` schema and nothing else.

## Status

- **September 29: bootstrap and validation done.** Aurora has all 32 migrations and their history. `personal_hub_app` has its password, and its URL is in Doppler as `APP_DATABASE_URL`. The privilege checks matched the security model. A local run as `personal_hub_app` signed in and loaded every page and data endpoint without errors.
- **Open question: sleep.** The cluster paused overnight, and the first connection then took 17 s. In the afternoon it stayed up through two idle windows of 18 and 22 minutes, with no user sessions open. Confirm the minimum capacity and the auto-pause delay with the administrator.
- **September 29, evening: production dumped.** 39 tables and 737,774 rows, taken with `pg_dump` 17 at 02:41 UTC on September 30. The column, constraint, sequence and trigger signatures of the two databases matched line for line. The load ran as one transaction in 2 min 22 s. Afterwards every table's row count matched the dump, both as `ai_kits` and as `personal_hub_app`, the check was back `NOT VALID`, and the schema was analyzed. The dump files were then deleted.
- **September 30, 03:48 UTC: cut over.** Production reads and writes Aurora. The window fell between the hourly uploads, which land at about :17 and :31. On Vercel, `DATABASE_URL` and `DATABASE_CA_CERT` changed at 03:41. A fresh dump started at 03:42:47 and loaded 739,214 rows by 03:46:52. Commit `e581704` (region `iad1`, 25 s connect timeout) deployed from `main` and was serving by 03:48:41. Afterwards, per-table checksums of Supabase matched Aurora's post-load state on 38 of 39 tables. The only difference was the PR-watch runner's `last_seen_at` heartbeat: Supabase held 03:44:00, and Aurora already held 03:49:00, written through the new deployment. So no row was lost. Supabase is untouched and stays available for rollback.
- **October 2, 16:30 UTC: Supabase is a stale subset of Aurora.** Nothing has written to Supabase since the cutover; its newest row is still the 03:44 UTC heartbeat. Both companions reach Aurora through production: the Mac (`2cf53a04…`) was last seen at 16:09 and `pc-workstation` (`2b0898b0…`) at 16:26, with 45 and 60 runs since the cutover. Every row in Supabase was hashed over the columns both databases share and matched by primary key in Aurora. Of 739,214 rows, 739,178 were identical and 36 were older versions of mutable rows that Aurora has since advanced: heartbeats, `last_seen` times, the reset-feed state, one tool result that arrived later, and two v1 sources disabled after the cutover. None was missing from Aurora, so nothing needs copying. Aurora held 770,731 rows. See [Clearing Supabase](#clearing-supabase).

## The target

- Aurora PostgreSQL 17.9 Serverless v2 in `us-east-1`, capped at 1 ACU (2 GiB). It pauses after 15 idle minutes, and the first connection after a pause waits for it to resume: 17 s measured on September 29, about 15 s by the administrator's estimate.
- The endpoint is public on a non-default port with no IP allowlist, because Vercel's Hobby plan has no fixed egress address. The URL is a credential. TLS is mandatory and plaintext connections are refused.
- The connection lives in Doppler: project `ai-kits`, config `dev`, secret `DATABASE_URL`. The host and port are recorded only there. That URL is the `ai_kits` login, which owns database `ai_kits`. It is not a superuser, and as provisioned it cannot create roles.

## Identities

The split is the same as on Supabase. `ai_kits` plays the part `postgres` played: it applies migrations and owns every object. The site connects only as `personal_hub_app`, which can read, append and update the status columns the migrations grant it. It is refused `DELETE` on report history and refused DDL. The `ai_kits` URL never goes on Vercel.

`ai_kits` needs `CREATEROLE` to bootstrap. `20260908051221_personal_hub_app_role.sql` issues a bare `CREATE ROLE personal_hub_app`. Several early migrations also revoke from `anon` and `authenticated`, the Supabase browser roles, which do not exist on Aurora. A rehearsal on September 29 used a throwaway local cluster with a database owner that was not a superuser:

- **With `CREATEROLE`,** all 32 migrations applied unchanged through `supabase db push --db-url`, and history landed in `supabase_migrations.schema_migrations`. The owner could set the app role's password. `personal_hub_app` was refused `DELETE` on report history and refused DDL.
- **Without it,** the push stopped at the role migration with `permission denied to create role`. That happened even when an administrator had already created the role, because Postgres checks the privilege before it checks whether the role exists.

On PostgreSQL 16 and later, `CREATEROLE` lets `ai_kits` manage only the roles it creates. It grants no superuser or `rds_superuser` power. The administrator can revoke it after bootstrap. A later migration that creates a role would need it again.

## Bootstrap (once)

Run these from `kit-board/`.

1. The cluster administrator runs `ALTER ROLE ai_kits CREATEROLE;` as the master user.
2. Create the two stand-in roles that the early migrations revoke from. They never log in and hold nothing; `scripts/test-db.mjs` does the same locally.
   ```bash
   doppler run --project ai-kits --config dev -- sh -c 'psql "$DATABASE_URL" -c "CREATE ROLE anon NOLOGIN" -c "CREATE ROLE authenticated NOLOGIN"'
   ```
3. Apply every migration and record the history:
   ```bash
   doppler run --project ai-kits --config dev -- sh -c 'supabase db push --db-url "$DATABASE_URL"'
   ```
   From then on, `supabase migration list --db-url "$DATABASE_URL"` and `supabase db push --db-url "$DATABASE_URL"` replace the `--linked` forms.
4. Set `personal_hub_app`'s password over a protected channel, such as an interactive `psql` session running `\password personal_hub_app`. Store the resulting URL as a separate Doppler secret, `APP_DATABASE_URL`. It uses the same host, port and database, the user `personal_hub_app`, and `sslmode=require`.

## TLS

`DATABASE_CA_CERT` is the RDS `us-east-1` bundle, https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem. It holds three roots in 4.6 KB. The global bundle holds 108 certificates in 165 KB, which is more than Vercel's 64 KB budget for a deployment's environment variables. `lib/db.ts` passes the CA with `rejectUnauthorized: true`, so the certificate chain and the hostname are both verified, and the URL's `sslmode` is ignored. On September 29 `psql` connected with `sslmode=verify-full` and that bundle over TLS 1.3.

## Validate before any data

- Run `npm run dev` with `DATABASE_URL` set to `APP_DATABASE_URL` and `DATABASE_CA_CERT` set to the bundle. Sign in (this writes `login_limits`) and open every page; each should show its empty state.
- As `personal_hub_app`, confirm that `DELETE FROM personal_hub.report_revisions` and a `CREATE TABLE` are both refused.
- Wait past the 15-minute pause, then load a page. It should succeed after the resume delay.
- Anything written during validation is cleared by the data load, which truncates first.

## Data migration

This step comes after validation.

- **Tools.** `pg_dump` 17 or later. Supabase runs 17.6, and the Homebrew `pg_dump` 16 refuses to dump a newer server.
- **Source.** The Supabase session pooler on port 5432, not the transaction pooler. The app's own login can read everything: each of the 39 tables has row security with a permissive `SELECT` policy of `USING (true)` for `personal_hub_app`, the role can read every column, and no table has a restrictive policy. So `pg_dump --enable-row-security` run as that role reads every row. Check this before each dump, because a policy that narrows reads would leave rows out of the dump without any error. A Supabase `sb_secret_` API key cannot log in to Postgres.
- **Dump.** Take a data-only dump of `personal_hub`. Truncate the target's `personal_hub` tables first, because the migrations seed the `collection_settings` row and production's copy must replace it, and validation leaves `login_limits` rows. The account migrations (the Cursor splits and renames) skip themselves on a database without production's bindings, so `usage_accounts` starts empty and every account arrives with the load. `supabase_migrations` is not copied: Aurora's history comes from the push, which matches the files.
- **The one `NOT VALID` check.** `account_usage_buckets_reasoning_subset_check` rejects legacy rows that production kept. Drop it before the load and re-add it `NOT VALID` afterwards.
- **Foreign keys.** `ai_kits` is not a superuser, so `--disable-triggers` is unavailable, and the dump's table order has to satisfy the foreign keys. It does: the 50 foreign keys have no cycles and none refers to its own table, and `pg_dump --data-only` of a database built from the migrations reports no circular constraints (checked September 29). `pg_dump` also leaves out the three generated columns, which Aurora recomputes.
- **Verify.** Compare row counts table by table and spot-check the Usage, Tokens and report pages.
- **Timing.** Companions upload hourly and keep their receipts, so rows written to Supabase after the dump are not re-sent. Copy just after an hourly upload and cut over right after the load. Then copy any append-only ledger rows received on Supabase since the dump started.

## Cutover

1. On Vercel, set `DATABASE_URL` to `APP_DATABASE_URL` and `DATABASE_CA_CERT` to the RDS bundle.
2. In `vercel.json`, change `regions` from `cle1` (Ohio, next to Supabase's `us-east-2`) to `iad1` (next to `us-east-1`).
3. Deploy. Sign in, open each area, and confirm that the next hourly companion receipt lands on Aurora.
4. To roll back, restore the previous two variables and the region. Supabase stays intact until the move has held.
5. `README.md`, `architecture.md`, `startup-and-recovery.md` and `agent-handoff.md` were updated on October 9, 2026. Before retiring the Supabase project, copy what exists only there: the `personal_hub_archive` schema, which holds the undo copies written by the September 24 prune migrations and which the data-only dump of `personal_hub` did not move. Then retire the project.

## Operating on Aurora

- **Resume.** `lib/db.ts` waits up to 25 s for a connection so the first request after a pause succeeds; it used 3 s against Supabase's pooler. On September 29, after 19 idle minutes, a client with the old 3 s limit failed with `CONNECT_TIMEOUT` and a client with 25 s connected and answered in 17 s. The job budget in `lib/database-budget.ts` includes that wait, so the waking request has about 15 s left for its query. A Tokens read that needs more returns 504 once, and a route with `maxDuration = 15` can time out on the waking request. The next request succeeds. The companion and the publishers wait 45 s.
- **No pooler.** Each Vercel instance holds at most one connection, and `lib/db.ts` closes it after 5 s idle and 60 s total. Prepared statements stay disabled.
- **Capacity.** One ACU is the ceiling. If Tokens reads regress against Supabase, ask the administrator for more.

## Clearing Supabase

Supabase is retired. Clearing it ends the rollback path. The October 2 comparison found every Supabase row in Aurora, so nothing is lost. `scripts/clear-supabase.sql` empties every `personal_hub` table in one transaction and keeps the schema and `supabase_migrations`. Before it deletes anything, it refuses to run if:

- the database is not Supabase (it checks for the `postgres` database and the `supabase_admin` role, which Aurora lacks);
- the tables no longer total 739,214 rows;
- any write-time column is later than the 03:48 UTC cutover.

A refusal deletes nothing and means something reached Supabase after the comparison: compare again before clearing. `personal_hub_app` is refused `DELETE` on report history, so the script runs in the Supabase dashboard's SQL editor, which connects as `postgres`. From `kit-board/`, copy it:

```bash
pbcopy < scripts/clear-supabase.sql
```

Open the project in the Supabase dashboard, then open **SQL Editor** and start a new query. Paste the script, run it, and confirm the warning about destructive statements. The editor shows one row: 39 `personal_hub_tables` and 0 `rows_left`. On October 2, before the run, the same query read 39 tables and 739,214 rows.

Afterwards, any row that appears in Supabase marks a writer still aimed at it. Retiring the project itself (pause or delete) is a separate step in the dashboard. The script truncates `personal_hub` only, so the `personal_hub_archive` undo copies survive it; copy them first, as step 5 of the cutover says.

### Keep every writer on Aurora

The site and `scripts/reconcile-usage-history.mjs` refuse a `DATABASE_URL` on a Supabase host (`lib/database-host.ts`). The site answers 503 and the script exits, so no environment, including a local `npm run dev`, can write there once that code is deployed. Neither the CLI nor the repository is linked to the Supabase project any more: `supabase unlink` cleared both `.temp` directories, and the root one is no longer tracked. Apply migrations with `supabase db push --db-url` and Doppler's `DATABASE_URL` (see [PR watch](pr-watch.md)), never `--linked`.

Companions, the browser collector and the publishers hold no database URL. They upload to the site over HTTPS, so they write wherever production's `DATABASE_URL` points. Check these:

- **A companion aimed at another site.** `companion.json` must name `https://personal-observatory-jg.vercel.app`, not a preview URL or a local server. On the PC, in PowerShell:
  ```powershell
  $companionExe = Join-Path $env:LOCALAPPDATA 'Programs\observatory\observatory.exe'
  $companionDir = Join-Path $env:USERPROFILE '.config\personal-hub\companion'
  (Get-Content (Join-Path $companionDir 'companion.json') -Raw | ConvertFrom-Json) | Select-Object url, install_id
  & $companionExe --config-dir $companionDir doctor
  ```
  Expect that URL and install `2b0898b0-b501-4d97-8b1b-21d4d20b27dc`. The install key is not printed. Do not run `connect` or re-pair to change it; see [usage collection](usage-collection.md#windows-commands). The Mac's install `2cf53a04-3680-473f-8726-f98618f5899a` names the same URL, which was checked October 2.
- **A local `.env.local`.** On October 2 the Mac's `kit-board/.env.local` was switched to Doppler's `APP_DATABASE_URL` (`personal_hub_app` on Aurora) and the RDS CA bundle. On any other machine with a `kit-board` checkout, including the PC (`Select-String -Path C:\path\to\ai-kits\kit-board\.env.local -Pattern 'supabase.com' -List`), do the same or remove `DATABASE_URL`. Until it changes, the guard refuses to connect. Integration tests use `TEST_DATABASE_URL` and are unaffected.
- **A Vercel environment other than Production.** The cutover record does not say which Vercel environments changed `DATABASE_URL` and `DATABASE_CA_CERT`. Confirm that Preview and Development no longer name Supabase. A deployment built after the guard refuses it anyway; an older preview deployment does not.
