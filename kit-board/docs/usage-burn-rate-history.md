# Reset-safe burn-rate history

This note organizes the Usage & pace page around three questions:

1. **What happened?** Hourly aggregate token activity from all collectors.
2. **Can I keep going?** Current allowances, current-window usage and a burn-rate forecast informed by both live and historical windows.
3. **How does each model behave over time?** Persisted, reset-aware model/window graphs expressed in allowance percentages and percentage-point pace, not token totals.

The recommendation is to keep token activity and allowance usage as separate ledgers, make an allowance cycle a durable first-class record, and carry a historical prior into each new cycle. A reset should select a new active cycle; it should never erase the cycles used to inform the next forecast.

This is a product and data-model note, not an implementation record. It builds on the current [usage collection contract](usage-collection.md), [telemetry schema](../supabase/migrations/20260909184129_usage_telemetry_and_reset_feeds.sql), [live telemetry reader](../lib/telemetry-store.ts), and [allowance forecast](../lib/telemetry-contract.ts).

## Current-state gap

- The durable token ledger already includes `model`, and the live reader returns canonical hourly totals for the last 35 days.
- Allowance observations are also durable. The live reader now exposes the last 35 days so the first reset-spanning UI can use existing evidence; an explicit long-term cycle-history contract remains future work.
- The current allowance estimator correctly refuses to bridge reset-anchor changes, percentage decreases or gaps over three hours. It uses at most 24 hours from the active cycle, requires 30 minutes of evidence and suppresses stale projections after two hours.
- The current page has aggregate token activity and current-window cards. It does not yet expose completed allowance cycles, a historical forecasting prior or reset-aware per-model allowance history.

The design below preserves those conservative accounting rules while adding the missing historical layer.

### Implemented first slice — 2026-09-12

The current UI now uses the existing ledgers without a schema migration:

- `/usage/live` is organized into hourly activity, current allowances and model history.
- The live query exposes 35 days of both hourly and allowance observations.
- Allowance samples are partitioned into reset-bounded cycles in application code. Up to eight usable completed cycles seed a new window; the estimate blends toward live pace during the first 10% of a window, bounded to one–six hours.
- The model-history view shows 30 days of provider-observed allowance-point changes plus each model's share of calls and active hours for the selected account. It does not assign pooled allowance percentages to models.

The durable `allowance_cycles` entity, explicit scope metadata and longer-term aggregate retention described later in this note remain follow-up work.

## Recommended page structure

| Section | Primary question | Main unit | Default view |
| --- | --- | --- | --- |
| Hourly activity | What work happened, and when? | Tokens and calls per UTC hour | Aggregate stacked activity across collectors, with model/account filters |
| Current allowances | Will the allowance last until reset? | Percent used/remaining and percentage points per hour/day | One card per account + allowance scope + window |
| Burn history | What is normal for this model/window? | Percent used over normalized window time; percentage points per hour/day | Model/window small multiples with prior cycles, current cycle and forecast |

The three sections should share account, provider and time-range controls, but not share arithmetic. Token totals explain observed local activity. They do not define subscription capacity.

### 1. Hourly activity

Keep this as the aggregate collector view already implied by `token_bucket_revisions`:

- Sum canonical revisions by UTC hour after choosing the nonregressing revision for each account/session/hour/model.
- Zero-fill idle hours so a quiet hour is visibly different from a missing hour.
- Distinguish the current partial hour from complete hours.
- Default to all collectors, then allow provider, account, model and source drill-down.
- Show ingestion health beside the chart: last collector observation, unavailable roots, malformed rows and uncovered intervals.
- Keep calls and the exclusive input/cache-write/cache-read/output composition available in the tooltip or secondary view.

CLIProxyAPI's usage records contain provider, concrete model, requested alias, auth identity, source, request time, latency, failure and detailed token fields, so its event shape is a useful checklist for future collector dimensions. It also defines a canonical non-overlapping token breakdown with explicit `complete`, `inconsistent` and `unclassified` quality states. Those ideas support adding accounting-version and quality metadata instead of silently summing ambiguous provider-native fields. ([usage record](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/sdk/cliproxy/usage/manager.go#L21-L80), [token accounting contract](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/sdk/cliproxy/usage/accounting.go#L5-L75))

