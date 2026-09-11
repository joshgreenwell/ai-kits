# Usage collection architecture

Recorded 2026-09-11 against `948cc4a`. Answers the owner's direction of the same date: collect as
much detail as possible — window usage, per-model usage, tool information, whatever else is
available — across every way an AI might have been used, addressing each cleanly and reusing what
can be reused, with the least friction on the user.

Ladder, as stated: **usage API > automated local script > browser extension.** Read with the
[scoped usage-API token exception](observatory-plan.md#1-product-direction--decided).

Companions: [usage coverage inventory](usage-inventory.md) for what exists today;
[report contract v0](report-contract.md) for the publication path.

---

## 1. The finding that should shape expectations

**On current evidence the ladder inverts for detail.** Every *verified* primary channel in this
system needs **no provider credential at all** — local session logs, the statusline hook, Codex's
embedded `rate_limits`, the browser tab read — and those are the channels that yield **per-model
token counts**. Every API-shaped channel is unverified from this repository, and the ones that are
plausibly reachable yield **percentages**.

So the friction ladder is right as a *user-experience* principle and should be followed. But the
APIs mostly close a **freshness** gap, not a **detail** gap. The detail gap has a different answer,
and it is cheaper than any API work:

| Want | Where it already is | What it costs to get |
| --- | --- | --- |
| Per-model tokens, hourly | collected, stored, canonical | **nothing** — already there |
| Work mode, theme, root task, orchestration depth, knowledge-brain tool counts | **already shipped to the browser** and discarded in the render (`app/api/reports/route.ts:16` sends `envelope: payload` whole) | **one file** |
| Which machine an hour or a reading came from | stored on every row, dropped in the read (`lib/telemetry-store.ts:57-63`) | **one query** |
| Per-attempt model/effort/latency/outcome | fully contracted, migrated, authenticated — and **empty** | a producer |
| Per-tool breakdown | nowhere, in any tier | a contract addition + a producer |
| Credit balances, request-count limits | unrepresentable by `quotaSchema` | a separate record shape |
| Real billed money | nowhere | out of scope |

---

## 2. Three tiers, and the empty one

Detail in this system lives in three tiers that must never be summed together.

**Tier 1 — the hourly ledger.** `bucketSchema` → `token_bucket_revisions`. Keyed
`(account_id, session_hash, hour, model)`. Four exclusive token classes plus a call count. It is
narrow **on purpose** and should stay that way: its key *is* the canonical-selection key
(`lib/telemetry-store.ts:57-59`), so a new dimension either restates every historical total or
silently loses rows to the `calls DESC` tiebreak; its four classes are a partition enforced twice,
in Zod (`lib/telemetry-contract.ts:12`) and in SQL; and it is `.strict()`, so nothing rides along
optionally.

**Tier 2 — the monthly envelope.** Produced by operator-installed analyzers, published to
`/api/reports`. Far richer than tier 1: composition, projects, work modes, themes, root tasks,
orchestration depth, knowledge-brain tool counts, and a per-model/effort/service-tier cost estimate
with a pinned pricing catalog. **The whole envelope already reaches the authenticated browser**
(`app/api/reports/route.ts:16`). Most of it is simply not rendered.

**Tier 3 — the routing event ledger. This is the important one.** `agent_routing_events` has a
migration, a JSON-Schema contract, an authenticated endpoint, and the richest shape in the
repository. Per attempt it contracts `requested_model` vs `actual_model`, `requested_effort` vs
`actual_effort`, `wall_clock_ms`, `status`, an eleven-value `termination_reason`, a `usage` object,
and — notably — **`usage_source`**, a declared provenance field for which channel a number came
from. Plus task type, complexity, risk, quota state at decision time, and a `baseline`/`routed` arm.

**It has no writer and no reader.** The detail tier the owner is asking for is roughly 80% built and
completely empty. Filling it is a better investment than widening tier 1, and the contract already
anticipated the provenance problem that multi-channel collection creates.

### What the contract structurally cannot hold

- **Nothing is additive.** `bucketSchema`, `quotaSchema`, `telemetrySchema` and the coverage object
  are all `.strict()`. An unknown key is a 400, not a partial success.
- **Sub-hour structure is unrecoverable** — the hour is floored and validated as a floor.
- **The two tiers cannot be joined on a date** — tier 1 is an exact UTC hour, tier 2 is the
  analyzer's *local* calendar month.
- **`quotaSchema` is percentage-native**, capped 0–100 in Zod and again in SQL, and requires a
  future reset. A credit balance, a request-count limit, or an allowance without a cycle has no
  shape. Do not widen it — use a separate record on the `usage_calibrations` pattern.
- **Reasoning tokens cannot become a fifth class** — the four are a partition. Adding a
  non-exclusive sibling breaks the refine, the `CHECK`, and the "never sum revisions" rule.

---

## 3. Identity: the part that decides whether any of this is trustworthy

Many channels reporting one subscription is a double-counting problem first and a plumbing problem
second. Twenty-two concrete paths were enumerated; these are the ones that bite soonest, each
verified.

**Account-wide totals cannot enter tier 1 at all.** The canonical read deduplicates *within* a
`session_hash` and then sums *across* them (`lib/telemetry-store.ts:57-63`). An account-wide API
number has no session, so it would be summed alongside the per-session rows that already describe
the same usage. This is the single largest hazard in API-first collection, and it is structural: the
fix is that account-wide numbers are a different family, never a bucket.

**A Claude session's identity can degrade into a filename.** The event key is
`digest([provider, account, message.id])` with no session component, and the session falls back to
`path.stem` when a record carries no `sessionId` (`collect.py:170`, used at `:141`). The same usage
under two filenames produces two `session_hash` values and is summed.

**Bucket `observed_at` is the upload time, not the measurement time.** The collector stamps one
`iso()` per body (`collect.py:225`) and the server copies that single value onto every bucket
(`lib/telemetry-store.ts:40`). So the canonical tiebreak `observed_at DESC` means "most recently
uploaded". It carries no measurement information, and with two channels it decides winners
arbitrarily.

**Precedence is inferred from values, not declared.** `calls DESC, total_tokens DESC, …` is a safe
monotonic rule for one channel of one grain. With N channels of differing scope it means *whichever
channel reports the bigger number wins*, even when it is the known-worse one.

**A disabled source still renders.** `disabled` is consulted on exactly one path — upload
authentication. Deleting a connection in the UI sets it, and the readings stay on the dashboard.

**The system cannot answer "where did this number come from?"** `source_id` is stored on every row
and dropped inside the canonical CTE.

### The rules any multi-channel design must adopt

1. **An observation names its channel**, not just its source row. Today a source's only
   self-description is `mode`, closed to `local|browser` by an unnamed inline `CHECK`.
2. **The deduplication unit is the subscription, not the `account_id`.** Nothing today binds two
   account ids to one real subscription.
3. **Every row declares its grain, and totals never sum across grains.** Per-session and
   account-wide are different denominators.
4. **`session_hash` is a property of the session, not of the collector that found it**, and a
   guessed session is typed as a guess.
5. **`label` is display, never identity**; `window_key` encodes the window, not a prefix that
   happens to be unique today.
6. **Every observation carries the version of what produced it.**
7. **Identity survives removing a channel** — reads must respect `disabled`, not just uploads.
8. **Precedence is declared per family**, and differs by family. Allowance is a *level*: the
   highest-authority fresh reading wins outright. Tokens are a *sum*: channels must be partitioned
   so they cannot overlap, never merged by picking a winner.

---

## 4. The adapter seam

`collect.py` is a flat stdlib script whose `provider` string currently makes five independent
decisions at once — the connection gate, the file parser, the quota extractor, the default roots,
and the inbox drain. The seam splits on **acquisition mechanism, not provider**, giving three
adapter kinds that match the three real shapes:

- **Line** — walks files, parses lines, emits events and quota samples.
- **Snapshot** — reads a directory of already-normalised JSON, emits quota samples.
- **Fetch** — makes one bounded outbound request. It never opens a socket itself; the driver does.

The adapter never touches the database. It is handed a **sink** with three methods, and the sink —
not the adapter — owns the `window_key` namespace, prepends `(channel, provider, account)` to every
identity, and *rejects* anything the wire would reject. That last point is load-bearing: one
out-of-range `used_percent` currently 400s an entire body, and the outbox will replay it forever.

Everything else is shared and must not be reimplemented per channel: the SQLite offset/checkpoint
model with rotation and truncation detection, the per-file parser context, event dedup with
component-wise maxima, quota hour-slotting, identity pinning, backfill-start pinning, the
single-run lock, batching, the outbox and receipts.

**Constraints the seam must survive**, all verified: pure stdlib with no dependencies; the whole
directory is zipped and shipped, and `build-collector-bundles.py` iterates non-recursively and
filters by suffix — so **a `channels/` subdirectory would ship nothing and CI would stay green**; a
sibling import breaks all five existing tests, which load `collect.py` by spec without putting its
directory on `sys.path`; and `open_state` is `CREATE TABLE IF NOT EXISTS`, so **a new column is
never added to an existing state DB** — new tables only.

---

## 5. The path

Two verified facts set the order.

**The wire is `.strict()` in four places**, so the only safe direction is *server accepts before
collector sends*, and every addition must be optional. A server tolerating a field nothing sends is
an inert no-op; a collector sending a field nothing accepts is an outage on every machine at once.

**A collector change can only be pulled, never pushed.** `install_schedule.py` pins an absolute path
to the already-installed script, so a new collector reaches a machine only when the owner
re-downloads it. Every collector step must therefore leave older collectors working.

| # | Step | Hours | Notes |
| --- | --- | --- | --- |
| 1 | Baseline + machine-side checks | 2–4 | **Start first — it is the only step that expires** |
| 2 | Name the three unnamed inline `CHECK` constraints, changing no predicate | 2–3 | Turns every later widening from a guess into a one-line `ALTER` |
| 3 | Per-observation provenance (`collector_version`, `channel`); stop rendering disabled sources | 4–6 | Nullable columns; no collector change |
| 4 | Adapter seam, **no behaviour change** | 4–6 | Pure refactor; bundle regeneration required |
| 5 | Widen what the two existing channels already capture | 6–10 | Gated on step 1 — may correctly surface nothing |
| 6 | Server accepts a detail sidecar that nothing yet sends | 5–8 | Optional array; every existing body still validates |
| 7 | Collector emits per-tool detail | 5–8 | Strictly after 6, never alongside |
| 8 | **Half A** — make the instrument tell the truth | 8–12 | Adopts the stricter model the routing subsystem already has |
| 9 | **Half B** — browser read into the service worker | 14–20 | **Does not need the credential exception**; gated on the spike |
| 10 | Credentialed unattended read from the local script | 6–10 | **The first step that uses the exception** — late and small |
| 11 | Widen the provider enum, mechanically | 6–9 | Only once there is something to put in it |

Steps 1–4 unblock everything and need no product decision. The credential exception is not spent
until step 10, and step 9 delivers real freshness without it.

### Deliberately not doing

- **Not widening `bucketSchema`.** Most expensive surface in the repo, and its invariants are worth
  keeping.
- **Not widening the provider enum first.** A typecheck cascade into the routing subsystem, plus two
  unnamed constraint migrations — and pointless before anything can collect the new provider.
- **Not building a generic plugin framework.** A module-level table and a `for` loop. The repo rules
  out remote code loading, and dynamic module discovery would break the ZIP distribution anyway.
- **Not making the browser extension primary.** Highest friction on the owner's own ladder, and the
  code agrees — a signed-in tab in the right profile, an explicitly pinned organisation.
- **Not changing an existing connection's roots.** They are inside the pinned SQLite identity;
  changing them requires a new connection.
- **Not shipping a collector or docs change without regenerating the bundle.** CI diff-gates it, and
  `usage-collection.md` is embedded inside both ZIPs.
