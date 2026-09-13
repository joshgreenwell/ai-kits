# Usage redesign direction

Date: September 13, 2026

Status: Consolidated proposal for review. This document defines the intended product and its data requirements; it does not authorize implementation, collection-setting changes, migration, or deployment. The current operating state remains documented in [Usage: how the system actually works](usage-system.md).

The [filesystem task backlog](usage-tasks/README.md) turns this direction and the known collection gaps into sequenced tasks with dependencies, acceptance criteria, and verification. Planning stays in the filesystem; do not use Jira for this work.

The [usage metric and source contract](usage-metric-contract.md) defines the shared terminology, precedence, overlap, filtering, time, and coverage rules for implementation.

## 1. Product direction

Usage becomes a place to understand collected activity, its estimated financial and environmental costs, and remaining account capacity.

The app has two Usage subtabs: **Tokens** and **Allowances**. Global **Settings** moves into the main header and becomes the home for connections, collection configuration, and knowledge-source configuration.

Collect the facts continuously and derive the displays from those facts. A month is a selectable period. A report is a view or saved snapshot of the selected data, rather than a separate prerequisite for seeing detailed usage. Regular collection must eventually provide the detail currently available only through the monthly analysis.

Two views share account identity and collection context while answering different questions:

| View | Question | Primary information |
| --- | --- | --- |
| Tokens | What did I use, where did it go, and what did it cost? | Observed tokens, API-equivalent estimates, environmental scenarios, models, projects, agents, tools, and knowledge access |
| Allowances | How much capacity do I have, and will it last until reset? | Provider allowance readings, burn-rate charts, cycle history, reset calendar, and reset feed |
| Global Settings | How is the app connected and configured? | Accounts, machines, collectors, collection preferences, knowledge sources, and feed status |

Environmental impact is a required part of Tokens. Reuse the existing estimation methodology initially; improved modeling is a separate follow-up.

## 2. Agreement and proposed defaults

The requested direction includes two simplified usage areas, a common collection flow, the Tokens sections below, account accordions for allowances, reset calendar/feed, global settings, multiple configurable knowledge sources, and environmental estimates with actionable compensation recommendations.

The following are proposed defaults to make this direction concrete. They remain reviewable choices:

| Choice | Proposed default |
| --- | --- |
| Subtab names | Tokens and Allowances |
| Landing view | Tokens, month to date, all accounts and projects |
| Environmental placement | After tokens by model, before the project/agent breakdown |
| Cost/model card presentation | Graph initially; remember each card's table/graph choice |
| Time-series granularity | Daily initially; offer other resolutions only where the data supports them |
| Account accordion state | Open the first account initially; remember subsequent expansion choices and allow multiple accounts open |
| Spark allowance windows | Hidden initially, with a visible control to reveal them |
| Environmental compensation dollars | Optional budget alongside the footprint and recommendations; pending clarification |

The screen arrangement and data requirements can be agreed before deciding database tables, endpoint names, libraries, or delivery stories.

## 3. Navigation and global settings

Proposed destinations are `/usage` for Tokens, `/usage/allowances` for Allowances, and `/settings` from the main header. Exact routes are an implementation choice. Existing usage links should continue to resolve to their new destination, including a direct path to the reset section.

Move existing connection and collection-settings functions into the global settings area. Preserve their capabilities during the move. A broader redesign of those pages is deferred.

Settings owns account binding, machine/collector status, collection detail preferences, project identity mapping, multiple knowledge-source definitions, and reset-feed connection status. These responsibilities do not require designing every settings screen now. The initial usage release does need a usable way to configure the project and knowledge identities required by its breakdowns.

Keep a compact data-status indicator on Tokens and Allowances: last relevant observation and complete/partial/stale/unavailable state. Detailed diagnostics belong in Settings. Refreshing a screen must not make an old observation appear fresh.

## 4. Tokens page

The page follows this order:

