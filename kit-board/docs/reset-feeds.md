# Reset-feed sources

## Current configuration — September 13, 2026

NextReset is the primary and only Codex feed provider, using its public
`https://nextreset.net/api/resets` and `https://nextreset.net/api/status` endpoints.
They require no password, API key or cookies. Reset Radar's public Claude feed
remains unchanged. Codex Reset's timeline, announcements and forecast endpoints
have been removed from the fetch allowlist and runtime code; there is no fallback
or periodic retry against that provider. The stale forecast percentage panel and
its forecast-driven announcement banner have also been removed. Announcements
remain available in the calendar/record through NextReset.

New source IDs `nextreset-timeline` and `nextreset-announcements` keep their state
separate from the retired provider. The dashboard serves only active source IDs,
so old 403 errors and old forecast payloads cannot appear as active feed health.
Old immutable snapshots remain stored for historical provenance; no database
records are deleted or relabeled. Normalizer v6 retains scope, credit categories,
original links and timestamps, pending-record safeguards, and coverage warnings.

The two NextReset JSON requests are coalesced within each eligible sync, with the
existing shared 30-minute lease, 15-second timeout, 2 MB size bound, and no redirects
or credentials. There are no retries against a different provider on failure.
The last successful snapshot of an active feed remains visible if it fails.
`tests/nextreset-feeds.test.ts` explicitly verifies the allowed destinations,
rejection of retired source IDs before networking, filtering of retired database
rows, and absence of the retired URLs and fallback labels from runtime code.

### Production verification — September 13, 2026, 13:41 CDT

- URL: `https://personal-observatory-jg.vercel.app/usage/resets`
- Target/status: production, READY; deployment ID omitted from public source.
- Source: base `a472b3b` plus isolated public-feed changes; concurrent unrelated
  working-tree changes were excluded.
- Framework/build: Next.js 16.3.4; remote build-to-ready approximately 31 seconds.
  68 tests passed and three DB integration tests were skipped. The generated
  schema was normalized to LF in the isolated Windows checkout; its JSON content
  was unchanged. Production build and typechecking passed.
- Live POST `/api/reset-feeds`: HTTP 200, request ID omitted from public source.
  Logs show 54 timeline records, 52 announcement
  records and 13 Claude records, with no requests attempted against the retired
  provider. The page shows three available feeds, no fallback label, no 403 warning
  and no stale Codex forecast panel. Archive and direct-review checks are current.
- Private access is unchanged: unauthenticated API GET returned 401 with
  `no-store, private`. Deployment region `cle1` and all three existing cron
  definitions were preserved. A manual verification is not a promise of future
  upstream availability; genuine source freshness warnings remain supported.
- A second button-triggered POST returned 200 with no outbound refresh logs and
  unchanged revision counts, confirming lease reuse. The deployment-scoped
  warning/error log scan returned no entries during verification. No new log
  drain or monitoring subscription was configured.

## Historical recovery — September 12, 2026 (superseded)

September 12, 2026: the production reader received HTTP 403 from Codex Reset's
`/api/timeline` and `/api/feed`, while local requests succeeded. Its forecast and
Reset Radar's Claude feed remained available. This establishes an upstream access
failure, not the precise firewall rule or cause.

The timeline and announcements now try their original public endpoints first,
then use NextReset's documented public `/api/resets` and `/api/status` on failure.
No key, additional service, proxy, browser impersonation or model call is involved.
See [NextReset's API](https://nextreset.net/developers/) and
[source methodology](https://nextreset.net/about/). Its archive was more current
than Codex Reset's Atom feed when evaluated, including the September 12 completion
and September 9 compensation announcement. This is an independent tracker, not an
official OpenAI feed, and some historical data comes from a shared public archive.

Both fallback requests are coalesced within a sync. The existing shared 30-minute
database lease, HTTPS allowlist, redirect rejection, 15-second per-request timeout,
2 MB streaming bound, authentication and same-origin checks remain in place.
Fallback validators never reach the primary origin. The primary is retried on each
eligible sync and automatically resumes when healthy. If both sources fail, the
last successful immutable snapshot remains selected.

Normalizer v5 records the actual fallback provenance and safe primary failure
code. The UI labels NextReset snapshots as NextReset and does not relabel earlier
Codex Reset snapshots. No migration or history deletion is needed. Older normalized
payloads receive one bounded upgrade attempt; failed upgrades keep the normal
retry delay. Feed health shows archive and direct-review check times separately.
NextReset considers checks older than 45 minutes delayed; a freshly fetched archive
does not imply that its independent review of new posts and replies is complete.

Regular history, archive observations, banked credits, mixed announcements and
targeted compensation remain distinct. Only explicitly broad regular resets get
the global classification. Publication/observation time is not an invented account
reset time. Pending records stay announcements even after time passes. If a pending
record's shape is not supported, the UI directs the user to NextReset and warns of
limited coverage instead of inventing an event. Probabilistic watches are not
promises. External feeds never change measured personal allowance windows.

Verification at the time: `tests/reset-feed-fallback.test.ts` covered source failure/recovery,
conditional headers, shared fallback requests, schema/size limits, classification,
pending/partial coverage and attribution. The live feed-refresh request and runtime
logs must also be checked after deployment; local access alone does not establish
that Vercel can reach an upstream source.

## Production verification — September 12, 2026, 15:47 CDT

The production deployment is READY at the existing Observatory alias; its private
deployment ID is omitted. It was built from base `e782d21` plus the isolated reset-feed
changes; unrelated working-tree usage changes were excluded. The build succeeded
and 59 unit tests passed, with one DB integration test skipped. The deployed
configuration retains both daily cron paths and the repository's `cle1` region;
the monorepo deployment explicitly loaded `kit-board/vercel.json`.

The authenticated browser's POST `/api/reset-feeds` logged successful NextReset
timeline (54 items) and announcements (52 items) after primary HTTP 403s, plus 13
Claude entries from Reset Radar; its private request ID is omitted.
Reset Radar. Each recovered feed now has five saved revisions, up from four; the
old history remains stored. The live calendar renders the September 12 completed
rollout and September 9 targeted compensation with original links and distinct
classifications. Both feed-health rows show “available via fallback”.

The combined POST returned HTTP 207 because the separate Codex forecast endpoint
also returned 403 on this run. Its previous 24% / 42% values remain visibly stale;
no replacement probabilities were invented. NextReset's archive check was 15:45
CDT, while its original-post/reply review remained incomplete (last check 12:15
CDT); the UI displays that coverage warning. The deployment-scoped runtime error
scan returned no error-level entries during verification; the forecast warning
is an expected unresolved upstream failure, not an all-feeds-success claim.

A second live button-triggered POST returned 200 with no upstream refresh logs;
revision counts remained unchanged, confirming shared-lease reuse. The Announced
filter rendered 52 entries and excluded the archive-only observation. An
unauthenticated API GET returned 401 with `no-store, private` headers.