CPA Usage Keeper, the separate service recommended by CLIProxyAPI, similarly persists usage and pre-aggregates hourly rows keyed by model and other request dimensions. That validates the general raw-events-plus-rollups shape, though the Observatory should retain its existing revision-based collector accounting rather than adopt Keeper's request ingestion model. ([CLIProxyAPI recommendation](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/README.md#L137-L147), [Keeper hourly aggregate](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/internal/entities/usage_overview_hourly_stat.go#L5-L29))

### 2. Current allowances and burn rate

Each card represents one stable allowance scope:

`account + scope kind + scope key + provider window key + window duration`

Examples of scope are an account-wide five-hour window, an account-wide weekly window, or a provider-reported model-specific window. The card should show:

- observed percent used and remaining;
- provider reset time and time remaining;
- current measured burn in percentage points per hour or day;
- historically informed burn when the new cycle lacks enough live samples;
- projected use at reset and estimated exhaustion time;
- available sustainable pace until reset;
- forecast source and confidence: `historical`, `blended`, `current window`, `stale` or `unavailable`;
- a trajectory chart with recorded usage, historical expectation, projection and the even-pace guide.

The current implementation intentionally starts a fresh segment when the reset anchor changes, usage decreases or observations have a long gap. It requires at least 30 minutes of usable history and uses at most 24 hours from the current cycle. Preserve those safeguards for the live component of the estimator. The missing piece is a historical prior, not looser validation.

One reasonable first estimator is:

```text
live_rate = (latest used% - earliest eligible used%) / elapsed hours

historical_rate = robust weighted median of matching completed cycles
                  at the current normalized phase of the window

displayed_rate = live_weight * live_rate
               + (1 - live_weight) * historical_rate
```

`live_weight` should start at zero, increase with continuous observation time and coverage, and reach one only after enough current-window evidence. At the first reading after a reset, a matching historical prior can therefore produce a labeled estimate. With no usable live segment and no comparable completed cycle, the correct result remains unknown.

Comparable history should match provider, account or plan where relevant, scope kind/key, window key and window duration. Use recent completed cycles, decay older evidence, and report the sample count and spread. Do not let a prior cross an account, plan, model scope or materially different window duration merely to avoid an empty value.

### 3. Persisted model/window burn graphs

The default historical chart should use:

- **x-axis:** normalized window elapsed, `0%` at `reset_at - window_duration` and `100%` at reset;
- **y-axis:** provider-observed percent used, `0–100%`;
- **slope:** percentage points per hour/day;
- **series:** one model-scoped allowance and window at a time, with completed cycles as faint lines or a percentile band and the active cycle emphasized;
- **markers:** resets, collection gaps, corrections and forecast start;
- **summary:** median burn, recent range, cycle count and percentage of cycles exhausted before reset.

Normalized window time makes different cycles comparable even when their wall-clock start dates differ. Wall-clock mode can remain available for diagnosis, but it is not the best default for learning whether a model/window is burning faster than usual.