1. Filter bar.
2. Compact total tokens and a full-width token-composition bar.
3. Tokens over time.
4. API-equivalent cost estimate, switchable between graph and table.
5. Tokens by model, switchable between graph and table.
6. Environmental impact, including reduction and compensation recommendations.
7. Project breakdown and agent breakdown, side by side.
8. Tool calls, including a dedicated knowledge-source breakdown.

All sections respond to the same applicable Tokens filters. No section silently substitutes an unfiltered monthly number for a filtered result.

### 4.1 Filter bar

Keep time range, accounts, and projects visible. Include presets such as today, last 7 days, last 30 days, month to date, previous month, and a custom range.

Additional filters include provider, model, reasoning effort, machine, app/surface, and main-agent/subagent scope where collected. Put less frequently used dimensions under More filters. Accounts and projects support multiple selections.

Show active filters, Clear all, the period, and one consistent display timezone. Preserve filters in navigation and a shareable private URL. A project or agent row can apply its corresponding filter.

Time controls use the time the activity happened. Data receipt time is shown separately. Mark the current partial day and use comparable elapsed periods if a previous-period comparison is offered.

A field that was not collected remains unknown. If older data cannot support a selected filter, identify the excluded or unavailable coverage. Do not infer a project's usage by multiplying an account total by an unrelated proportion.

### 4.2 Total and token composition

Show total observed tokens for the selected scope as a compact headline. Model calls and conversations can appear as secondary context without restoring the current large summary grid.

Follow with one long composition bar and a readable legend containing exact counts and percentages. Normalize provider fields into non-overlapping categories: fresh input, cached input, cache-write input, and output. Show an unclassified remainder when only a total is known. Reasoning can be an output sub-breakdown; it must not be added to output a second time.

The composition reconciles to the headline total. Cached tokens remain visible because they are part of observed workload even when priced differently.

### 4.3 Tokens over time

Show overall daily token volume for the selected period. Hover, keyboard focus, and touch interaction expose the date/time interval, exact total, composition, and collection coverage where available.

Use a minimal Y-axis with a few abbreviated values and clear units. Distinguish confirmed zero activity, missing observations, and the incomplete current interval. Do not manufacture hourly detail from daily or monthly history.

The primary purpose is to show when activity happened. Model-specific trends belong in the model card below.

### 4.4 API-equivalent cost estimate

Show the estimated API price of the observed usage for the selected period. Keep the label API-equivalent estimate visible. Subscription payments and actual billed charges are different facts.

The table includes model, effort where known, applicable service tier or other pricing dimensions, token quantities, estimated cost, and priced/unpriced coverage. Group by model initially and make effort breakdowns available without creating an unreadable number of initial rows or lines.

The graph shows estimated cost over time by model, with optional effort detail. Its legend controls series visibility. Table and graph use the same filtered records and price assumptions.

Reuse the existing pricing catalog and assumptions where applicable. Preserve model, effort, service tier, cache categories, and context-size evidence needed to reproduce pricing. Unknown effort remains unknown. A higher effort setting does not create a new unit price unless the catalog defines one.

Show the catalog version and relevant assumptions in expandable detail. Unpriced activity must remain visible rather than appearing free. A later pricing-method change should be explicit and reproducible.

### 4.5 Tokens by model

The table summarizes each model's total tokens, token composition, share of selected usage, and model calls where available. Effort can be an additional breakdown.

The graph shows token volume over time with one line per model and legend visibility controls. The total time-series chart answers when overall usage occurred; this chart explains which models contributed to it. If a period-total comparison is later added, use bars for those categorical comparisons.

Model colors stay consistent between the cost and token charts. If only some series are initially shown for readability, state that clearly and make all series available.

### 4.6 Environmental impact

Show the estimated environmental footprint of the same selected activity. The section is visible by default, with three adjacent summaries that stack on narrow screens:

