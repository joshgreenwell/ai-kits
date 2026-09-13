# Usage metric and source contract

Decided: September 13, 2026

Status: Product and accounting contract for the Usage redesign. This records metric meanings, source precedence, filters, coverage, and initial display choices. It does not change a collector, schema, database, schedule, or interface.

Read this with the [redesign direction](usage-direction.md), [current-system audit](usage-system.md), and [coverage matrix](usage-coverage.md). Domain terms are summarized in [Personal Observatory language](../CONTEXT.md).

## 1. Accounting principles

1. One logical fact is counted once. A revision, mirror, retry, streaming update, tool result, or richer representation does not create additional usage.
2. Execution activity, provider account aggregates, allowances, actual money, public reset claims, API-equivalent estimates, and environmental estimates are different measurement families. They can be shown together but are never added merely because they share an account or time range.
3. Finer detail replaces a coarse total only after collection explicitly establishes complete coverage for the same coverage slice and the quantities reconcile. Until then, the coarse canonical total remains the total and finer records describe their covered subset.
4. Unknown is distinct from zero. No project is distinct from an unknown project. Unattributed measured usage remains in the total.
5. Observation time determines the selected period. Receipt, publication, and page-refresh times describe freshness and delivery only.
6. Every derived number carries its input scope, eligible and excluded coverage, method or catalog version, and assumptions.
7. Reasoning tokens are part of output tokens. They can be displayed as an output subcategory and are never added to output again.
8. Use a source-reported total when it exists. Otherwise derive a total only when every exclusive component is known. If known components exceed a reported total, mark the fact inconsistent and withhold its composition rather than clamping a component or inventing a remainder.
9. Attribute request activity at `ended_at ?? started_at ?? observed_at`. All selected ranges are half-open `[start, end)`. Receipt and publication times never move activity between periods.

## 2. Metric dictionary

### Execution and tokens

| Metric | Definition | Unit and counting rule |
| --- | --- | --- |
| Observed total tokens | The source-reported total for canonical execution activity when available; otherwise the sum of all known exclusive components only when the component set is complete. | Tokens. Never replace a reported total with a partial component sum. |
| Fresh input tokens | Input that the source does not identify as a cache read or cache creation/write. | Tokens. Provider normalization must prevent overlap with the other input classes. |
| Cached input tokens | Input served from a provider cache. | Tokens. It remains part of workload volume even when priced differently. |
| Cache-write input tokens | Input recorded as creating or writing cache content. | Tokens. It is exclusive of fresh and cached input. |
| Output tokens | All output reported by the source. | Tokens. Includes reasoning when the source reports reasoning as an output subset. |
| Reasoning tokens | The supported subset of output identified as reasoning. | Tokens. Never added to total tokens separately. |
| Unclassified tokens | The nonnegative remainder `reported total - known normalized exclusive components`. | Tokens. Visible in composition and included once. A negative remainder makes composition inconsistent and unavailable; it is never clamped to zero. |
| Model call | One model response with explicit usage evidence, including an explicit zero-usage response. | Count. Streaming fragments, cumulative counters, mirrors, and retries for that response are one call. |
| Successful model call | A model call with explicit completed/success evidence. | Count. Lack of an observed error is insufficient; unsupported outcome remains Unknown. |
| Aggregate request count | A provider-reported request count without stable request identities. | Count at the provider's declared resolution. It does not create identifiable model calls or conversations. |
| Conversation | One distinct root provider session/thread containing at least one selected canonical model call. | Distinct count. Child-agent sessions roll up to the root. Synthetic root identity counts only when its derivation is stable and disclosed. |

A failed request with no model-usage evidence is not a model call. A failed or cancelled request with reported model usage is one model call and retains its outcome. Provider account APIs may report a request count without request identities; that is an aggregate request measure, not a set of observed conversations.

### Tools and agents

