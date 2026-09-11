# Personal Observatory

The new Vercel project is `the-mindful-pug/personal-hub`. Its source is an independent application under `ai-kits/kit-board/`, not Luumen product code. It combines existing report experiences behind one password and navigation header.

## Data ownership

Supabase Postgres owns the site's durable report history, selected by Josh on 2026-09-08. It also provides integrated object storage for a future larger artifact archive. No Neon database was created. The site connects through Supavisor transaction pooling with prepared statements disabled. Its tables live in the unexposed `personal_hub` schema with row-level security enabled and public grants revoked; browsers never receive database credentials.

Obsidian remains local shared working memory. Do not sync the entire vault to the website. The site receives deliberately published reports, source references, coverage, and timestamps. Linear and Jira remain the task-status authorities. Report imports do not create, resolve, or modify tasks.

`report_revisions` stores immutable report envelopes and optional self-contained HTML. Small-to-medium HTML is stored in Postgres initially to keep one atomic write and one access boundary; move large artifacts to private object storage when required, retaining hashes and references in Postgres. No private reports live in `public/` or the deployment bundle.

## Ingestion

Each report producer receives a separate bearer credential scoped to its report kinds. The site password cannot upload data. Report producer credentials never appear in prompts, source control, browser storage, or report payloads.

Hourly telemetry is a separate subsystem: account-bound collectors upload complete session/hour/model counter snapshots to `POST /api/v1/telemetry`. The server retains revisions and selects a nonregressing canonical snapshot, preserving the existing monthly report contract and avoiding double counting. Quota readings remain separate from tokens and from public reset claims. The monthly dashboard keeps the full analyzer envelope; configured hourly collectors also refresh that envelope separately from token buckets. See `usage-collection.md` for accounting boundaries.

Collector keys are random, stored only as hashes in Supabase, and revocable through the authenticated Connections page. Browser collector keys can upload only allowance readings for their assigned account; they cannot read private data, upload token buckets, or refresh feeds. The experimental Claude extension stores this narrowly scoped key in trusted extension-local storage; provider cookies stay in the browser. Local collectors keep their keys and SQLite checkpoints in private local files. Public reset feeds use an allowlist, bounded fetches, a shared refresh lease, and immutable normalized revisions. No collection or calculation invokes an AI model.

The generic endpoint is `POST /api/v1/reports/:kind` for `tasks`, `standup`, `readings`, and `audit`. The envelope requires schema version, report period, subject, stable revision key, title, real observation timestamp with timezone, status, coverage, payload, and optional HTML. Limits are measured while streaming the request, including requests without a Content-Length header.

`POST /api/reports` preserves the existing monthly usage JSON contract. The reader selects the newest nonfailed revision for each machine and calendar month, so a correction replaces the displayed snapshot while preserving history. Source identity is preserved in the existing machine identifiers, including the Claude Code suffix.

The publisher keeps a private local outbox and server receipts. Retry the same report after a network failure; do not rerun expensive analysis or mailbox scans just because publication failed. Reusing a revision key with different content returns a conflict. Producer observation time and server receipt time remain separate.

## Daily contributions

Claude's 8:45 AM work-source fragment and Codex's 9:00 AM daily briefing remain separate jobs. Preserve `personal-assistant-brain/reference/briefing-data-contract.md` and its deterministic merge. During migration the publisher uploads the validated merged JSON and HTML. It does not replace Claude's fragment, create another merge algorithm, or upload unrelated vault state.

## Access control

The single-user login verifies a salted scrypt hash. A signed HttpOnly, Secure, SameSite=Lax cookie expires after seven days; password or signing-secret rotation invalidates it. A shared database rate limit applies across server instances. Browser mutations require the expected Origin. Every private page, data endpoint, and report asset verifies authentication; private responses are not cached.

HTML reports are isolated in sandboxed documents without same-origin privileges. Their network access and form submissions are disabled. Inline event attributes do not run; original inline script blocks require exact content hashes. The same HTTP sandbox applies when a document is opened outside its iframe. The global header stays outside the report document.

Reports fill the available width and participate in the page's natural vertical scroll. A CSP-hashed layout bridge reports document height and anchor coordinates; the parent accepts only finite, bounded messages from that iframe's opaque-origin WindowProxy. Viewport coordinates keep the audit's section navigation below the shared header. No report HTML is inserted into the portal DOM. Evidence tables scroll within their containers, and the same gutters, fonts, colors, and responsive rules apply to imported reports and native pages.

Audit histories prefer the newest nonfailed revision marked `coverage.presentation: "full-audit"`. Producers set this marker only after checking complete scorecards, capability operating models, findings, evidence, remediation, and working report navigation. Condensed supplements remain selectable in history. Observation dates are never replaced with import dates to influence the default selection.

## Migration and rollback

1. Create the private application, choose/connect its isolated database, and apply schema.
2. Import report copies and verify record counts, dates, machine identities, totals, navigation, and access control.
3. Deploy with password and producer credentials configured.
4. Update producers only after successful end-to-end publication receipts. Preserve their recurrence, source restrictions, merge rules, and existing output artifacts.
5. Document every producer connection and unresolved source. A one-time backfill is not proof that a schedule is connected.

