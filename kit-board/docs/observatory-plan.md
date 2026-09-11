# Personal Observatory and Kits — plan of record

Recorded 2026-09-11 against `373fdbb714f1dbac365ad4e1829155136819723a`, the commit that moved the
Observatory into this repository. Supersedes the owner's plan v4 of 2026-09-10 as the repo-resident
version; v1–v4 remain history and are not tracked here.

**Document-only.** Nothing here performs or authorizes code, tracker, schedule, credential,
production, brain-write or upstream-import changes. Two Phase 0a actions edit scheduled prompts that
live outside this repository and remain blocked — see §10.

Labels: **Decided** (settled across v1–v4, not reopened) · **Proposed** (recommendation) ·
**Deferred** (parked, with the reason) · **Corrected** (plan v4 said otherwise; the code says this).

Companion: [report contract v0 (observed)](report-contract.md) records what the publication path
actually enforces today, with citations. This plan refers to it rather than restating it.

---

## 0. Corrections to plan v4

Plan v4 was written before its author inspected the post-move tree. Every item below was checked
against the code at `373fdbb7`; the citation is the file that settles it.

| Plan v4 said | Actually | Consequence |
| --- | --- | --- |
| Proposes a layout of `observatory/`, `kits/usage`, `kits/audits`, `tools/` | A proposal, so not wrong for being unbuilt — but everything it would gather is already consolidated in one directory, `kit-board/`, and building it would break CI and TypeScript path resolution | §3 is rewritten as an annotation of real paths rather than a target layout. See the CI and `tsconfig` hazards below. |
| "The post-move ref must be recorded in Phase 0a" | It is `373fdbb714f1dbac365ad4e1829155136819723a`, 2026-09-10, 150 files changed | Step discharged by this document. |
| Baseline `74abf3ed…` to diff against | Recorded in `docs/repository-migration.md:5`, but **unresolvable in this repo** — the source history was deliberately not imported. The *destination* base on the same line, `bfb867ed…`, does resolve: it is the move commit's parent | Treat `74abf3ed…` as a provenance string only; no `git diff`, `git show` or bisect against it will work. |
| "Dirty routing telemetry/API/schema/test work … preserve; isolate only what conflicts" | The tree is clean. Routing landed whole in the move commit (`lib/routing-*.ts`, `lib/routing-contract/`, `app/api/v1/agent-events/`, `app/api/v1/quota-state/`, migration `20260910193058_agent_routing_events.sql`) | Step discharged. Nothing to preserve or isolate. |
| The Tuesday prompt's flags "IS the report contract v0" | Partly. The flags and `status` vocabulary are real; run id, SHA, rubric version, scores, baseline and limitations are unvalidated producer convention inside `payload` that no code reads | Phase 3 has more to decide than "write down what both producers already send". See [report-contract.md](report-contract.md) §2. |
| `publish.mjs` prints the `/audit?report=<id>` link | It prints the bare section URL. The deep link is assembled by the caller (`scripts/publish.mjs:59`) | The Phase 0a verification step must build the link itself. |
| Producer `ai-audit` | No such name in the repo. The documented audit producer key is `audit-local`; `lib/catalog.ts:14` records the Tuesday job's *scheduler* source id as `weekly-luumen-ai-audit` | Different namespaces; neither is server-validated. Do not record `ai-audit` as established. |
| "Disabling a capability rejects new intake with a documented nonretryable response" (listed as existing) | No capability switch exists for report intake. The one real disable — a telemetry source's `disabled` flag — answers **401**, indistinguishable from a bad key (`lib/telemetry-store.ts:29`) | Moves from "existing behaviour" to Phase 5 work. |
| Environmental estimates are a Phase 4 method to design | A method already ships: per-**call** energy/water scenario factors, `methodology_version` `2026-08-20.1`, in `app/(private)/usage/environmental-factors.json`, rendered on `/usage` | Phase 4 is *review and bound an existing method*, not design from zero. |
| AI Kits / Trace Linter / Control-Surface Diff "frozen pending rethink" | Nothing in the repo says frozen. Both read as pre-release and actively maintained: `agentlint` 0.0.1 alpha, `agent-surface` 0.0.1, both with their own CI | The repo can neither confirm nor refute an owner-level decision to stop work; it simply records none. If the freeze is real it belongs in `README.md` and `CONTRIBUTING.md`. See §9. |
| (not mentioned) | Three CI workflows exist, keyed on top-level path filters and `working-directory` | A root-level `observatory/` / `kits/` / `tools/` split would silently disable CI for every project. See §3. |