| Metric | Definition | Unit and counting rule |
| --- | --- | --- |
| Reported tool invocations | Distinct observed model-issued protocol instructions to execute a tool. | Count one stable invocation identity. Do not count outputs, progress messages, ingestion retries, or internal subprocess/wrapper operations; separately model-issued child invocations count when they have distinct identities. |
| Successful tool invocations | Reported tool invocations with explicit successful completion evidence. | Count. Absence of a recorded error is not success unless the source contract says completion is explicit. |
| Failed tool invocations | Reported tool invocations with explicit failure, denial, cancellation, or interruption evidence. | Count, with the supported outcome retained. |
| Tool caller | The model call or agent identity that issued the invocation. | Attribution. Unknown when no reliable join exists. |
| Agent spawns | Distinct observed attempts to create a child agent. | Count spawn-event identities. A rejected spawn can count here without becoming an observed child. |
| Observed subagents | Distinct child identities supported by a child transcript, child request, or explicit start lifecycle event. | Distinct count. Resume/notification events do not create another child. |
| Subagent tokens | Canonical execution tokens attributed to observed child identities. | Tokens. A breakdown of observed total tokens, never an addition to it. |
| Parent-created relationship | The explicit parent agent or conversation recorded for a child. | Attribution. It does not reveal whether the user or model chose to delegate. |

“Top tools” ranks tool identities. “Top callers” ranks the agents or models that issued the invocations. These are separate views.

### Projects and knowledge

| Metric | Definition | Unit and counting rule |
| --- | --- | --- |
| Project tokens | Canonical execution tokens whose stable native or local project identity maps through the project registry to a named project. | Tokens and share of the selected canonical total. Machine paths and worktrees may map to one project. |
| Unassigned-project tokens | Activity with stable project/path identity but no registry mapping. | Tokens. This is evidence-present but mapping-missing, separate from Unknown and No project. |
| No-project tokens | Activity for which a source explicitly states that no project applies. | Tokens. Separate from unknown. |
| Unknown-project tokens | Activity without sufficient project evidence. | Tokens. Included in the overall total and attribution denominator. |
| Knowledge accesses | Tool invocations whose recorded resource identity or supported argument resolves against the versioned knowledge-source configuration active at the event time. | Per-source invocation count. Working context may resolve a relative path but is not access by itself. One invocation can access several sources, so per-source counts may overlap. |
| Knowledge-access sessions | Distinct conversations containing at least one supported access to the source. | Distinct count. |
| Knowledge-access agents | Distinct known agent identities containing at least one supported access. | Distinct count. Unknown callers remain visible. |

Starting a conversation inside an Obsidian vault is contextual evidence, not proof that every invocation accessed the vault. Reading or searching a source proves access; it does not prove the final answer used the material.

### Allowance, money, and estimates

| Metric | Definition | Unit and counting rule |
| --- | --- | --- |
| Current allowance | The newest eligible provider observation for one account, meter, scope, duration, and reset boundary. | Provider unit, commonly percent used/remaining. Different windows are never summed. |
| Burn rate | Change in the same allowance meter divided by elapsed time within one reset-safe segment. | Percentage points/hour or the provider meter's native unit/time. Not tokens/hour. |
| Token velocity | Canonical observed tokens divided by complete elapsed clock intervals. | Tokens/hour or tokens/day. Distinct from burn rate. |
| Actual money | Provider-reported charges, credits, grants, or invoice facts. | Original currency/credit unit. Entries retain their kind and are not combined with estimates as spend. |
| API-equivalent estimate | Price of eligible observed execution tokens under one versioned catalog. | Currency. Report priced and unpriced token coverage. It is not a bill or subscription cost. |
| Environmental scenario estimate | Modeled operational electricity, direct water, or carbon under one versioned methodology and scenario. | kWh, liters, or kg CO2e. It is not datacenter telemetry or a completed offset. |

## 3. Synthetic scenarios

### One streamed response with a tool

A model streams three updates, reports final usage once, issues tool invocation `t1`, receives one result, and then makes a second model response that consumes the result.

- Model calls: 2.
- Tool invocations: 1.
- Successful tool invocations: 1 only if the result explicitly indicates success.
- Tool results: 1, but it is not another invocation.
- The usage updates for the first response are revisions of one call, not three calls.

### Spawn attempt and child resume

The parent issues spawn `s1`. Child `a1` starts, makes four model calls, pauses, and later resumes for two more calls. A second spawn `s2` is denied before a child exists.

- Agent spawns: 2.
- Observed subagents: 1 (`a1`).
- Child model calls: 6.
- Child tokens remain part of the overall execution total.
- The source does not establish whether the user or model requested either spawn unless it records that fact explicitly.