Keep the old Token Observatory and local reports available until parity is confirmed. The old source is pinned at `3315a6b0b850f9711106d1cacbd1145b357124dc` — a ref in the Token Observatory's own repository, not resolvable here; the dashboard presentation and environmental assumptions were copied from that version. No old reports are deleted by this application.

The current merged Luumen AI audit artifact is about 3 MB. The generic HTTP limit is 4 MB, below Vercel's request ceiling. Publish HTML with a compact metadata payload, not a second copy of all embedded evidence. Keep raw execution logs and full source trees outside this site.

## References

- [Vercel storage](https://vercel.com/docs/storage)
- [Supabase platform](https://supabase.com/docs/guides/platform)
- [Supabase database connections](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Next.js authentication](https://nextjs.org/docs/app/guides/authentication)

Checked 2026-09-08. This document describes the intended architecture; deployment and producer status belong in `schedules.md` and must be updated from verified receipts.

## Database loading reliability (September 9)

Supavisor's transaction pooler exposed a postgres.js 3.4.8 pipelining failure: bursts of independent reads could leave query promises unresolved while Postgres waited for client input. The application now queues driver execution before creating queries, with one active operation per process. A transaction owns that gate through commit/rollback; its callback must await each statement. A process-global client survives development reloads. Prepared statements remain disabled, idle connections expire after five seconds, and connection lifetime is capped at 60 seconds. This keeps the existing parameterized SQL, restricted DB role, and report contracts.

Queued work and execution share a five-second deadline. A timed-out active operation destroys its connection before the next job. Writes are never automatically replayed; their existing idempotency keys and receipts still govern retries. Short private in-memory caches coalesce simultaneous reads: 60 seconds for monthly reports and 30 seconds for the live snapshot. Authentication still precedes cache access; HTTP responses remain private/no-store. These caches are per process, so publication in another instance can take up to the TTL to appear.

Browser GETs have an eight-second attempt limit and retry a transient failure once. The live view permits only one refresh at a time, cancels on navigation, and displays an error/retry control instead of an endless loading state. Server-Timing exposes data-loading duration, and failure logs contain safe error codes without SQL values or credentials. Regression verification must include repeated mixed-type concurrent query bursts, commit/rollback, idle reconnection, and repeated authenticated endpoint loads—not only a single cold request.

Related upstream report: https://github.com/porsager/postgres/issues/970

Verified against production deployment `[historical deployment ID omitted]` on September 9: 18 concurrent/repeated endpoint reads, including a 35-second idle interval, all returned 200. Warm requests took 91–330 ms; requests after idle took 241–379 ms. The live JSON was 90,829 bytes and monthly JSON 385,628 bytes. Both pages rendered in the browser. The database soak passed 128 mixed read/transaction queries, including rollback and idle reconnection; the full endpoint check also preserved access control, ingestion idempotency, and canonical totals. These are measured verification results, not a latency guarantee.

## Cloud usage scenarios

`usage_calibrations` stores server-derived evidence from explicitly confirmed local-only Claude intervals. Its restricted app role can select, insert, and update only `revoked_at`; public roles have no access. The authenticated, same-origin `/api/usage-calibrations` endpoint accepts sample IDs and confirmation, never client-supplied token coefficients. A partial unique index deduplicates active confirmations; revocation permits a later fresh confirmation of the same interval.

The live endpoint retains quota sample IDs and a small, privately cached calibration list. The cloud estimate and calibration UI are paused; Usage & pace now shows the allowance history and end-of-window forecast directly in each allowance card. The following describes the retained experimental backend support. Deterministic UI calculations reuse the existing hourly and quota arrays. They keep provisional uncollected token-equivalents separate from observed ledgers, use one account-wide allowance scope, and withhold a number when data quality or calibration is inadequate. No estimated buckets are persisted and no new polling job is introduced. See `usage-collection.md` for eligibility and modeling limitations.

Deployment `[historical deployment ID omitted]` passed 34 unit tests, production build/typecheck, restricted-role insertion/deduplication/revocation/reconfirmation in a rolled-back synthetic transaction, API authentication/CSRF/input checks, and browser waiting/calibration-guidance/Windows-setup checks. Observed account totals reconciled against canonical DB revisions including the new Windows source. Six warm production reads took 83–212 ms for 119,591 bytes; no 5xx logs were found for the new deployment during verification. A numeric scenario was verified with fixtures; live Claude estimation still awaits real allowance readings and human confirmation of a baseline.


### Detailed monthly refresh

`/usage` retains the full detailed report UI and `/api/reports` contract. Optional local collector settings invoke the installed Codex/Claude Code analyzers for the current calendar month, preserve machine identities and publish through existing usage-only credentials. Reports carry `collection.period_state` (`partial` or `complete`); the compatibility API preserves that status. Current-month comparisons against complete previous months are suppressed. The browser polls once per visible minute and retains its last successful data on refresh failure.

`scripts/telemetry/detailed_report.py` stores exact pending artifacts and successful fingerprints beside the private connection config. An uncertain upload is retried before reanalysis. Changed content appends an immutable report revision; unchanged analysis is skipped. The prior active month is finalized once after rollover. There is no new database table or migration. This is a bounded personal-use storage choice: at roughly 250 KB uncompressed for two provider snapshots, every hour changing could retain around 180 MB per month before database overhead. Revisit retention or a dedicated replaceable live-snapshot store if source count or payloads grow. Hourly token buckets and monthly report revisions remain independent ledgers.