| Dimension | Main quantity | Supporting information |
| --- | --- | --- |
| Electricity | kWh | Planning scenario, alternative scenarios, and a familiar electricity comparison |
| Direct water | Liters | Planning scenario, alternative scenarios, and a water-use comparison |
| Operational carbon | kg CO2e | Planning scenario, alternative scenarios, and an emissions comparison |

Use a short visible explanation: these are inference estimates based on workload and published reference factors; the actual datacenter, hardware, grid mix, and cooling system are unknown. Put the detailed assumptions, scope exclusions, sources, and methodology version behind an expandable control.

These values express environmental cost in physical units. API-equivalent dollars are not an input to the footprint calculation. An optional compensation budget expresses the cost of a chosen action separately.

#### Reuse the current calculation first

The baseline is [environmental-factors.json](<../app/(private)/usage/environmental-factors.json>), methodology `2026-08-20.1`, and the existing environmental estimate/fallback in the [Tokens page source](<../app/(private)/usage/page.tsx>). This direction records those existing assumptions; it does not claim to have revalidated their applicability to every provider or workload.

| Existing calculation | Initial requirement |
| --- | --- |
| Model-call count multiplies per-call electricity factors | Retain this basis. Token counts alone do not supply a missing call count. |
| Efficient scenario: 0.24 Wh/call | Preserve as a reference scenario. |
| Planning: 0.34 Wh/call, or 4.32 Wh/call at an average of at least 50,000 raw tokens/call | Preserve the threshold and factors initially. |
| Long-context scenario: 33 Wh/call | Preserve as an illustrative high scenario. |
| Direct water: 0.26 mL/call for the efficient scenario; planning electricity times 0.3 L/kWh; high-scenario electricity times 1.9 L/kWh | Preserve the three existing scenarios and their source notes. |
| Carbon: 0.00003 kg/call for the clean-energy scenario; planning/high electricity times 0.394 kg/kWh | Preserve the existing carbon assumptions. |
| Familiar comparisons and a 10% call-reduction scenario | Reuse them, clearly labeled as modeled equivalents and savings. |

The range is a comparison of scenarios, not a measured confidence interval or a guarantee that actual impact lies within it. Initial scope remains operational inference; it excludes training, embodied hardware, client devices, networking, and indirect supply-chain water.

Preserve stored historical estimates and their method versions. Match existing totals on the same source scope. For newly collected detail, assign the planning workload class on a stable source-period basis and sum the resulting estimates through filters; selecting a model or project should not silently reclassify unrelated calls. Agree the exact classification unit during calculation design. Do not spread a legacy monthly estimate across projects or days without supporting call-level or grouped evidence.

If a filter leaves only activity without the required call evidence, show the supported portion and missing estimation coverage. Do not use allowance movement to invent an environmental footprint for unobserved cloud activity.

#### Reduction and compensation recommendations

Follow the three footprint summaries with practical actions related to the selected period:

| Action area | Required recommendation behavior |
| --- | --- |
| Reduce unnecessary work | Retain the scenario showing how 10% fewer comparable model calls changes electricity, water, and carbon estimates. Label the assumption; a future change in workload mix may produce different savings. |
| Address estimated carbon | Recommend verifiable carbon-removal options, explaining quantity, durability, verification, delivery timing, and evidence of retirement where applicable. Keep a link to the specific program and the date its details were checked. |
| Support water stewardship | Recommend projects with documented water benefits and geographic context. With the inference watershed unknown, describe this as support for water restoration rather than a claim that the same local impact has been reversed. |
| Support cleaner electricity | Recommend suitable clean-energy support or efficiency actions. Explain what any certificate or program represents; do not claim it changed the electricity used by the unknown datacenter. |

The recommendation list must include concrete, usable destinations before the section is considered complete. Provider selection and live pricing research are follow-up work; this direction does not select a vendor or initiate purchases.