### Project states

Ten calls belong to mapped working directories for Project Atlas, two carry stable but unmapped path identities, two explicitly have no project, and three old calls carry no working-directory or native-project evidence.

- Project Atlas receives the tokens from its ten calls.
- Unassigned project receives the tokens from two calls and reports missing registry mapping.
- No project receives the tokens from two calls.
- Unknown project receives the tokens from three calls.
- The project card reports evidence coverage and registry-mapping coverage separately.

### Coarse and detailed overlap

One hourly bucket reports 10 calls and 100,000 tokens for an account/session/hour/model. Request detail contains eight calls and 82,000 tokens because two source records have not been backfilled.

- Headline total: 100,000 tokens and 10 model calls from the bucket.
- Observed request-detail availability: 82% by tokens and 80% by calls. Request replacement readiness is 0% because the slice has not been declared complete and reconciled.
- Project, agent, and tool views cover only their supported detailed subset and show an 18,000-token/2-call unattributed remainder where applicable.
- The page never reports 182,000 tokens.

After the collector marks that exact coverage slice complete and ten canonical requests reconcile to 100,000 tokens, detailed requests may replace the bucket as the token source for that slice. The bucket remains preserved evidence.

### Provider aggregate and local overlap

An organization API reports 1,000,000 API tokens for a day. Local SDK logs report 200,000 tokens from the same organization but provide no provider request IDs that join the records.

- The provider aggregate is the canonical organization-usage total.
- Local detail can be labeled as observed local coverage of that aggregate, but the two quantities are not added.
- Its projects/tools cannot be extrapolated to the remaining 800,000 tokens.

## 4. Source families and precedence

Precedence is applied within a measurement family and coverage slice. It is not a global preference that allows one ledger to overwrite another.

### 4.1 Execution activity

The logical coverage slice for execution activity is:

`usage account + provider/product population + execution session or request identity + [start, end) + actual model + native dimension set`

Collector binding, observing machine, adapter, and receipt are provenance. They do not make mirrored activity distinct. Execution machine is a dimension only when it identifies genuinely separate activity. Keep logical execution population/report subject separate from the collector that observed or replayed it so a collector filter cannot resurrect a duplicate.

1. Canonicalize hourly bucket revisions by `account + session + UTC hour + model`: prefer the greatest call count, then greatest total tokens, then newest observation/receipt. This matches the current nonregressing snapshot rule.
2. Canonicalize request revisions by stable semantic request identity. For the same logical request, request-level provider evidence outranks app-server evidence, which outranks local file/database evidence for provider, model, and token facts. A higher-ranked null does not erase a supported lower-ranked detail field. Basis labels describe quality and are not a universal source ranking.
3. Use explicit local transcript/agent/tool evidence for project, agent, tool, and knowledge dimensions when the higher-ranked token source lacks those dimensions and a stable join proves it is the same request. Retain field-level provenance and expose conflicts rather than choosing silently.
4. Hourly buckets remain the headline token/call authority for a slice until a collection manifest or cursor declares that exact slice complete and its canonical request totals reconcile. Equality alone does not establish completeness. Request rows power only their eligible detail before that point.
5. Once complete and reconciled, requests can replace the bucket for that slice. Never add the two representations. Keep both source records and the coverage decision.

A copied or mirrored session does not become new usage. Conflicting lower token totals do not reduce a previously canonical nonregressing bucket automatically; corrections require explicit reconciliation evidence.

### 4.2 Provider account aggregates

Canonicalize by account scope, report source, half-open bucket start/end, provider query/grouping profile, full dimension tuple, and the adapter-declared meaning of `provider_event_id`. An adapter must say whether that identifier names a disjoint event or only a revision. Prefer the provider's newest refresh/correction for that complete identity.

Provider aggregates are the total authority for their declared organization/API product scope. Local request evidence is a coverage/detail subset when stable provider identifiers establish overlap. Without such a join, show the quantities separately or select the provider aggregate for the total and label the local detail as non-additive observed coverage.

An individual-plan execution stream and an organization API stream may be added only when account/product scope establishes that they are disjoint. The query layer must record that decision; matching provider names alone are insufficient.

### 4.3 Monthly detailed snapshots