Three claims plan v4 made that the code **confirms** exactly, worth keeping: publication is
idempotent with a 409 on same-key-different-content (`lib/db.ts:47-52`); producers hold secrets
while the host stores only SHA-256 verifiers scoped per report kind (`lib/auth.ts:17-24`); and
canonical usage selection cannot be regressed by appending a smaller record (§5).

---

## 1. Product direction — Decided

The Personal Observatory is the product: a private home for the results of AI-assisted workflows
that run elsewhere. It receives, validates, stores, compares and presents results; may prepare work
packages; may ship local tools and scripts. It performs bounded deterministic ingestion, refresh and
calculation (existing cron jobs stay). It does not run models, orchestrate agents, hold provider
login credentials, or invoke user applications unattended.

Priorities: **1. Usage** (environmental estimates as a sub-item) · **2. Audits** · 3. Assistant
(design after 1–2) · 4. News (unscheduled) · 5. AI Kits / Trace Linter / Control-Surface Diff
(rethink; Luumen debug-tool decomposition is exploration only).

Provider scope: Claude Code and Codex. Local tokens do not represent all account activity; quota
percentages are not tokens, cost or environmental measurements.

---

## 2. Ownership line — Decided

| Owned by the Luumen workspace (stays there) | Owned by the Observatory (`kit-board/`) |
| --- | --- |
| Audit execution: Codex agents, lanes, evidence packs, aggregation, brain validation, Slack delivery | Report intake, validation, immutable revisions, receipts, private HTML rendering, history and comparison views |
| The prompts themselves, `render-weekly-assurance-report.mjs`, templates, addenda, `workspace.yaml` | The report contract, producer identities, publish-credential verifiers |
| `luumen-brain` as the audit baseline store (`ai-assurance-history/`) | Nothing in `luumen-brain`; the Observatory does not become the baseline store in this plan |
| Luumen product code, Jira, Slack channel | — |

The Observatory is a **destination**. Luumen workflows publish into it; they do not depend on it to
run. No Luumen product code moves into this repository. What may eventually become a generic "audit
kit" is the report contract and renderer, extracted only when a non-Luumen codebase is audited
(§9, Deferred).

One repo fact reinforces the line from this side: `agentlint/scripts/check_fixture_hygiene.py`
rejects any fixture containing "luumen", so Luumen artifacts cannot be vendored into Kit 1 fixtures
even by accident.

---

## 3. Repository layout — Corrected

**There is no layout change to make.** The repository already has a root contract, stated in
`CONTRIBUTING.md` and re-affirmed by the move commit itself:

> three project directories that never import from each other, with fixtures, docs and CI inside
> each; root-level files limited to the README, CONTRIBUTING, the license, and `.github/workflows/`.

```
ai-kits/
  agentlint/       Kit 1 — Agent Trace Linter (Python)
  agent-surface/   Kit 2 — Agent Control-Surface Diff (Node)
  kit-board/       Personal Observatory — the whole of it
  .github/workflows/{agentlint,agent-surface,kit-board}.yml
```

Plan v4's four buckets are a **responsibility map, not directories**. Read them as:

| v4 bucket | Real location |
| --- | --- |
| `observatory/` (host app) | `kit-board/` — `proxy.ts` (auth + CSP boundary, at the package root, *not* `app/proxy.ts`), `app/`, `components/`, `lib/`, `supabase/migrations/`, `vercel.json` |
| `kits/usage` | `lib/{telemetry-contract,telemetry-store,usage,legacy-usage,cloud-estimate,cloud-estimate-store,reset-feeds,reset-feed-store,reset-calendar}.ts`; `scripts/telemetry/*.py`; `scripts/build-collector-bundles.py`; `browser/claude-quota/`; `app/(private)/usage/**`; `app/api/{v1/telemetry,usage-live,usage-connections,usage-calibrations,reset-feeds,internal/*}` |
| `kits/audits` | Not a subsystem — `audit` is one of five report kinds on a shared path: `lib/{artifact,artifact-runtime,assets,assets-store,report-selection}.ts`, `app/(private)/[section]/`, `app/api/v1/reports/**`, `app/api/artifacts/**`. Its only kind-specific code is the `full-audit` branch in `lib/report-selection.ts:7-8` |
| `tools/` | `kit-board/scripts/` — `publish.mjs`, `publish-assets.mjs`, `render-readings.mjs`, `build-report-ui.mjs`, `build-collector-bundles.py`, `test-routing-db.mjs`, and `scripts/telemetry/`. Note that two of these generate checked-in artifacts (`lib/generated/`) |