Only build a per-model allowance series when the provider or collector supplies a model-scoped quota observation. CLIProxyAPI exposes timestamped credential quota observations and optional `model_quotas`, which demonstrates that model-scoped signals can exist. It also keeps quota observations distinct from cooldown/scheduler state. ([auth response fields](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/internal/api/handlers/management/auth_files.go#L336-L356), [quota payload boundary](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/internal/api/handlers/management/auth_files.go#L479-L516))

If a provider reports only an account-level allowance, do not allocate its percentage decline to models in proportion to token volume. That would create false precision because allowance consumption is not established as a linear token conversion. In that case, section 1 can still show per-model token activity while sections 2 and 3 remain account/window scoped.

An honest pooled-window fallback is **model activity during window burn** rather than “model burn.” For each completed allowance cycle, show each model's share of successful calls and share of active hours, with the account-level allowance curve behind it for context. Those are non-token usage measures already supported by the hourly collector facts, but they must be labeled as correlation, not as the percentage of allowance consumed by that model. An allowance transition may be associated directly with a model only when that model was the sole observed activity in the interval; mixed-model intervals stay labeled `mixed` instead of being proportionally divided.

## Reset-safe persistence model

The existing `quota_samples` rows already preserve `observed_at`, `used_percent`, `resets_at` and `window_minutes`, but the live reader currently loads only a recent horizon and the forecast treats a changed reset anchor as a new in-memory segment. Add a durable cycle identity rather than widening one query indefinitely.

### Allowance cycle

Suggested fields:

```text
id
account_id
scope_kind              account | model | model_group
scope_key               stable provider model/group key; empty for account
window_key
window_minutes
window_started_at
resets_at
reset_at_source         absolute | relative
first_observed_at
last_observed_at
status                   derived current | completed
```

Suggested uniqueness is the stable scope plus window duration and a canonical reset boundary. Preserve each sample's original reset value and source even when the canonical cycle boundary is corrected.

Keeper's useful design is a parent quota-cycle row keyed by provider, auth identity, quota key, window duration and reset time, with child percentage segments that retain remaining percentage, first/last observation and observation count. Reset time is part of the cycle identity, so subsequent resets create additional rows instead of replacing history. ([cycle entity](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/internal/entities/quota_cycle.go#L13-L29), [percentage segment](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/internal/entities/quota_percent_segment.go#L5-L15))

Keeper also matches reset times within a bounded two-minute tolerance and can upgrade a relative reset boundary to a later authoritative absolute one. Borrow the idea of bounded reset-anchor reconciliation, but choose and test the Observatory's tolerance against its actual providers rather than copying two minutes as a magic constant. ([matching and tolerance](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/internal/repository/codex_quota_history.go#L279-L318), [boundary upgrade](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/internal/repository/codex_quota_history.go#L407-L430))

### Allowance observations

Continue to treat immutable observations as truth. Add or derive:

```text
cycle_id
scope_kind
scope_key
reset_at_source
sample_quality
```

Keep `source_id`, `content_hash`, the exact observation time and the provider values already stored. Percentage segments or chart rollups may be materialized for speed, but they should be rebuildable from observations.

Within one cycle, accepted used percentage should normally be monotonic nondecreasing. A decrease means one of four things: a reset/new cycle, a provider correction, conflicting sources or a malformed observation. Do not silently turn it into negative burn. Store the event, mark the discontinuity, and require authoritative evidence before rewriting the canonical series.

### Historical profile

For low personal-use volume, historical priors can initially be computed from completed cycles. If query cost grows, materialize a rebuildable profile keyed by the same matching dimensions:

```text
completed_cycle_count
phase_bin                  e.g. 0–5%, 5–10%, ... of elapsed window
median_used_percent
p25_used_percent
p75_used_percent
median_points_per_hour
last_rebuilt_at
```

Persist observations and completed cycles indefinitely or with an explicit retention policy. If raw samples are eventually compacted, retain cycle summaries and phase-bin aggregates so resets never erase the forecasting prior.

## What to borrow from CLIProxyAPI and Keeper

CLIProxyAPI itself is a source and schema reference, not a historical database. Its current README says built-in usage statistics were removed in v6.10 and recommends separate persistence tools. Its management usage endpoint pops records from a queue; queue retention defaults to 60 seconds, is capped at one hour, and subscriber overflow closes the subscriber. The Observatory must therefore continue ingesting into its own durable ledger and expose collector gaps rather than treating the proxy as recoverable history. ([usage endpoint](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/internal/api/handlers/management/usage.go#L23-L42), [retention bounds](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/internal/redisqueue/queue.go#L9-L12), [subscriber behavior](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/internal/redisqueue/queue.go#L141-L159))

The current proxy does provide useful allowance inputs. Its normalized quota contract includes grouped quota buckets with window, remaining fraction and reset time, plus a server clock offset, while passive Codex/Claude observations keep the newest response snapshot instead of merging stale watermark headers. ([normalized quota types](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/sdk/pluginapi/types.go#L1518-L1609), [fresh-snapshot behavior](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/sdk/cliproxy/auth/quota_signals.go#L15-L53)) Its quota fetch is capability-dependent and can return `501` when neither a plugin nor credential probe is available, so `unsupported` must be a normal UI state rather than an error disguised as zero allowance. ([quota fetch fallback](https://github.com/router-for-me/CLIProxyAPI/blob/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d/internal/api/handlers/management/plugin_quota.go#L57-L130))

Keeper is valuable as a design reference because it explicitly separates persistent analytics from the proxy and offers SQLite storage, scheduled backups, filters, trends, hourly heatmaps and quota views. ([Keeper purpose and features](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/README.md#L28-L28), [features](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/README.md#L69-L80)) Its quota-history response distinguishes current/completed cycles, actual cycle bounds, observed bounds and real adjacent percentage transitions. That structure maps well to reset-safe history. ([history response](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/internal/quota/codex_quota_efficiency.go#L29-L105))

Do not copy Keeper's principal efficiency metric unchanged. It correlates usage events between allowance transitions and reports tokens per percentage point, then extrapolates settled transitions to a full 100% cycle. That is useful for its gateway context, but the requested Observatory graph should remain directly in observed window usage and percentage-point pace. Tokens belong in section 1, not as an inferred allowance denominator. ([Keeper chart metric](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/web/src/components/usage/credentials/CodexQuotaHistoryPanel.tsx#L437-L475), [chart series](https://github.com/Willxup/cpa-usage-keeper/blob/885a671dbf5c48d2a10be935da67f9e6c5afbca1/web/src/components/usage/credentials/CodexQuotaHistoryPanel.tsx#L730-L840))

## Forecast and graph states

The page should render absence and uncertainty explicitly:

| State | Meaning | Display behavior |
| --- | --- | --- |
| Current, measured | Fresh current-cycle observations meet live thresholds | Emphasize live rate; retain historical band as context |
| Current, blended | Some current evidence and a matching prior | Show blended forecast and both evidence counts |
| Historical seed | Fresh reading but insufficient live duration | Show labeled prior-based estimate, never call it measured |
| Learning | No comparable prior and insufficient live evidence | Show current allowance and reset, with no burn number |
| Stale | Latest reading exceeds freshness threshold | Freeze chart at observation time and suppress active projection |
| Discontinuous | Gap, decrease, conflict or reset ambiguity | Split the line and explain why the rate is withheld |
| Unsupported | Collector/provider cannot supply this scope | Keep token activity available; do not show a zero allowance |

Refreshes must remain anchored to the latest observation. Merely opening the page must not make the forecast appear more certain or advance the projected usage.

## Delivery sequence

1. Reorganize the live page into the three sections using existing aggregate tokens and current allowance cards.
2. Add durable allowance cycles and multi-cycle queries; keep all existing samples and backfill cycles deterministically.
3. Add historical priors and `historical`/`blended`/`measured` forecast provenance.
4. Extend the collector contract with explicit allowance scope fields only when real provider data supports them.
5. Add model/window history small multiples and long-range cycle aggregates.

## Acceptance criteria

- A changed reset anchor creates a new active cycle while prior cycles remain queryable.
- The first fresh reading in a new cycle can show a historical estimate when comparable completed cycles exist.
- Forecast output identifies whether it is historical, blended or current-window measured.
- No allowance percentage or per-model burn is inferred from token totals.
- Per-model allowance graphs appear only for genuinely model-scoped quota readings.
- Idle token hours are zero-filled; collection gaps are marked rather than zero-filled as activity.
- Stale, discontinuous and unsupported quota states are distinct from zero usage.
- Historical charts retain completed cycles beyond the current live-query horizon.

## Source check

External source behavior was checked on 2026-09-12 against CLIProxyAPI commit [`ac02da6`](https://github.com/router-for-me/CLIProxyAPI/tree/ac02da6c05e18f465aa7e3ed5b0a65a2f060917d) and CPA Usage Keeper commit [`885a671`](https://github.com/Willxup/cpa-usage-keeper/tree/885a671dbf5c48d2a10be935da67f9e6c5afbca1). Recommendations and estimator policy in this note are Observatory design proposals, not features claimed to exist in either upstream project.