First map report subject/machine/provider to the same logical account, product, and execution population used by continuous sources. For an active month choose the newest nonfailed revision. For a closed month prefer a complete/final revision over a later partial revision, then use produced and received time. Preserve methodology/catalog versions.

Monthly snapshots are historical fallback at their recorded resolution. Use a snapshot only where finer canonical execution coverage does not cover the same crosswalked subject and period. A supported daily row may fill an uncovered whole day; never subtract an overlapping partial month or allocate it proportionally. Do not combine a snapshot with buckets or requests for the same subject-period, and do not use it for a filter the snapshot cannot support. A monthly or daily row never becomes invented hourly/request detail.

Legacy project, agent, task, and knowledge classifications remain available as snapshot-sourced views with their provenance; they are not silently joined onto newly collected events.

### 4.4 Allowances and reset claims

Canonicalize allowance observations within `account + stable meter/scope + reset boundary`. Use the freshest eligible provider observation and retain reader provenance. Equivalent readers can corroborate or supersede one another only through a documented meter mapping and freshness rule.

Allowance observations never convert into token totals. A drop, reset-boundary change, long gap, stale reading, or account-identity ambiguity breaks forecast continuity. Public reset-feed claims remain separate from personal allowance reset timestamps.

### 4.5 Money and derived estimates

Provider money entries retain entry kind, source, reference, and period. Actual charges, included usage, credit grants/consumption, and adjustments are not collapsed into API-equivalent cost.

API-equivalent and environmental values are recomputed only from eligible canonical execution evidence under their versioned methods. Historical stored estimates remain tied to their original snapshot and method unless an explicit recalculation view is requested.

## 5. Filter and resolution support

The display timezone is **America/Chicago** initially. Store and join timestamps as instants; UTC remains the canonical hourly bucket boundary. Settings can later make the IANA display zone configurable, but one selected zone must govern all date labels and filter boundaries on a page.

| Source | Time support | Supported filters | Unsupported behavior |
| --- | --- | --- | --- |
| Complete request activity | `activity_at = ended_at ?? started_at ?? observed_at`; aggregate upward. | Account, provider/product, model, effort/tier when recorded, execution machine, surface, project, agent, tool, and knowledge where supported. | Exclude an unfilterable slice from the filtered result and disclose its amount; do not silently treat it as a match. |
| Hourly token buckets | Full UTC hours only; aggregate to day/week/month in the display timezone. | Account, provider/product through binding, model, and true execution source. Collector source is diagnostic provenance. | No project, effort, tool, independent agent, or exact request-time filtering. Do not prorate a partial hour. |
| Provider account buckets | Provider-declared bucket, commonly minute/hour/day. | Only dimensions supplied by the provider, such as account, model, workspace/project, key/user, tier. | Do not invent conversations, local projects, tools, agents, or finer times. |
| Monthly snapshots with daily rows | Whole source-calendar month or supplied whole daily rows in the report's recorded IANA zone. | Crosswalked subject and dimensions embedded in the snapshot. | No arbitrary partial-day, unsupported cross-dimension, or finer-grained filtering. If source zone is unavailable, treat it as a whole-period fact only. |
| Allowance readings | Exact observation within its reset window. | Account, meter/scope, provider/reader for diagnostics, history range. | Project/model filters do not narrow a pooled account meter. |
| Money entries | Declared entry period. | Account, entry kind, model/SKU/reference when supplied. | No finer allocation than the provider evidence. |
| Derived estimates | Resolution of their eligible canonical inputs. | Same supported filters as those inputs. | No proportional allocation into unsupported dimensions. |

The Tokens filter bar shows time, accounts, and projects. More filters contains provider, model, effort, machine/source, surface, and main/subagent scope when those dimensions have usable coverage. Selecting a filter never causes an unfilterable snapshot to be substituted as if it matched.

Within one dimension selected values are ORed; dimensions are ANDed. Unfiltered totals include Unknown. Selecting named values excludes Unknown and reports the excluded amount; selecting Unknown matches a supported field whose value is unknown. A source that cannot represent the dimension is unfilterable rather than an Unknown match. Unassigned project, No project, and Unknown project are separate selectable buckets. A provider workspace/project dimension is not renamed as the app's conversation Project without a verified mapping.

