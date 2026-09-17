# USG-013: Reuse pricing and environmental calculations on the unified data

[Backlog index](README.md) · [Direction](../usage-direction.md)

Status: Done
Priority: P0
Scope: Core
Stage: 3. Read models
Dependencies: [USG-001](usg-001-metric-and-source-contract.md), [USG-012](usg-012-unified-filtered-usage-queries.md)
Created: 2026-09-13

## Outcome

Reproduce current API and environmental estimates for equivalent inputs and support honest filtering.

## Current gap

Rich estimates currently arrive through monthly analyzer snapshots or page-local environmental fallback calculations.

## Acceptance criteria

1. Make existing catalog-based API estimation reusable for filtered collected activity, preserving effort/tier/context/cache evidence, catalog version, assumptions, and priced/unpriced coverage.
2. Retain environmental method 2026-08-20.1 factors, threshold, electricity/water/carbon scenarios, comparisons, and the 10% comparable-call reduction scenario.
3. Apply the stable classification unit chosen in USG-001 so filtering does not reclassify unrelated calls; preserve historical snapshot methods and mark incomplete estimation coverage.
4. Do not use API dollars, allowance percentages, or an invented tokens-per-call average to supply missing environmental call evidence. Do not proportionally distribute unsupported historical detail.
5. Return reproducible estimate inputs, units, scenario labels, scope, source links, and method versions to the UI. Keep future methodology changes outside this task.

## Verification

Compare representative current analyzer/fallback outputs, threshold boundaries, mixed methods, no-call evidence, unpriced models, and filtered/unfiltered aggregation. Confirm the requested reuse rather than introducing new physical factors.

Apply the common completion requirements in the [backlog index](README.md). This file is a planned task, not evidence of implementation.

## Starting points

- [app/(private)/usage/page.tsx](<../../app/(private)/usage/page.tsx>)
- [lib/environmental-factors.json](<../../lib/environmental-factors.json>)
- [scripts/telemetry/detailed_report.py](<../../scripts/telemetry/detailed_report.py>)
- [lib/usage.ts](<../../lib/usage.ts>)
- [docs/usage-direction.md](<../../docs/usage-direction.md>)

## Execution record

Completed on `main` on September 15, 2026.

