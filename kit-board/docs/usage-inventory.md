# Usage coverage inventory (Phase 0b)

Recorded 2026-09-11 against `f185f9d`. This is the Phase 0b inventory the
[plan of record](observatory-plan.md) §7 commits to: what Usage actually covers, where it is thin,
and what one improvement would cost. It is an **inventory, not a refactor** — no behaviour changes
here.

## What this document can and cannot establish

Phase 0b's acceptance gate asks for "actual account/platform/freshness coverage". Source code cannot
answer that. Three different things get confused under the word "coverage", and this document keeps
them apart:

| | Question | Answerable here? |
| --- | --- | --- |
| **Capability** | Could the system collect X at all? | **Yes** — §1, from code |
| **Configuration** | Is X set up on the owner's machines? | **No** — `docs/schedules.md` records it as of 2026-09-10; that is dated evidence, not current fact |
| **Freshness** | How old is the newest datapoint right now? | **No** — needs the production database. §4 makes it a two-minute check |

Wherever this document says "supported", it means the code path exists. It never means it is running.

---

## 1. Capability coverage

Condensed from a 26-row matrix. Status is about the code, not the deployment.

### Tokens

| Provider · channel | macOS | Windows | Linux | Yields |
| --- | --- | --- | --- | --- |
| Claude Code local JSONL | supported | supported | **unscheduled** | exclusive input / cache-read / cache-write / output + calls, per (session, UTC hour, model) |
| Codex local JSONL | supported | supported | **unscheduled** | same shape, derived by diffing cumulative counters |
| Claude Desktop Code / Cowork profiles | partial | partial | partial | same shape, but only via an explicit `roots` entry set **before the first scan** |
| Claude Desktop / claude.ai chat | — | — | — | **structurally blocked**: no per-message token ledger exists upstream |
| ChatGPT web/desktop chat | — | — | — | **structurally blocked**: "Codex" here means the CLI's rollout JSONL and nothing else |
| Cursor | — | — | — | **structurally blocked**: provider set closed in six places, two of them database `CHECK` constraints |

Linux is *unscheduled*, not blocked: `collect.py` is pure stdlib and platform-neutral, but
`install_schedule.py` handles only `darwin` and `win32` (`:25`, `:42`) and exits with a message
otherwise. The gap is the installer.

Windows collection is *interactive-only* — `schtasks … /IT` (`install_schedule.py:44`) — so a
logged-off machine collects nothing and reports no error.

### Allowance

| Provider · channel | Windows covered | Trigger | Honest limitation |
| --- | --- | --- | --- |
| Claude · statusline inbox | `five_hour`, `seven_day` only | **a human runs Claude Code** | No unattended path. Doubly narrowed: `statusline.py:14` emits two, `collect.py:293` whitelists the same two |
| Claude · browser adapter | richer — includes per-model / per-surface weekly windows | hourly alarm, needs a signed-in `claude.ai` tab and a pinned org | Experimental; unofficial endpoints; upload host hard-coded |
| Codex · embedded `rate_limits` | `primary`, `secondary` only | **parasitic on token activity** — only when a `token_count` event fires | Everything else in the object is dropped at `collect.py:87` |
| Codex · credits, per-model windows | none | — | Dropped at the collector, so no server or UI change can recover it. **The wire contract would accept them unchanged** |

That last row is worth restating: `quotaSchema.window_key` is a 1–100 character
`[a-zA-Z0-9._:-]` string (`lib/telemetry-contract.ts:15`). Additional *windows* need no schema
change at all. Credits are a different matter — they are a balance, not a percentage, and
`used_percent` is constrained to 0–100.

### Cost, environment, and everything else

- **Billed money: absent.** No table, no field, no code path. The only money-shaped number is
  `api_equivalent_cost`, a modelled price required inside the monthly analyzer envelope
  (`scripts/telemetry/detailed_report.py:21-22`). It is an estimate under the analyzer's own
  versioned pricing, not a charge, and it lives in `report_revisions.payload` with no table.
- **Environmental estimates: render-time only.** Computed per **call** from
  `environmental-factors.json` (`methodology_version` `2026-08-20.1`). Nothing is stored, so a
  factor change silently restates history.
- **Monthly detailed envelopes** depend on operator-installed analyzers that are **not in this
  repository**. Cloning does not reproduce them.
- **Legacy compatibility sync**: one hard-coded endpoint, daily at 18:00 UTC, holding the old
  dashboard's credentials. Temporary by design.
- **Public reset feeds**: four allowlisted third-party sources. Claims about the world, never
  observations of the owner's account.
- **Agent routing events**: an append-only ledger with **no writer and no reader**. Nothing in this
  repository emits routing events, and no page renders them. It inherits the same closed provider
  `CHECK`.

---

## 2. The freshness model

Every threshold, from code. These are the numbers any freshness claim has to be stated against.