Account/provider selection can carry to Allowances. Project, model, effort, and agent filters do not narrow pooled allowance meters. A history-range control changes chart history, not the current allowance observation.

### Period boundaries and comparisons

- Today and calendar presets use America/Chicago boundaries. Daylight-saving changes produce a 23- or 25-hour local day; do not force it to 24 hours.
- Every range is half-open `[start, end)`. Include a coarse bucket only when the whole bucket is contained in the range; never prorate it.
- Month to date begins at local midnight on the first day and ends at the selected current instant. The current hour/day is marked partial.
- Previous-month comparison uses the same completed local calendar extent, capped at the prior month's end. Compare September 1 through September 13 at 14:00 with August 1 through August 13 at 14:00, subject to available coverage.
- A completed calendar month compares with the whole prior calendar month.
- A custom range has no default comparison. If added later, use an immediately preceding equal-instant-duration window and label its exact boundaries.
- Suppress a percentage comparison when either period lacks comparable source coverage, the denominator is zero, or only unsupported aggregate resolution is available. Show the reason.

## 6. Coverage and denominators

Each section reports coverage for the selected canonical headline population, not merely that a collector ran. Use three quantities: `H`, the selected canonical headline population; `E`, the part eligible for that dimension or method; and `S`, the part successfully classified, attributed, or estimated. Show applicability `E/H`, completeness `S/E`, and the absolute `H-E` and `E-S` remainders.

| Coverage | Numerator | Denominator |
| --- | --- | --- |
| Exclusive composition | Canonical tokens assigned to exclusive categories | Canonical observed total tokens |
| Observed request detail | Canonical tokens (and separately calls) linked to accepted request-detail records, including an incomplete slice | Canonical execution tokens (and calls) eligible for request collection |
| Request replacement readiness | Canonical tokens (and separately calls) in slices declared complete and reconciled at request level | Canonical execution tokens (and calls) eligible for request collection |
| Project evidence | Canonical eligible tokens with a stable mapped/unassigned project identity or explicit No project | Canonical tokens in sources that could provide project evidence |
| Project registry mapping | Project-evidenced tokens mapped to a named Project | Canonical tokens carrying a stable project/path identity |
| Agent attribution | Canonical eligible tokens assigned to main or distinct child identity | Canonical tokens in sources that could provide agent evidence |
| Tool detection | Eligible source-period events scanned by a parser that completely supports tool evidence | All events in tool-capable source coverage, including tool-only/orphan events |
| Tool caller/outcome | Reported invocations with supported caller/outcome respectively | Reported tool invocations |
| Knowledge attribution | Reported invocations inspected against the active source configuration | Tool invocations eligible for resource detection |
| Price coverage | Tokens priced by the selected catalog | Tokens eligible for API-equivalent pricing |
| Environmental coverage | Eligible model calls successfully classified and estimated | All selected canonical model calls; also show ineligible observed tokens/source periods separately |

Also show the absolute unknown or unattributed remainder. If the eligible denominator itself excludes unsupported cloud/browser activity, say so; a high percentage within local logs is not global account coverage.

Freshness is separate from coverage. A coverage-only receipt can update run health but cannot update usage or an allowance's observation time.

## 7. Initial display decisions

| Decision | Initial value |
| --- | --- |
| Usage subtabs | Tokens and Allowances |
| Landing view | Tokens, month to date, all accounts and projects |
| Display timezone | America/Chicago |
| Overall time series | Daily by default; expose other resolutions only when supported |
| Cost and model cards | Graph first; remember table/graph preference per card |
| Legend behavior | Hide/show presentation series without changing page filters or headline totals |
| Environmental position | After tokens by model, before projects/agents |
| Environmental classification cohort | Methodology version + logical execution population + source IANA calendar month; legacy snapshots retain their original report-subject/provider/month cohort through the subject crosswalk |
| Allowance account cards | First account open initially; remember expansion and allow multiple accounts open |
| Spark allowance windows | Hidden initially with an explicit persisted reveal control |
| Optional compensation dollars | Undecided and isolated in USG-034; physical estimates and actionable recommendations remain required |