**Do not create root-level `observatory/`, `kits/` or `tools/` directories.** Two mechanisms make
that more expensive than it looks:

- All three CI workflows filter on top-level paths (`paths: ['kit-board/**']` and friends) and run
  with `working-directory: <project>`. Moving files above those prefixes disables CI **silently** —
  the workflows stop triggering, with no failure to notice.
- `kit-board/tsconfig.json:25-28` maps `@/*` to `./*` rooted at `kit-board/`. Every `@/lib/…`,
  `@/components/…` and `@/app/…` import in the app resolves against that root, so moving any of
  them out is a rewrite of the import graph, not a directory rename.

A split is reconsidered only when a second independent consumer or a distribution requirement
exists.

**The names stay.** `personal-hub` (npm package), `personal_hub` (database schema), the session
cookie and `~/.config/personal-hub/` are deliberately retained: `docs/repository-migration.md:33`
records that runtime names, production URLs, schema, home configuration directories and API
contracts remain unchanged across the move. They are not staleness and are not to be tidied up.

No package split, microservice, marketplace, remote plugin loading, or tenancy.

**Provenance** is already recorded in `docs/repository-migration.md` and
`docs/migration-source-inventory.json`; cite those rather than re-deriving them. That record also
sets this plan's own starting authority, at line 41: the move "implements directory ownership only:
Usage first, host receives externally executed workflows, no upfront kit framework. It does not
implement or approve the remainder of that roadmap." Everything past Phase 0b is therefore proposal,
not approved work.

That record had one gap — it predated the commit that landed the import — now closed by recording
`373fdbb714f1dbac365ad4e1829155136819723a` in it.

---

## 4. Integration surface — Decided, with implementation status

Publication and external execution are separate dimensions with separate authority.

- **Publication** (host-owned) — implemented. `received → accepted | duplicate | rejected`, resolved
  in one request, idempotent per `(producer, kind, idempotency_key)`. Full outcome table and the
  reachability caveat on the 409 path: [report-contract.md](report-contract.md) §4.
- **Reported execution** (producer-reported evidence): `unknown | running | succeeded | failed |
  cancelled`, with source and observation time. A failed audit can publish a valid failure report —
  `status: 'failed'` is accepted and stored, and `lib/report-selection.ts:6` excludes it from the
  default view without hiding it from history. No callback means unknown, never success.
- **Handoff record** (optional): `prepared | handed_off` only where the host actually observed it.
  Not implemented; no storage exists.

**Credentials.** Three mechanisms exist and stay distinct:

| | Report publishers | Telemetry connections | Browser quota |
| --- | --- | --- | --- |
| Verifier | SHA-256 in `INGEST_KEYS_JSON` env var | SHA-256 in `personal_hub.telemetry_sources` | same as telemetry |
| Scope | per report **kind** | per account/source | per account, quota-only |
| Revocation | env edit + redeploy | `disabled` flag, immediate | `disabled` flag |
| Enforced at | `lib/auth.ts:17-24` | `lib/telemetry-store.ts:25-32` | `lib/telemetry-store.ts:35` |

Scoping is per kind, never per subject or per producer-subject pair. A second audit producer
therefore gets the same breadth over the `audit` kind as the first.

**Disabling — Corrected.** Plan v4 listed a documented nonretryable disable response as existing
behaviour. It is not. Today there is no capability switch for report intake at all, and a disabled
telemetry source returns 401, which a retrying client cannot distinguish from a bad key. The one
scoped rejection that *is* well-formed is the browser-mode guard, which answers 403 "This connection
can publish quota readings only". Making disablement legible is Phase 5 work, and the Phase 5 gate
already states the target: nonretryable on disabled intake, receipts still returned for accepted
retries, history retained, and the UI saying external schedules may still be running.

**Compatibility.** These stay compatible: `app/(private)/usage/page.tsx`,
`app/(private)/[section]/page.tsx` (serves `/audit`, `/tasks`, `/standup`, `/readings` via
`lib/catalog.ts`), `app/api/reports/route.ts`, `app/api/v1/reports/[kind]/route.ts` (the generic
publish endpoint plan v4 omitted), `app/api/v1/telemetry/route.ts`, and the `publish.mjs` CLI flags.
Enabling anything never sends email, changes Jira, or launches an audit. `/kits/<id>/` is deferred.

