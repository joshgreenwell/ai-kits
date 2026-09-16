# USG-012: Build one filtered usage query layer with explicit coverage

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P0
Scope: Core
Stage: 3. Read models
Dependencies: [USG-004](usg-004-collect-request-and-pricing-evidence.md), [USG-005](usg-005-collect-agent-lineage.md), [USG-006](usg-006-collect-tool-invocations.md), [USG-007](usg-007-map-project-identities.md), [USG-008](usg-008-collect-knowledge-source-access.md), [USG-011](usg-011-reconcile-historical-ledgers.md)
Created: 2026-09-13

## Outcome

Serve all Tokens cards from a consistent selected scope without a monthly publishing dependency.

## Current gap

Monthly report and live endpoints use separate pipelines and cannot currently supply the full requested filters and breakdowns together.

## Acceptance criteria

1. Provide common period/account/project/provider/model/effort/machine/surface/agent filters, with OR-within/AND-across semantics, explicit Unknown/unfilterable handling, half-open time ranges, full-bucket inclusion, and bounded query behavior.
2. Return canonical total/composition, overall and model time series, pricing inputs, project/agent/tool/resource summaries, eligible call evidence, and per-section coverage/provenance.
3. Keep request events and coarser fallback history mutually reconciled; preserve provider event/query-profile identity, crosswalk monthly subjects to logical populations, prefer complete revisions for closed months, and explain unsupported filters and historical resolution instead of silently returning unfiltered monthly figures.
4. Use observation time and mark partial intervals, true zeros, missing data, unknown dimensions, and unavailable estimates. Counts and shares state their denominator.
5. Preserve private authentication, no-store behavior, database queue serialization, timeouts, cache boundaries, and error/retry behavior under a realistic history size.

## Verification

Use a mixed old/new synthetic history and intersecting filters; reconcile all disjoint breakdowns to canonical totals, test time boundaries/DST, and exercise authenticated bounded concurrent reads.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/api/usage-v2/route.ts](<../../app/api/usage-v2/route.ts>)
- [app/api/usage-live/route.ts](<../../app/api/usage-live/route.ts>)
- [app/api/reports/route.ts](<../../app/api/reports/route.ts>)
- [lib/usage-store.ts](<../../lib/usage-store.ts>)
- [lib/telemetry-store.ts](<../../lib/telemetry-store.ts>)
- [lib/database-queue.ts](<../../lib/database-queue.ts>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Completed on `main` on September 14, 2026.

- Decisions: one read serves every Tokens card. `GET /api/usage-query` (`app/api/usage-query/route.ts`, session-authenticated, `private, no-store`) parses a query string into `usageQuerySchema` (`lib/usage-query.ts`): a preset or custom half-open range resolved at America/Chicago boundaries (`lib/usage-periods.ts`; presets `today`, `last_7_days`, `last_30_days`, `month_to_date`, `previous_month`, `custom`; at most 400 days, hourly resolution up to 14 days; daylight-saving days keep their 23- or 25-hour length), and list filters for accounts, providers, models, efforts, machines (the observing collector's source), surfaces, projects (registry ids plus `no_project`, `unassigned`, `unknown`), agent scope, and agent keys. Values within a dimension OR, dimensions AND; `unknown` is selectable and named values exclude it. Canonical hourly buckets (most calls, then most tokens, then newest revision, whichever source published it) are the headline token, call, and conversation authority for every slice; a bucket counts only when wholly inside the range, except the current hour while the range is anchored to now, and buckets straddling a custom end are excluded and counted, never prorated. A filter on a dimension only request detail carries (effort, surface, project, agent scope, agent) switches the headline to the covered request detail, reports `unfilterable_tokens` and `unfilterable_calls` for the bucket population it could not examine, and never treats them as matches. Request rows are canonical per semantic key by channel rank and never add to buckets. Monthly snapshots are historical fallback only: `usage_report_subjects` (`20260914040000_usage_report_subjects.sql`, `GET/PUT /api/usage-report-subjects`) maps a report subject to an account and, optionally, the IANA zone its calendar days used; a snapshot merges as a whole month when the hourly ledger has nothing for that account and month and the whole month is selected, or by whole source days when the zone is known, and otherwise is listed with the reason (`subject_not_mapped`, `hourly_ledger_covers_month`, `filters_unsupported_by_snapshot`, `source_timezone_unknown_whole_month_only`, `source_timezone_differs_from_display`, `no_whole_source_day_in_range`, `hourly_resolution_unsupported`). Closed months prefer a complete revision, open months the newest. Revisions of one request, and of one tool invocation, are ranked over a window widened by a week on each side before the exact range, model, and machine filters apply, so a filter can never select a non-canonical revision; a straddling bucket at either range edge is counted and disclosed; a request-detail shortfall against the buckets is reported as `uncovered_request_tokens` rather than clamped.
- Response: scope (range, selected accounts, applied filters, which are detail filters), headline (total, calls, conversations, exclusive composition with reasoning as an output subset and an unclassified remainder, basis, unfilterable and snapshot amounts, last observation), series points with `observed` / `zero` / `missing` / `partial` states (zero only where an account's collectors had scanned past the interval) and their sources, tokens by model with shares, per-model series, pricing inputs (model, effort, tier, speed, context window, cache-write TTL, token state) with price coverage, project rows by registry state with evidence and mapping coverage, agent rows and main/subagent/unattributed summary with observed children and spawn attempts, tool invocations by tool, caller, and outcome with caller and outcome coverage, knowledge-source rows with overlap disclosed, environmental cohort inputs (account and source month: calls, raw tokens, average per call) for USG-013, historical snapshots with their merge decision, request-detail coverage, and `unsupported` and `notes` lists. Every coverage states headline, eligible, and classified quantities in its unit.
- Boundaries preserved: authentication and no-store through the shared route helpers; every read goes through the serialized database queue (`lib/db.ts` now also gates `unsafe`, which the module uses for positional-parameter text, values always bound); bounded output (at most 400 daily or 336 hourly points, grouped rows only); a 30-second bounded cache of at most 32 scopes; unknown accounts and machines answer 404, invalid ranges 400.
- Synthetic coverage: `tests/usage-periods.test.ts` (spring-forward 23-hour and fall-back 25-hour days, preset boundaries, clamping, bounds, clipped periods) and `tests/usage-query.integration.test.ts` (mixed v1/v2 history with a more complete companion revision, requests with project, agent, effort, and surface detail plus a duplicate revision, agent lifecycle events, duplicate tool revisions with a result, a vault access, and July snapshots for a mapped and an unmapped subject: headline, composition, series, and model reconciliation; project, effort, surface, agent, model, account, provider, and machine filters with OR-within and AND-across; explicit Unknown; hourly bound; whole-month, whole-day, unknown-zone, and covered-month snapshot decisions; presets anchored to now).
- Verification on September 14, 2026 (Windows host, Docker Desktop): `npm run typecheck`, `npm run test:db` (14 migrations applied, all integration suites passed), `npm test` (99 passed; the pre-existing schema line-ending assertion fails on this host only), one focused review.
- Remaining, outside this task: the report-subject crosswalk has no Settings surface yet (map subjects through `PUT /api/usage-report-subjects` until USG-015's follow-up adds one), so production snapshots are listed and not merged until mapped — the migration and routes reached production on September 16 under USG-025, so that call now works there; conversations under the bucket basis are distinct canonical sessions, which USG-017 should label as such; concurrent-read load beyond the queue and cache bounds was not separately soaked.