For the reused environmental method, compute the cohort's average raw tokens per model call and assign its planning class to that cohort's calls. The active source-calendar month is provisional and may change only as cohort evidence arrives; freeze the class when the month closes. Filtering later sums those preclassified calls and never reclassifies the cohort. The logical population may include account, provider/product, report subject, and execution machine, but not the collector that happened to observe or replay it. Do not split a legacy cohort into project/model detail it never recorded. The legacy threshold class currently called `reasoning_heavy` is a workload-size proxy inferred from raw tokens per call, not measured reasoning effort, and must be relabeled in USG-013.

## 8. Delivery map

| Requested section or missing capability | Owning tasks |
| --- | --- |
| Metric/source contract and history safety | USG-001, USG-002, USG-011 |
| Request and pricing detail | USG-003, USG-004, USG-012, USG-013 |
| Agent lineage | USG-005, USG-021 |
| Tool invocations and callers | USG-006, USG-022 |
| Cross-machine projects | USG-007, USG-021 |
| Multiple vaults/knowledge sources | USG-008, USG-022 |
| Allowance identity/freshness and browser bridge | USG-009, USG-010, USG-023 |
| Global settings and two-tab navigation | USG-014, USG-015 |
| Filters/charts and Tokens page | USG-016 through USG-018 |
| Environmental estimates and recommendations | USG-013, USG-019, USG-020; later method USG-033; optional budget USG-034 |
| Allowance accordions and reset calendar/feed | USG-023, USG-024 |
| Activation, backfill, verification, and retirement | USG-025, USG-026 |
| Cursor, account readers, organization APIs, cloud/browser gaps | USG-027 through USG-032 |

The [filesystem backlog](usage-tasks/README.md) contains full dependencies and acceptance criteria.

## 9. Known unsupported or unresolved source facts

- Production request detail and project attribution were off at the September 13 audit. Existing rich breakdowns cannot be assumed continuous.
- Current tool extraction and independent agent identity are not implemented.
- The inspected sources do not distinguish user-requested delegation from model-chosen delegation.
- Cloud sessions and browser chats can move account allowances without exposing exact tokens, projects, tools, or agents to current local collectors.
- Cursor and the provider account/Admin readers are stubs until their follow-up tasks produce verified source implementations.
- Provider aggregate/local-request overlap cannot be allocated without stable provider joins.
- The request wire/storage contract lacks an independent reported total and unclassified remainder, so total-only or partially classified evidence cannot yet satisfy the normalization rule. USG-003 owns that change and the explicit inconsistent state.
- Current Codex normalization clamps a negative fresh-input remainder; all-zero usage events are dropped; local request outcomes are hardcoded completed; absent model/surface facts can become string defaults. These are implementation gaps for USG-003 and USG-004, not evidence of success or zero.
- Provider aggregate read identity does not yet preserve `provider_event_id`/query-profile semantics, and monthly selection can regress a closed month from complete to a later partial revision. USG-011 and USG-012 own those corrections and the report-subject crosswalk.
- Aggregated tool fields lack invocation identity, caller, outcome, time, wrapper relation, and resource evidence; `project_hash = null` conflates unavailable evidence, Unknown, and No project; current child attribution lacks a reliable independent child identity.
- Existing coverage notes that attribute every call from a vault working directory conflict with this contract. USG-008 requires explicit resource/path/connector evidence; cwd alone never proves access.
- Effort, service tier, speed, and context-window evidence needed by filters and pricing are not retained today.
- Allowance input accepts several basis values while current persistence reports all saved readings as provider-reported. USG-009 must preserve basis or narrow the accepted wire contract.
- Indirect resource use through opaque scripts, symlinks outside configured roots, or ambiguous generic connector tools can remain unknown.
- Actual datacenter, hardware, energy source, grid region, and cooling/watershed are unknown; environmental outputs remain scenario estimates.

These limits produce visible unknown or unavailable states. They do not authorize fixed allowance-to-token conversion, proportional attribution, or zero-filled detail.

## 10. Contract verification

The definitions were checked against the current exclusive bucket invariant, request schema, canonical bucket/read queries, monthly snapshot reader, allowance forecast rules, and the audited source limitations. The examples above are the expected behavior for the later schema/query/UI tasks.

Changes to any term, precedence rule, coverage denominator, timezone, or environmental cohort should update this document and the domain language before dependent implementation changes are accepted.