---

## 5. Usage — Proposed plan

### Verified current state

Every line below was read at `373fdbb7`; nothing here is rebuilt.

- **Local token collection** — `scripts/telemetry/collect.py`. Recursively globs `*.jsonl`
  (`:152`) under roots defaulting to `~/.codex/sessions` + `~/.codex/archived_sessions` and
  `~/.claude/projects` (`:287`), overridable per connection via a `roots` array. It reads **no
  environment variables** — `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are not honoured; a non-default
  home must be an explicit absolute `roots` entry, and the roots list is pinned into the SQLite
  identity, so changing it later requires a new connection.
- **Claude dedup** — `sha256([provider, account_id, message.id])` (`:142`). There is no `requestId`
  component anywhere in the repo. Synthetic-model records are skipped.
- **Codex cumulative diffing** — implemented and tested. `process_line` diffs
  `info.total_token_usage` against the previous in-file snapshot, discards the delta if any
  component went negative, and persists the snapshot in SQLite (`:118-133`); covered by
  `test_codex_cumulative_duplicate_and_reset` in `tests/collector_test.py`. **Not an open gap.**
- **Codex allowance** — `save_codex_quotas` (`:85`) reads the `rate_limits` snapshot embedded in
  `token_count` events. No network call. Only `primary` and `secondary` windows.
- **Claude allowance** — `statusline.py` writes `five_hour` and `seven_day` readings into a
  `quota_inbox` directory, which `collect.py:289-293` drains (Claude connections only, and only
  those two window keys). A reading therefore exists only when Claude Code actually ran; an idle day
  produces none and there is no fallback.
- **Browser quota adapter** — `browser/claude-quota/`, documented as experimental. It runs inside a
  signed-in `claude.ai` tab and reads `/api/account`, `/api/organizations` and
  `/api/organizations/{id}/usage` with `credentials: 'same-origin'`, then posts to the Observatory
  with `credentials: 'omit'`. Requires an explicitly pinned organization.
- **No provider credential is ever read.** `collect.py` makes exactly two outbound requests, both to
  the Observatory's own origin: `/api/v1/telemetry` (`:236`) and `/api/reset-feeds` (`:307`). No
  file in this repository reads `~/.claude/.credentials.json` or `~/.codex/auth.json`.
- **Server model** — hourly observations are append-only revisions; the canonical row is chosen at
  read time per `(account_id, session_hash, hour, model)` by greatest call count, then greatest
  token total, then latest `observed_at`, then latest `received_at` (`lib/telemetry-store.ts:57-59`).
- **Schedules** — `install_schedule.py` installs an hourly macOS LaunchAgent (`StartInterval` 3600 +
  `RunAtLoad`) or a Windows `schtasks /SC HOURLY`. **On Linux it installs nothing.** Checkpointing,
  outbox and receipts live in the collector's SQLite, independently of the scheduler.
- **Monthly detail** — `detailed_report.py` is an hourly refresh of a month-to-date envelope that
  shells out to an operator-installed analyzer named by absolute path in the connection. The
  analyzers are **not in this repository**. It publishes to the same origin's `/api/reports` with a
  separate usage-publisher credential.
- Plus: allowance history and forecasts (`quotaPace`), public reset feeds, and two Vercel crons —
  `/api/internal/sync-legacy-usage` at `0 18 * * *` and `/api/internal/sync-reset-feeds` at
  `15 13 * * *`, both requiring `CRON_SECRET`.

### Data families — Decided, with storage reality

Usage observations · allowance observations · financial records · derived metrics · environmental
estimates · public reset announcements. Conceptual families, not six new tables — and today only
three have tables of their own:

| Family | Storage today |
| --- | --- |
| Usage observations | `personal_hub.token_bucket_revisions` |
| Allowance observations | `personal_hub.quota_samples` |
| Public reset announcements | `personal_hub.reset_feed_state` + `reset_feed_revisions` |
| Financial records | none — an **estimated** `api_equivalent_cost` arrives inside the monthly analyzer envelope (required at `scripts/telemetry/detailed_report.py:21-22`) and lives in `report_revisions.payload` |
| Environmental estimates | none — computed at render time from `environmental-factors.json` |
| Derived metrics | none — computed at read time (`quotaPace`, `tokenPace`) |

Provider, application, model, account, device and acquisition source stay distinct; original
identifiers preserved; UTC storage; explicit period boundaries; unknown ≠ zero; monthly reports are
presentation snapshots and are never added to hourly totals.

Two honest qualifications on those invariants:

- **UTC holds for the hourly and allowance families** — the hour bucket is validated to an exact UTC
  hour boundary (`lib/telemetry-contract.ts:8`). It does **not** hold for the monthly family, whose
  `period_key` is the analyzer's local calendar month. That is a deliberate, documented difference,
  not a defect, but it means the two families must never be joined on a date.
- **`unknown ≠ zero` holds where it matters most** — forecasts and live pace render `—` rather than
  0, and unpriced tokens are tracked explicitly. It does not hold in every monthly/connection view;
  a few absent counters still render as `0`. Worth a pass, not worth a phase.

**Extensibility constraint, made concrete.** `('codex','claude')` is hard-coded in six places:

1. `scripts/telemetry/collect.py:260` — the connection gate
2. `lib/telemetry-contract.ts:5` — `providerSchema`
3. `lib/telemetry-store.ts:31` — the source type
4. `app/(private)/usage/connections/page.tsx:31` — the provider picker
5. `supabase/migrations/20260909184129…:2` — `CHECK(provider IN ('codex','claude'))` on `usage_accounts`
6. `supabase/migrations/20260910193058…:5` — the same check on `agent_routing_events`

Plus one provider-specific rule: `lib/telemetry-contract.ts:37` allows browser-mode connections for
Claude only. A third provider is therefore a migration plus a contract change plus a UI change, not
an adapter drop-in. This is the single most useful thing Phase 0b can hand Phase 2, and it is why


**Known open mechanism — Decided.** Canonical selection cannot be regressed by appending a smaller
record: the app role holds `SELECT`/`INSERT` only, no `DELETE` is granted, and nothing rewrites an
observation. Downward corrections are out of scope until deliberately designed. One edge worth
recording: because call count outranks token total in the ordering, a record with a *higher* call
count and a *lower* token total does lower the canonical total.

### Audit runs as a usage source — answered

Plan v4 left this for Phase 0b. The repo settles most of it:

- A Tuesday audit's `usage-summary.json` is **never read** — `collect.py` globs only `*.jsonl` under
  its roots; its one `*.json` glob is the Claude quota inbox, gated to `provider=claude` and
  `window_key ∈ {five_hour, seven_day}`.
- The audit's **tokens** are nonetheless already captured, provided the audit's Codex sessions write
  rollout JSONL under a configured root on a machine running the collector — which is the normal
  case for `~/.codex/sessions`.
- Therefore audit-run usage is an **attribution view** (tag existing observations with a run id),
  not a new ledger. Confirming it needs one check on the owner's machine: that the session files for
  a known audit run are under a root in that machine's collector connection.

### Upstream reuse — Decided, with a scope correction

Inspect at most one upstream routine (CodexBar `9f4f544…`, OpenUsage `e2d9da8…`, ccusage
`556b6ee…`, UsageAtlas `459bbbb…`), and only if it fills the Phase 0b gap. Record source/ref,
notices, dependency review, tests, local changes, update owner, and a maintenance allowance.
Quarantine any adapter that can silently double-count or misattribute. "No reuse" is an acceptable
outcome. External usage-tool adapters are Phase 7, demand-gated.

**Correction to the companion survey.** None of those four repositories is present here, so no
statement about their source code is verified by this repo, and none should be recorded as fact in
it. The only in-repo trace is `docs/usage-collection.md`, which credits CodexBar with documenting
the `claude.ai` usage endpoints the browser adapter already uses, and warns they are unstable. Two
of the survey's conclusions need restating before use:

- "Direct Claude OAuth quota read is the gap" is imprecise. The Observatory **already reads Claude's
  account-wide usage endpoint**; what it lacks is an *unattended* path to it. Today the read needs a
  signed-in browser tab. The gap is a credential strategy, not an endpoint.
- Any proposal to add Anthropic's Admin `cost_report` must first overturn an existing recorded
  decision: `docs/usage-collection.md` excludes it on the grounds that it reports separately billed
  API usage rather than personal subscription consumption.

Restated, the real candidates are: **(1) Cursor — an entire missing provider**, structurally blocked
by the closed provider set above; **(2) unattended Claude allowance freshness**, since a reading
exists only when Claude Code runs; **(3) Codex credits and additional rate-limit windows**, which
`save_codex_quotas` does not collect. Neither parser is a gap.

### Environmental estimates — Corrected, Phase 4

A method already ships and is rendered on `/usage`: per-**call** energy and water scenario factors
with an explicit `methodology_version` (`2026-08-20.1`). Phase 4 is therefore to **review and bound
an existing method**, not design one: sources, assumptions, units, bounds, coverage, factor version.
A stated range or "no defensible number" remains a valid v0 output. Note the method keys on call
counts, not tokens — an assumption worth stating in the review, since it makes the estimate
independent of token volume. The paused cloud token-equivalent experiment is a separate input:
its calibration evidence and API support remain stored while nothing is displayed. Never gates Usage
core or views.

---

## 6. Audits — Proposed plan

### What exists

| Producer | Runs | Scope | Output | Delivers to |
| --- | --- | --- | --- | --- |
| Tuesday AI audit (`weekly-luumen-ai-audit`, Tue 09:00 CT) | Weekly, incremental | `luumen-ai-v2` at a pinned SHA; four specialist lanes; finding-drift lifecycle; Monday comparison | One standalone HTML report + compact run metadata + linked assets; `usage-summary.json`; `monday-comparison.json` | **Observatory** via `publish.mjs` + `publish-assets.mjs`; standing history in `luumen-brain` |
| Monday portfolio assurance | Weekly, portfolio | 19 repositories, four lanes each, aggregator, brain validation | `portfolio-report.json` (schema_version 1) + HTML + `.slack.md`; per-lane markdown kept local | **Slack only** |

Only the Tuesday producer is known to this repository, as a catalog entry
(`lib/catalog.ts:14`). The Monday workflow appears only in `docs/schedules.md` and publishes nothing
here.

What the report path enforces, and the eight places where convention is doing the work of a
contract, are in [report-contract.md](report-contract.md). Two facts govern the deliverables below:
`coverage.presentation: 'full-audit'` is load-bearing for which audit `/audit` shows by default, and
evidence assets must be UTF-8 text — **no PDF, PNG or ZIP can be published at all**.

### Deliverables in order

**A. Path repair (Phase 0a) — blocked.** The two audit prompts reference the publisher at its
pre-move location. Both prompts live outside this repository and both are explicit about the writes
they authorize, so **the edit is neither performed nor drafted here**; it is owner-authorized work,
tracked in §10.

Two scoping corrections for whoever does it. Plan v4 listed three things to update — `publish.mjs`,
`publish-assets.mjs` and `publish.json`. Only the first two moved: the publisher scripts now live
under `kit-board/scripts/` (see the repository README), while the credential file stays at
`~/.config/personal-hub/publish.json`, because the config directory name deliberately survived the
move (§3, "The names stay"). Changing it would break every other publisher on the machine. And the
verification step must assemble `<url>?report=<id>` itself — `publish.mjs` prints only the section
URL.

**B. Monday becomes a producer (Phase 1).** Add an Observatory publish step to the Monday
orchestrator *after* Slack delivery validation: a second `audit` producer with its own key and its
own `--subject`. Compact metadata from `portfolio-report.json`, the rendered HTML, and lane markdown
as linked private assets. Slack delivery is unchanged and stays independent: a publish failure must
not affect Slack or the audit.

Intake needs nothing new — idempotency, receipts and asset storage already separate producers.
The work is presentation: `/audit` is currently one history dropdown showing title, timestamp and
status only, with a single default across the whole kind. Distinguishing producers and subjects is a
four-file change — `lib/db.ts`, `lib/report-selection.ts`, `app/(private)/[section]/page.tsx`,
`components/report-view.tsx` — plus catalog copy, which still hard-codes "Luumen AI audit". No
schema work. `reportHistory` already selects `producer_id` and `subject_key`, so the data reaches
the client today and only the rendering omits it.

Owner authorization required: the Monday prompt states Slack is its only authorized external write.

**C. Report contract v1 + history (Phase 3).** Promote the conventions in
[report-contract.md](report-contract.md) §8 to guarantees, deliberately — named metadata fields, a
subject vocabulary, a producer registry, a declared `coverage` vocabulary. Add a per-subject history
view (score over time for the codebase audit; coverage and verdict counts for the portfolio) and a
compare view between consecutive runs of the same subject, read from stored metadata only. The
Observatory remains a presentation and receipt store; `luumen-brain` stays the baseline store.
Attach audit-run usage to the run record here, as the attribution view §5 establishes it to be.

**D. Generic audit kit — Deferred.** Extracting the evidence-pack, lane schemas, renderer and
template for a non-Luumen codebase is the real "Audits kit". Not scheduled until a second target
codebase exists.

---

## 7. Phases, hours, dates — Proposed

Assumptions: solo, sequential, **7 h/week (confirmed by the owner, 2026-09-11)**. Dec 21–Jan 1
excluded. Only 0a and 0b are committed; every later window is a budget envelope that 0b revises.
Overrun rule carried from plan v3.0: forecast >50% over → cut or split scope, never raise budget. A
scope cut cannot remove accounting or access-control correctness and still be called complete.

| Phase | Deliverable | Hours | Window |
| --- | --- | --- | --- |
| **0a** | Repair the two audit prompts' publisher paths (§6A) and verify one publish. **Repo-side portion complete**: post-move ref recorded, dirty-work step discharged, report contract v0 written down, weekly hours confirmed | 3–5, of which the repo-side share is done | prompt repair **blocked**; see §10 |
| **0b** | Usage inventory of actual account/platform/freshness coverage; one named gap; at most one upstream routine inspected; fixtures, baseline, reuse/no-reuse decision; revised estimates for Phases 1–5 | 8–12 ceiling | Sep 14 → Fri 2026-10-02 |
| **1** | Monday assurance publishes to the Observatory as a second producer; `/audit` distinguishes producers and subjects (§6B) | 6–8 | Oct 5 → Fri 2026-10-16 |
| **2** | One Usage improvement end to end from the 0b gap: source/normalization change only as needed, comparison mode that never feeds canonical totals, calculation, visible UI result; existing APIs preserved | 20–28, hard cap 30 | Oct 19 → Fri 2026-11-20 |
| **3** | Report contract v1, per-subject history and compare views, audit-run usage attribution (§6C) | 10–14 | Nov 23 → Fri 2026-12-18 |
| **4** | Environmental method review and bounds; one range-based view if supported | 6–8 | Jan 4 → Fri 2027-01-15 |
| **5** | Extract shared conventions Usage and Audits demonstrably share: registration, settings, accepted result versions, presentation, intake/enablement — including a legible disabled-intake response (§4); no dependency on agentlint | 8–10 | Jan 18 → Fri 2027-01-29 |
| 6 | Assistant design only | — | Feb 2027 |
| 7 | External usage-tool adapters | — | demand-gated, after 5 |
| 8 | Generic audit kit / AI Kits rethink / Luumen debug-tool exploration | — | unscheduled |

Total 0a–5: **61–87 h** (up to 89 if Phase 2 uses its cap). Capacity over ~18 active weeks at the
confirmed 7 h/week is ~126 h, so the plan fits with roughly a third of the period as slack.

0b's gap should be chosen from the three candidates in §5, and the choice is now better informed
than plan v4 allowed for: the parsers are not the gap, and Cursor is blocked behind a provider set
hard-coded in six places including two database constraints — which makes it the larger of the
coverage options and the one most likely to consume Phase 2's cap.

Sequencing rationale is unchanged: Phase 1 goes before the big Usage phase because it is small, uses
only existing machinery, and produces the second real producer that Phase 5 needs. Phase 2 remains
the largest block and starts within five weeks.

### Acceptance gates

- **0a:** the next Tuesday run publishes successfully from the new path with a verified receipt and
  renders at `<url>?report=<id>`. Repo-side facts recorded (done).
- **0b:** verified current-vs-target matrix; one named gap with a measurable success criterion;
  reuse/no-reuse with provenance; Phases 1–5 re-estimated with confidence stated.
- **1:** a Monday run produces a receipt and renders; Slack delivery unchanged; a simulated publish
  failure leaves the audit and Slack outcome intact; the index distinguishes producers and subjects.
- **2:** fixtures reconcile; repeated/reordered inputs safe; identities separated; overlapping
  sources do not inflate totals; partial data explicit; visible improvement; no regression in
  monthly reports or quota reads; comparison data never contaminates canonical totals.
- **3:** the contract document matches what both producers send *and* what the server enforces;
  history and compare views read from stored metadata only; a failed-status report appears in
  history correctly; historic reports and asset links still resolve.
- **4:** method reviewed; uncertainty and coverage visible; no unsupported numeric claim; ordinary
  Usage independent.
- **5:** both modules use the shared conventions; server-side behavior matches enablement; disabled
  intake is nonretryable **and distinguishable from an invalid credential**, while accepted retries
  return receipts; history retained; no provider-specific logic in the shell; no remote code loading.

Every phase additionally keeps `.github/workflows/kit-board.yml` green: `npm test`,
`npm run test:collector`, `npm run typecheck`, `npm run build`.

---

## 8. Rollout, verification, rollback — Decided

Additive compatibility changes; sanitized fixtures only; preserve source-scoped credentials, private
storage, original report dates, artifact isolation, monthly identities, existing schedules, and the
brain's role as audit baseline. Test duplicates/reordering, stale data, account changes, version
drift, cache-token accounting, source switching, failure states, and publish-failure independence.
Check workspace routing parity when a consumed contract changes; a new view never changes routing
admission or freshness policy. Rollback selects the prior adapter/source, blocks the failed adapter
from canonical observations, keeps intake open, retains outboxes/receipts/revisions/mappings, and
records source and calculation versions for corrections. Audit-prompt edits are reverted by
restoring the prior prompt text; the Observatory tolerates a producer that stops publishing.

Schema changes apply through `supabase/migrations/` in filename order, via an administrative
connection; the application identity deliberately cannot change schema or delete report history.
`npm run test:routing:db` validates every migration against a disposable local cluster.

---

## 9. Deferred — with reasons

- **Generic audit kit** (§6D): no second target codebase.
- **Observatory as audit baseline store:** would require the Tuesday audit to read history from the
  Observatory; today it reads `luumen-brain`. Not worth the coupling until history and compare views
  exist and prove useful.
- **Downward corrections to canonical usage:** needs a reconciliation mechanism; not designed.
- **Retention policy** for hourly history: nothing deleted until chosen.
- **Additional providers/OS:** after the 0b matrix. Note Linux is unscheduled by
  `install_schedule.py` today, and a third provider is blocked in six places (§5).
- **External usage-tool adapters:** Phase 7.
- **Binary evidence assets** (PDF/PNG/ZIP): rejected by the UTF-8 decode; no demand established.
- **Luumen debug-tool extraction:** tracked outside this repository.
- **AI Kits / Trace Linter / Control-Surface Diff freeze:** plan v4 called them frozen; the
  repository records no such thing, and reads as pre-release and maintained. If the freeze is real it belongs in
  `README.md` and `CONTRIBUTING.md` and should land with the tracker status update. **This document
  does not apply it** — that is a product statement for the owner, not an inference from code.
- **Multi-user/distribution:** separate design; current auth is not tenancy.

---

## 10. Open items

Resolved since plan v4:

1. ~~Weekly hours~~ — confirmed at 7 h/week, 2026-09-11. §7 dates stand.
2. ~~Post-move ref, current layout~~ — recorded in §0 and §3.
3. ~~Whether audit-run sessions already appear in collector output~~ — answered in §5, down to one
   machine-side check.

Still open:

1. **Authorization to edit two scheduled prompts** — the Tuesday path repair (§6A) and the Monday
   second-destination publish (§6B). Both prompts are explicit about what writes they authorize and
   both live outside this repository. **Blocked; no replacement text is drafted here.** The expected
   consequence of leaving the Tuesday repair undone is that the publish step fails on a missing
   script path while the audit itself still runs and its local artifacts survive — but that is an
   inference about a system this repository cannot see, not an observation. Confirm it against an
   actual run before relying on it.
2. **What `personal-brain` contains**, and whether any Usage or audit data should be read from it.
   Not inspected.
3. **Whether the AI Kits freeze is real** and should be written into the repository (§9).

---

## 11. Next implementer

The repo-side half of Phase 0a is done: the post-move ref is recorded, the dirty-work step is moot,
the report contract is written down, and hours are confirmed. What remains of 0a is the prompt
repair, which is blocked on §10 item 1.

Start 0b as an **inventory, not a refactor**. Use §5's verified current state as the baseline
instead of re-reading the collectors. Pick the gap from the three candidates there, size Cursor
honestly against the closed provider set, inspect at most one upstream routine, build fixtures, and
send revised estimates back to the owner.

Preserve existing schedules, brain ownership, routing ownership, and the root layout contract.
Nothing in this document authorizes audit execution, tracker changes, production changes, credential
handling, brain writes, or upstream code imports.
