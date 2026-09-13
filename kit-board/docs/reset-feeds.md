# Reset-feed recovery

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

Verification: `tests/reset-feed-fallback.test.ts` covers source failure/recovery,
conditional headers, shared fallback requests, schema/size limits, classification,
pending/partial coverage and attribution. The live feed-refresh request and runtime
logs must also be checked after deployment; local access alone does not establish
that Vercel can reach an upstream source.

## Production verification — September 12, 2026, 15:47 CDT

Production deployment `dpl_5FnYVqBxnXJGjfDPvXWAy2Tga5EK` is READY at the existing
Observatory alias. It was built from base `e782d21` plus the isolated reset-feed
changes; unrelated working-tree usage changes were excluded. The build succeeded
and 59 unit tests passed, with one DB integration test skipped. The deployed
configuration retains both daily cron paths and the repository's `cle1` region;
the monorepo deployment explicitly loaded `kit-board/vercel.json`.

The authenticated browser's POST `/api/reset-feeds`, request
`mjq56-1789246050722-91579dda8959`, logged successful NextReset timeline (54 items)
and announcements (52 items) after primary HTTP 403s, and 13 Claude entries from
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