- Decisions: both calculations are reused, not redesigned, and both read the query layer's outputs so every filtered scope prices and estimates the same rows the cards show. `lib/usage-pricing.ts` reproduces the Codex monthly analyzer's `price_token_event` rule by rule (model and alias lookup, the period in force on the event date, tier normalization with `priority` aliased to `fast` after July 30, 2026, the short or long context band from each request's logged input against the threshold of the catalog its model prices under (both thresholds are evaluated in SQL and the band is chosen after the model lookup, so a Cursor row running a Claude model bands on the Anthropic threshold), uncached input at the input rate, cache reads at the cached rate, cache writes at the input rate times the write multiplier, reasoning inside output once, and every unpriced token kept with its reason: `model_not_in_catalog`, `no_rate_for_event_date`, `service_tier_or_context_not_priced`, `legacy_total_only`). `lib/pricing-catalog.json` carries the analyzer's OpenAI catalog verbatim plus a provenance string (`2026-09-13`) beside an Anthropic catalog (`2026-09-14`) written from the public pricing page: list input, cache-hit (0.1x, 0.025x on Fable 5.1 and Mythos 5.1), and output rates per model, 5-minute and 1-hour cache-write multipliers, batch at 50%, fast mode for Opus 5 and Opus 4.8 from the recorded speed, priority priced at list and flagged, flex unpriced; Claude 4.6 and later carry a long band equal to their short band because they bill the full context window at standard rates, while earlier models' requests over 200K input stay unpriced with their reason; dated Claude ids match through aliases and a trailing `-YYYYMMDD` suffix retried against the Anthropic catalog only; the single Anthropic period has no start date, so a request of any date prices at those rates and the assumption says so. Rate periods are chosen by each request's calendar date in America/Chicago (the analyzers' machine-local zone), never by the viewer's display zone. Unpriced rows keep their token columns, as the analyzer's rows do. The estimate returns the analyzer's shape (component costs, by model, by effort, by tier, by dimension, priced/unpriced coverage, assumed-standard and assumed-TTL counts, catalog versions, sources, provenance, assumptions).
- `lib/environmental-estimate.ts` keeps method `2026-08-20.1` unchanged (`lib/environmental-factors.json`, moved out of the page; the page's fallback now calls `legacyEstimateForReport`, which reproduces the analyzer's stored estimate to six decimals). The classification unit is the metric contract's cohort: one account and provider in one source calendar month, classified once from the whole month's average raw tokens per call; a filter sums the cohort's selected calls under that class and never reclassifies. A merged legacy month keeps the analyzer's stored estimate and method version when wholly selected (`source: stored`); when partly selected it keeps the stored class, is computed entirely with the current factors (the stored per-call figure is not reused), and is labeled with the current version (`source: stored_class`); a stored class that is not one of the two factor keys classifies afresh; legacy cohorts stay per report subject, so two subjects mapped to one account never overwrite each other; an open month's class is provisional; a population with zero calls has no class, and its selected calls get no default factor and are disclosed in `coverage.calls_without_class`, never filled from tokens, dollars, or allowance movement; derived comparisons and the 10% reduction come from unrounded sums, as the analyzer computes them. The legacy factor key `reasoning_heavy` is reported as `high_context_per_call`, a workload-size proxy, with the factor key kept beside it.
- Query layer: `pricing_inputs.rows` gained `provider`, `context_band`, and `rate_date`; `environmental_inputs.cohorts` now carries each cohort's whole-month population and selected slice, closed-month flag, and stored estimate; the response adds `cost` (`ApiEquivalentEstimate`) and `environment` (`EnvironmentalEstimate`, with scenario labels, units, factor strings, comparisons, the 10% reduction, the compensation planning quantity, coverage, scope, assumptions, and sources).
- Synthetic coverage: `tests/usage-pricing.test.ts` (catalog identity, OpenAI period/tier/band/cache/reasoning rules, every unpriced reason, the Mac analyzer's stored Opus 5 and Fable 5.1 rows and the Windows analyzer's stored gpt-5.6-sol and gpt-6-astra dimension rows reproduced to six decimals, batch/fast/priority/TTL rules, Claude long band priced for 4.6 and later and unpriced before, dated ids, any-date rates, unpriced rows keeping token columns, aggregation reconciliation and provenance); `tests/environmental-estimate.test.ts` (threshold boundary at 50,000, the Windows analyzer's stored September estimate reproduced to six decimals, whole-cohort classification under a filter, stored legacy months whole and partial, mixed methods, an unclassified population, rounding order, the relabel in the returned assumptions, no-call and missing-cohort disclosure); `tests/usage-query.integration.test.ts` (cost and environment on the mixed fixture, unpriced fixture models with their reason, cohort population versus selection under a project filter, a stored estimate parsed from a snapshot envelope whole and partial, two subjects mapped to one account, the 272,000-token band boundary, and a rate-period boundary event under a UTC display zone).
- Verification on September 15, 2026 (Windows host, Docker Desktop): `npm run typecheck`, `npm run test:db` (14 migrations applied, all integration suites passed), `npm test` (117 tests: 110 passed, six database-gated skips, and the pre-existing schema line-ending assertion that fails on this host only), one review workflow (five finders, three-lens adversarial verification per finding, an acceptance-criteria critic) whose surviving findings were fixed, a second pass that confirmed each fix and its pinning test, and one regression sweep of the fixed modules whose single finding (the context band chosen by provider rather than by the model's catalog) was fixed.
- Remaining, outside this task: Anthropic price history before September 14, 2026 and any later price change need a catalog period added by hand; a closed month's class is recomputed from the retained ledger on each read rather than persisted, so a later backfill into that month can change it (the contract's freeze needs a persisted cohort class, not yet built); the companion does not collect the Codex service tier, so missing tier is counted under `missing_service_tier_calls_assumed_standard` and Codex priority traffic prices at standard until the adapter reads it; better modeling is USG-033.

### Headline bucket pricing (September 16, 2026)

When the headline is hourly buckets, `pricing_inputs` are those buckets rather than request records: model, exclusive composition, the Chicago calendar date of the hour as `rate_date`, assumed Standard, and the short context band (an hour is not one request, so logged input is not compared to the long-context threshold). Request-level effort, tier, speed, cache-write TTL, and per-request context band still apply when a detail filter makes requests the headline. The Tokens cost card therefore estimates from collected hourly activity without waiting for a source price date on each request.