| Threshold | Value | Where |
| --- | --- | --- |
| Future-observation tolerance | +5 min | `lib/telemetry-contract.ts:4` |
| **Maximum age at ingest** | **none** | an arbitrarily old reading is accepted |
| Allowance staleness | age > 120 min, or reset passed | `lib/telemetry-contract.ts:46` |
| Minimum history for a burn rate | 30 min | `:57` |
| Segment break | gap > 3 h, a decrease, changed reset anchor, or > 24 h | `:52-53` |
| Collector heartbeat "recent" | every enabled local source within 2 h **and** zero coverage defects | `app/(private)/usage/live/page.tsx:17` |
| Canonical read windows | 35 days buckets, 9 days quota | `lib/telemetry-store.ts:58, 65` |
| Dashboard cache | 30 s | `:79` |
| Client poll | 60 s, suspended when the tab is hidden | `components/telemetry-shared.tsx:36` |
| Reset-feed lease | 30 min | `lib/reset-feed-store.ts:21` |
| Collector cadence | hourly, fixed in code | `install_schedule.py:38, 44` |

The system says honest things in many places — "Stale reading", "Waiting for fresh local
collection", "Awaiting new window", a partial-coverage banner, and a monthly view that suppresses
prior-month deltas while a month is in progress. The cloud-estimate path is the strictest model in
the repository and refuses with specific, well-worded reasons.

### Four holes, each verified against the code

1. **The 24-hour token card renders a dead collector as `0`.**
   `{rows.length ? tokens(pace.tokensLast24Hours) : '—'}` (`live/page.tsx:41`) is gated only on
   `rows.length`, which spans the **35-day** read window. The two cards beside it — "Recent burn"
   and "Next 24 hours" — are correctly gated on `recent`. So a collector that died ten days ago
   produces "0" in one card and "—" in the two next to it, in the same row.

2. **"Updated …" is the server's read time, not the data's.**
   `as_of: new Date().toISOString()` is stamped when the cache loader runs
   (`lib/telemetry-store.ts:77`) and rendered as `Updated {when(data.as_of)}` (`live/page.tsx:39`).
   With a 30-second cache TTL it advances forever, however old the data is.

3. **Readings from a disabled source still render, indistinguishably.**
   The dashboard quota query has no source join and no `disabled` predicate
   (`lib/telemetry-store.ts:64-65`). Note that "deleting" a connection in the UI *is*
   `disabled = true` (`app/api/usage-connections/route.ts:17`) — so a connection the owner believes
   they removed keeps rendering its last reading.

4. **Absent coverage counters fail open.** `malformed_lines` and `unavailable_roots` are optional
   (`lib/telemetry-contract.ts:26`); an older collector that omits them reads as clean coverage. In
   the monthly view, an absent prior-month total renders as a real `↑ 0.0%` comparison
   (`usage/page.tsx:359-361`, rendered `:446`).

### The finding that reframes all of it

**A stricter, more correct freshness model already exists in this repository, over the same table,
and the dashboard does not use it.**

`lib/routing-quota.ts:40` defines staleness as observation age > 7200 s **or** reset passed **or
source heartbeat age > 7200 s**. And `lib/routing-store.ts:89` reads quota samples with
`JOIN personal_hub.telemetry_sources s ON s.id = q.source_id … AND NOT s.disabled`.

That is holes 2 and 3 already solved, ten lines away, by the same author, in a subsystem that has no
UI. The dashboard's `quotaPace` (`lib/telemetry-contract.ts:46`) has neither the heartbeat term nor
the join. Two irreconciled definitions of "stale" over one table is itself the defect.

---

## 3. Candidate gaps

*(pending — sizing in progress)*

---

## 4. What only the owner's machine can settle

Eleven read-only checks. Every command was audited line by line against the collector's real SQLite
schema (`collect.py:46-62`: `meta`, `files`, `events`, `quotas`, `outbox`, `receipts`; `files.mtime`
is `st_mtime_ns`; state lives at `<config dir>/<source_id>.sqlite3`, `collect.py:262`).

**None of these commands prints a credential.** Where a file contains one, the command selects only
safe fields or reports presence as a boolean. Three deliberate exclusions are load-bearing and should
not be "simplified" away:

- Check 1 prints `key_present: true/false`, never the key.
- Check 6 fetches `['pin','lastSuccess','lastError','lastWindows']` from extension storage.
  `chrome.storage.local.get(null)` **would** print the 43-character upload key.
- Check 11 reads `~/.claude/settings.json` but extracts only `statusLine.command`, and prints only
  whether it is configured plus the `--inbox` path.

Two checks read files containing prompt or response text (session JSONL, collector state). Neither
prints a line, a value, or a message — only key names, counts, and timestamps.

*(full check list — pending)*

---

## 5. Decision and revised estimates

*(pending)*