Carbon removal, water stewardship, and electricity support have different units and claims. EPA distinguishes renewable-energy certificates from carbon offsets; WRI's water-benefit guidance emphasizes catchment context and documented outcomes. Those distinctions inform the separate action categories above. [EPA market instruments](https://www.epa.gov/green-power-markets/market-instruments), [WRI water-benefit accounting](https://www.wri.org/research/volumetric-water-benefit-accounting-2-0)

For carbon recommendations, use transparent removal quantities, additionality, durability, and independent verification as selection criteria, consistent with the criteria described by DOE. [DOE carbon-removal criteria](https://www.energy.gov/hgeo/cdr-challenge)

If a dollar budget is included, show the chosen scenario, quantity, sourced unit price, currency, price date, and material fees/minimums. A carbon budget can use `scenario kg CO2e / 1,000 × quoted price per tonne`. Keep separate budgets for water or electricity actions only when the program supplies a defensible unit and price; otherwise show a suggested contribution with its stated purpose.

The existing compensation note uses the high operational scenario as its planning quantity. Carry that forward as a labeled conservative budgeting choice, with the scenario visible. It is not a guarantee of covering the actual footprint.

Keep estimated impact visible after any recommended action. A comparison such as tree seedlings grown for ten years is an educational equivalent, not a completed offset. Donation, purchase, promised delivery, and verified removal are distinct states. Purchase execution and a personal compensation-history ledger are outside this redesign.

#### Later methodology work

Revisit workload/model calibration, context and cache effects, datacenter-region averages, water scope, carbon factors, uncertainty presentation, and recommendation quality in a dedicated follow-up. Record source dates and method changes. Reusing the current method must not be described as solving those questions.

### 4.7 Project and agent breakdowns

Display these two cards side by side on wide screens and stack them on narrow screens.

**Projects:** group by the project the conversation belongs to, using native project identity where available and explicitly mapped working directories otherwise. A named project can combine machine-specific paths and worktrees. Include token totals, usage share, calls, and conversations where available. Distinguish known No project from Unknown project; keep both in the overall total. Make assignment coverage visible.

**Agents:** show distinct observed subagents, main-agent/subagent token share, built-in/custom/unknown role breakdown, and parent agent/session. Expose the resolved model and delegation depth where recorded. Count a child once even if it has multiple calls or resume events; a spawn attempt without an observed child is not automatically an observed subagent.

Agent role and delegation initiator are different facts. A custom role may be launched by another model. Show the creating parent where recorded, and label user-directed versus model-directed delegation only where the source explicitly distinguishes them. The current coverage audit says that distinction is unavailable in the inspected local logs.

Agent totals are a breakdown of overall tokens, not additional tokens to add on top. Missing agent identity remains unattributed rather than being classified as a main agent.

### 4.8 Tool calls and knowledge sources

Show total reported tool invocations, top tools by count/share, and top callers by model or agent where attribution exists. Keep model calls, tool calls, and agent spawns separate. Deduplicate repeated call records; results and status updates are not additional invocations. Distinguish issued, successful, failed, and unknown outcomes when evidence supports it.

Include a dedicated Knowledge sources area within the card. Support multiple named Obsidian vaults and other configured knowledge sources. For each source, show observed accesses, distinct sessions/agents that accessed it, top tools, and read/search/write categories where available.

Settings identifies each source through a stable ID and display name, with local roots and/or connector resource identifiers resolved by the collector. Allow one source to have different roots across machines. Whole vault contents and raw private paths do not need to be uploaded.

Evidence distinguishes direct resource access, attempted search, and indirect shell access. A session merely running inside a vault directory is insufficient evidence that every tool call accessed vault knowledge. A generic connector tool name may also be insufficient to distinguish multiple vaults.

Show detection coverage and unknown attribution. Count a tool invocation once in the overall total, even if it touches several resources; per-resource access counts can overlap and must be labeled accordingly. Reading a file demonstrates access, not proof that the final answer used its contents. Resource-level token cost is not required initially; any later allocation is an explicit estimate.

## 5. Shared chart and table behavior

- Hover, keyboard, and touch can reveal exact values. A table supplies an accessible route to the underlying values.
- Minimal axes retain units and enough labels to interpret scale. Time is the X-axis for line charts.
- Clicking a legend item toggles that series. Hidden series remain discoverable, with a way to restore all.
- Legend visibility changes the chart presentation, not the global filters or headline totals. State when the visible series are only a subset of the total.
- Switching graph/table preserves period, filters, grouping, and the data basis. Preserve card preferences on return.
- Consistent model colors and formatting apply across charts. Tables sort numeric values correctly.
- Unknown and missing values are distinct from zero. Loading, partial coverage, stale data, and failed refresh have explicit states.

Shadcn charts are a suitable candidate because the app already uses shadcn components and its chart components support Recharts composition, tooltips, and legends. Series toggles and filter behavior remain application requirements rather than assumptions about the library. [Chart documentation](https://ui.shadcn.com/docs/components/base/chart)

## 6. Allowances page

### 6.1 Account summaries and burn charts

The first content is a full-width accordion card for each account. The collapsed header shows account/provider identity, the latest observation time, and all visible allowance windows side by side. Each window shows remaining allowance, reset countdown, and a compact pace/outlook indicator when available.

Use the provider's window names, scopes, durations, and units. Support account-wide short and weekly windows, model-specific windows, and separate pools such as Spark without assuming that every account has the same columns. Spark starts hidden, with an explicit reveal control. Allow cards to wrap on narrow screens.

Expanding an account shows its burn charts for each window, side by side where practical. Preserve current useful cycle-history behavior within the expanded account. Each chart includes observed usage, a distinct forecast, the even-pace guide, reset markers, minimal axes, and interactive details.

For percentage windows, burn means percentage points consumed over time. Forecast each account/window independently, using its own reset boundary and supported current or historical evidence. Show whether an outlook is based on current observations, historical cycles, or a blend. Preserve the existing protections for resets, gaps, decreases, and stale samples.

Do not sum overlapping allowance windows or derive allowance consumption from token counts. A pooled account meter cannot be allocated to projects or models just because local token activity is known. If another unit is supplied by a provider, retain that unit and withhold an unsupported forecast.

Account/provider selection can carry between Tokens and Allowances. Tokens-specific project, effort, and agent filters do not narrow account-wide meters. Current allowance summaries always use the newest relevant readings; any history-range control affects the charts, not the meaning of current capacity.

### 6.2 Reset tracking

Place the existing reset calendar and feed below the account cards. Preserve calendar day selection, event detail, provider/type filters, source attribution, banked-reset lifecycle where supplied, and links to announcements.

Distinguish personal provider-reported reset times from public reset claims or predictions. Public announcements do not overwrite account reset anchors. If personal resets appear in the calendar, label their account and origin explicitly.

Detailed feed connection status moves to Settings. Keep stale-feed or unavailable-feed context beside affected results so the calendar remains interpretable. Reuse the current refresh behavior initially; moving the section does not imply a new scheduler or collection process.

## 7. Collection and data requirements

The target is one coherent collection workflow with multiple kinds of facts. It does not require putting all facts into one table or making incompatible measurements additive.

| Fact | Detail the requested experience needs |
| --- | --- |
| Model activity | Stable record/session identity, observation time, account, source, surface, actual model, token components, model-call count, and coverage |
| Pricing evidence | Model, recorded effort, service tier, cache/context dimensions, catalog version, and explicit unknowns |
| Project attribution | Native project reference or mapped local identity, stable cross-machine grouping, and attribution basis |
| Agent activity | Child identity, parent identity, role/class, actual model, spawn/delegation evidence, and attribution coverage |
| Tool activity | Invocation identity, name, caller, timestamps, outcome where available, and evidence sufficient for local resource classification |
| Knowledge access | Stable resource identity, observed access type, linked tool invocation/session, evidence basis, and detection coverage |
| Allowance observations | Account, provider meter identity, scope, value/unit, observation time, duration, and reset boundary |
| Derived estimates | Input scope, methodology/catalog version, assumptions, estimated amount, and eligible/excluded coverage |

Monthly analyzer totals, hourly snapshots, request records, provider account aggregates, allowance readings, and money entries can overlap or measure different things. Select a documented canonical source for each metric and coverage interval. Do not add duplicate representations together.

Historical monthly-only data remains usable at its recorded resolution. Preserve original snapshots and provenance. Where newer collection lacks old detail, identify the gap rather than dropping history or fabricating finer detail.

Detailed usage should refresh through regular deterministic collection and aggregation. Viewing a dashboard or selecting a month must not require a model session or a separate report-publication job. Saved reports, if added later, are outputs of the same data.

The [September 13 audit](usage-system.md) records production request detail as `buckets_only`, project attribution as off, and richer tool/agent extraction as unfinished. Envelope v2 can retain pricing and attribution detail, but current collectors do not emit those optional fields or event records. These are delivery dependencies, not reasons to display empty cards as completed features. [Coverage matrix](usage-coverage.md), [request contract](../lib/usage-contract.ts)

No old collector, history store, report publisher, or schedule is retired until the replacement preserves the required data and its coverage has been reconciled. Follow the existing [preservation and retirement requirements](usage-v1-retirement.md).

## 8. Scope boundaries

This direction includes the two usage views, necessary collection detail, moving existing configuration into global Settings, essential project/resource mapping, environmental-method reuse, and researched recommendation links.

The broader settings-page redesign, replacement environmental science/modeling, automated offset purchases, a compensation transaction ledger, narrative AI-generated recommendations, and a new report-export system are later work. Existing task/theme classifications and historical narrative reports remain preserved; their addition to the new core layout requires a separate product decision.

Changing Usage does not redesign Tasks, Standup, Readings, Audit, or their independent report processes. No new provider-collector commitment is implied; each source must clearly state its supported data and gaps.

## 9. Completion criteria for a later implementation

1. Usage exposes Tokens and Allowances, and the main header exposes Settings. Existing destinations remain reachable through appropriate redirects or links.
2. Every requested Tokens section exists in the agreed order, including environmental impact and actionable compensation recommendations.
3. The selected period/accounts/projects apply consistently. Unsupported historical detail is visible, and composition/model/project/agent totals reconcile on the same eligible data.
4. Both cost and model cards offer table/graph views, interactive values, and legend series controls without silently changing headline totals.
5. Project grouping works across mapped machines/worktrees; known unassigned and unknown activity remain visible.
6. Agent, tool, and multi-vault displays use collected evidence and avoid duplicate counting or invented initiator/resource attribution.
7. Environmental calculations reproduce the current method for equivalent inputs, retain sources/scenarios/scope, disclose estimation gaps, and separate action recommendations from the footprint.
8. Account accordions show side-by-side windows and usable burn charts. Spark defaults hidden; resets, missing samples, and stale data retain honest forecast behavior.
9. Reset calendar/feed behavior is preserved, with personal reset times and public claims clearly distinguished.
10. Normal collection supplies the required new detail without a special monthly publishing dependency, while historical reports and ledgers retain their provenance and supported resolution.

## 10. Remaining review points

- Confirm the proposed labels, section placement, and initial graph/accordion defaults in section 2.
- Confirm whether environmental cost includes the optional compensation budget, in addition to physical estimates and recommendations.
- Select concrete environmental recommendation programs and verify their evidence, availability, and pricing before that feature ships. This does not require reworking the footprint methodology first.
- Specify the stable environmental classification unit when adapting the current method to filtered request data; preserve comparable historical totals.
- Decide the smallest usable project/vault configuration flow needed for these views while deferring the wider settings redesign.

These remaining decisions are tracked in the filesystem backlog and apply before their dependent implementation tasks. No application behavior was changed by preparing this document or creating the tasks.
