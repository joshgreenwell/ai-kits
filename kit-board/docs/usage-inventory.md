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
| Cursor | — | — | — | **structurally blocked**: provider set closed in ten places, two of them unnamed database `CHECK` constraints |

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

## 3. Candidate gaps, sized

Each candidate was sized against every file it touches, then adversarially re-reviewed. Phase 2's
budget is 20–28 h, hard cap 30, and it must deliver a source change *only as needed*, a comparison
mode that never feeds canonical totals, a calculation, and a visible UI result.

| Candidate | First estimate | After review | Fits Phase 2? |
| --- | --- | --- | --- |
| Cursor — a third provider | 26–44 h | **26–46 h** (sound) | **No** |
| Codex additional windows | 6–14 h | **10–18 h** (understated) | Partly — but may deliver nothing |
| Unattended Claude allowance | 20–28 h | **24–34 h** (understated) | Only conditionally |

### Cursor — not a Phase 2 item, and the negative result is the finding

Cursor fits **neither shape the contract accepts**. `bucketSchema` requires four exclusive token
classes that sum to a total (`lib/telemetry-contract.ts:10-12`); `quotaSchema` requires a
`used_percent` of 0–100 and a future `resets_at` (`:13-18`), doubly enforced by
`CHECK(used_percent BETWEEN 0 AND 100)` in SQL (`20260909184129…:27`). On the owner's own survey —
which this repository cannot verify — Cursor exposes no local per-request token log, and its real
data is per-request dollar cost behind a dashboard API. Neither shape holds that.

Three further blocks, each verified:

- **Ten closure sites**, two of them unnamed inline `CHECK` constraints (plan §5).
- **`scripts/telemetry/detailed_report.py` raises on an unknown provider** — five branches at
  `:63, :71, :81, :87` and an explicit `raise ValueError('Unsupported report provider')` at `:75`.
  It is absent from any provider-widening checklist because nothing fails until it runs.
- **Collection would need a provider credential**, which plan §1 lists as **Decided**: the
  Observatory "does not … hold provider login credentials". That is a product line, not an
  engineering cost, and Phase 2 cannot spend it.

Cursor is therefore a schema-and-product question to answer deliberately, not a gap to close in a
budgeted phase. The one cheap fact that would move it is a machine-side check: does Cursor write any
local per-request log at all?

### Codex additional windows — cheap, and possibly empty

The genuinely good news: **additional percentage-shaped windows need no schema change, no migration
and no UI change.** `quotaSchema.window_key` is a permissive 1–100 character string
(`lib/telemetry-contract.ts:14`), the database accepts any key (`20260909184129…:26-31`), and
`app/(private)/usage/live/page.tsx:26-29` renders one card per distinct `window_key`
unconditionally. The change is essentially the `('primary','secondary')` tuple at `collect.py:87`.

Three reasons it is not the answer:

1. **Nothing in this repository establishes that Codex emits anything else.** The only `rate_limits`
   fixture anywhere is `tests/collector_test.py:66`, which has exactly `primary` and `secondary`.
   This candidate could ship correctly and surface zero new windows.
2. **Credits are unrepresentable.** A balance is not a percentage; `quotaSchema` is `.strict()` and
   `used_percent` is capped at 100 in both Zod and SQL.
3. **It contains no comparison mode**, so it does not satisfy what Phase 2 owes.

Two latent defects widening the iteration would expose, both verified: `collect.py:94` builds
`window_key` from the **top-level** `rate_limits.limit_id`, so windows are distinguished only by
`window_minutes` and a third window sharing a duration would collide; and the label formatter at
`:95` emits `Codex · 0h` for any window under 60 minutes, since only `10080` gets a word.

### Unattended Claude allowance — the right target, on a premise that needs one spike

Of the three routes, only one is affordable:

- **(a) Read Claude's OAuth credential from `collect.py`.** Blocked by the same Decided product line
  as Cursor. This would also be the first provider network call the collector ever makes.
- **(b) Move the browser adapter's read from an open tab into its service worker.** ~6–10 h for the
  source change, leaving room for the rest of Phase 2. **Its premise is unverifiable here**: whether
  an MV3 service-worker fetch to `claude.ai` carries the profile's session. That is a two-hour spike,
  and Phase 2 should not be committed before it runs.
- **(c) Widen what `statusline.py` captures.** Improves *coverage* of windows, not *freshness* — the
  reading still only exists when a human runs Claude Code. Worth doing, but it is not this gap.

---

## 3a. Three landmines for anyone comparing two allowance sources

Phase 2's comparison mode most naturally compares the browser adapter against the statusline for the
same window. Three verified facts make that harder than it looks:

1. **`quota_samples` deduplicates on `UNIQUE(account_id, content_hash)` with no `source_id`**
   (`20260909184129…:29`), and `content_hash` is hashed over the quota object alone
   (`lib/telemetry-store.ts:42`). Two sources are distinguishable only because their payloads happen
   to differ.
2. **And they do differ, in ways nobody chose.** For the same five-hour window the browser emits
   `label: '5-hour allowance'` (`browser/claude-quota/normalize.js:20`) while the statusline emits
   `'Claude · 5h'` (`scripts/telemetry/statusline.py:67`); their `resets_at` strings also differ in
   fractional-second format between `Date.toISOString()` and Python's `isoformat()`. The UI groups
   purely by `window_key` (`live/page.tsx:26-28`), so the label shown for a window depends on which
   source wrote last. Whether the `resets_at` difference survives to `quotaPace`'s raw string compare
   (`lib/telemetry-contract.ts:51`) depends on `timestamptz` normalisation on read — **test it, do
   not assume it either way.**
3. **The documented operating model puts the two sources on different accounts.**
   `docs/usage-collection.md:44` says to give the browser connection "a distinct account ID such as
   `claude-personal`". Two sources on *different* accounts cannot be compared per-account at all.

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

**1. Which connections exist on this machine, with roots, quota inbox and state DB**

```
python3 - ~/.config/personal-hub/telemetry <<'PY'
import json,sys,pathlib
base=pathlib.Path(sys.argv[1]).expanduser()
if not base.is_dir(): print(json.dumps({'dir':str(base),'exists':False})); raise SystemExit
for p in sorted(base.glob('*.json')):
    try: c=json.loads(p.read_text())
    except Exception: continue
    if 'source_id' not in c: continue
    db=p.parent/(c['source_id']+'.sqlite3')
    print(json.dumps({'file':p.name,'provider':c.get('provider'),'mode':c.get('mode'),
      'account_id':c.get('account_id'),'source_id':c.get('source_id'),
      'roots':c.get('roots','(default)'),'quota_inbox':c.get('quota_inbox'),
      'detailed_report':bool(c.get('detailed_report')),'key_present':bool(c.get('key')),
      'state_db':db.name,'state_db_exists':db.exists()}))
PY
```

**2. Whether a Tuesday audit run's Codex sessions are under a collected root — settles plan §5**

```
python3 - ~/.config/personal-hub/telemetry 2026-09-09 <<'PY'
import json,sys,os,pathlib,sqlite3,collections
from datetime import datetime,timedelta
base=pathlib.Path(sys.argv[1]).expanduser(); day=sys.argv[2]
d=datetime.fromisoformat(day+'T00:00:00').astimezone()
lo,hi=int(d.timestamp()*1e9),int((d+timedelta(days=1)).timestamp()*1e9)
for p in sorted(base.glob('*.json')):
    try: c=json.loads(p.read_text())
    except Exception: continue
    if c.get('provider')!='codex' or c.get('mode')!='local' or 'source_id' not in c: continue
    dbp=base/(c['source_id']+'.sqlite3')
    out={'connection':p.name,'account_id':c.get('account_id'),'day':day,
         'roots':c.get('roots','(default codex roots)'),'state_db_exists':dbp.exists()}
    if dbp.exists():
        db=sqlite3.connect(dbp.as_uri()+'?mode=ro',uri=True)
        rows=[r[0] for r in db.execute('SELECT path FROM files WHERE mtime>=? AND mtime<?',(lo,hi))]
        out['indexed_session_files']=len(rows)
        out['directories']=collections.Counter(os.path.dirname(r) for r in rows).most_common(5)
    print(json.dumps(out,indent=2))
PY
```

**3. Which Claude allowance windows are offered vs kept — reads the statusline sidecar**

```
python3 - ~/.config/personal-hub/telemetry <<'PY'
import json,sys,pathlib
base=pathlib.Path(sys.argv[1]).expanduser()
for p in sorted(base.glob('*.json')):
    try: c=json.loads(p.read_text())
    except Exception: continue
    if c.get('provider')!='claude' or not c.get('quota_inbox'): continue
    inbox=pathlib.Path(c['quota_inbox']).expanduser()
    f=inbox.parent/'claude-statusline-status.json'
    if not f.exists():
        print(json.dumps({'connection':p.name,'inbox':str(inbox),'sidecar':str(f),'exists':False})); continue
    s=json.loads(f.read_text())
    print(json.dumps({'connection':p.name,'sidecar':str(f),'exists':True,
      **{k:s.get(k) for k in ('last_invocation_at','invocations','claude_code_version','entrypoint','rate_limits_present','rate_limit_keys','published_windows','last_published_at')},
      'discarded_windows':sorted(set(s.get('rate_limit_keys') or [])-{'five_hour','seven_day'}),
      'inbox_samples':len(list(inbox.glob('*.json'))) if inbox.is_dir() else None},indent=2))
PY
```

**4. What the Codex rate_limits object actually contains — settles candidate 2**

```
python3 - ~/.codex/sessions <<'PY'
import json,sys,pathlib,collections
root=pathlib.Path(sys.argv[1]).expanduser()
files=sorted((p for p in root.rglob('*.jsonl') if not p.is_symlink()),key=lambda p:p.stat().st_mtime,reverse=True)[:25]
shapes,newest=collections.Counter(),None
for p in files:
    for line in p.open('rb'):
        if b'rate_limits' not in line: continue
        try: d=json.loads(line)
        except ValueError: continue
        rl=(d.get('payload') or {}).get('rate_limits')
        if not isinstance(rl,dict): continue
        shapes[json.dumps({k:(sorted(v) if isinstance(v,dict) else type(v).__name__) for k,v in rl.items()},sort_keys=True)]+=1
        newest=newest or {'observed':d.get('timestamp'),'keys':sorted(rl),
          'collected':[k for k in ('primary','secondary') if isinstance(rl.get(k),dict)],
          'dropped':[k for k in rl if k not in ('primary','secondary','limit_id','limit_name')]}
print(json.dumps({'files_scanned':len(files),'distinct_shapes':[json.loads(s) for s in shapes],'newest':newest},indent=2))
PY
```

**5. Whether the Windows hourly task is installed (Windows only)**

```
schtasks /Query /TN "Personal Observatory Usage <source-id>" /V /FO LIST
```

**6. Whether the browser connection is paired, and to which organization**

```
chrome.storage.local.get(['pin','lastSuccess','lastError','lastWindows']).then(s=>console.log(JSON.stringify(s,null,2)))
```

**7. Which collector version each machine has deployed**

```
grep -n "^VERSION" ~/.config/personal-hub/telemetry/collect.py "$LOCALAPPDATA/PersonalObservatory/collect.py" /path/to/each/deployed/collect.py 2>/dev/null
```

**8. Which collector version the server last received, and each source's heartbeat**

```
fetch('/api/usage-live').then(r=>r.json()).then(d=>console.table(d.sources.map(s=>({machine:s.machine_label,account:s.account_id,mode:s.mode,disabled:s.disabled,last_seen_at:s.last_seen_at,collector_version:s.coverage&&s.coverage.collector_version,files:s.coverage&&s.coverage.files,unavailable_roots:s.coverage&&s.coverage.unavailable_roots,malformed_lines:s.coverage&&s.coverage.malformed_lines}))))
```

**9. How fresh the newest bucket and quota sample are per account — the 0b baseline**

```
fetch('/api/usage-live').then(r=>r.json()).then(d=>{const m={};for(const r of d.hourly){const a=m[r.account_id]??={};if(!a.hour||r.hour>a.hour)a.hour=r.hour;}for(const q of d.quotas){const a=m[q.account_id]??={};if(!a.quota_observed_at||q.observed_at>a.quota_observed_at){a.quota_observed_at=q.observed_at;a.window_key=q.window_key;}}console.log('as_of',d.as_of);console.table(d.accounts.map(a=>({account:a.id,provider:a.provider,newest_bucket_hour:m[a.id]?.hour??'none in 35d',newest_quota_at:m[a.id]?.quota_observed_at??'none in 9d',newest_quota_window:m[a.id]?.window_key??'—'})))})
```

**10. Whether a machine holds data the server does not: stuck outbox, unsent quotas**

```
python3 - ~/.config/personal-hub/telemetry <<'PY'
import json,sys,pathlib,sqlite3
base=pathlib.Path(sys.argv[1]).expanduser()
for p in sorted(base.glob('*.json')):
    try: c=json.loads(p.read_text())
    except Exception: continue
    if c.get('mode')!='local' or 'source_id' not in c: continue
    dbp=base/(c['source_id']+'.sqlite3')
    if not dbp.exists(): print(json.dumps({'connection':p.name,'state_db_exists':False})); continue
    db=sqlite3.connect(dbp.as_uri()+'?mode=ro',uri=True)
    g=lambda q:(db.execute(q).fetchone() or [None])[0]
    q=[json.loads(r[0]).get('observed_at') for r in db.execute('SELECT payload FROM quotas')]
    print(json.dumps({'connection':p.name,'provider':c.get('provider'),'account_id':c.get('account_id'),
      'pinned_since':g("SELECT value FROM meta WHERE key='since'"),
      'files_checkpointed':g('SELECT count(*) FROM files'),
      'newest_event_hour':g('SELECT max(hour) FROM events'),
      'quota_readings':g('SELECT count(*) FROM quotas'),'quota_unsent':g('SELECT count(*) FROM quotas WHERE sent=0'),
      'newest_quota_observed_at':max([x for x in q if x],default=None),
      'outbox_pending':g('SELECT count(*) FROM outbox'),
      'last_receipt_at':g('SELECT max(received_at) FROM receipts')},indent=2))
PY
```

**11. Whether the statusline hook and the Claude connection point at the same inbox**

```
python3 - ~/.claude/settings.json ~/.config/personal-hub/telemetry ~/.config/personal-hub <<'PY'
import json,sys,re,pathlib
s=pathlib.Path(sys.argv[1]).expanduser()
cmd=None
if s.exists():
    try: cmd=(json.loads(s.read_text()).get('statusLine') or {}).get('command')
    except Exception: cmd='(unparseable)'
hook=re.search(r'--inbox\s+(\S+)',cmd or '')
conf=[]
for p in sorted(pathlib.Path(sys.argv[2]).expanduser().glob('*.json')):
    try: c=json.loads(p.read_text())
    except Exception: continue
    if c.get('provider')=='claude' and c.get('quota_inbox'): conf.append({'file':p.name,'quota_inbox':c['quota_inbox']})
ob=pathlib.Path(sys.argv[3]).expanduser()/'outbox'
files=sorted(ob.iterdir()) if ob.is_dir() else []
print(json.dumps({'statusline_configured':bool(cmd),'statusline_mentions_hook':bool(cmd and 'statusline.py' in cmd),
 'hook_inbox':hook.group(1) if hook else None,'connection_quota_inbox':conf,
 'publisher_outbox_dir':str(ob),'outbox_unpublished':[f.name for f in files if f.name.endswith('.json')][-10:],
 'outbox_published':sum(1 for f in files if f.name.endswith('.published'))},indent=2))
PY
```

Checks 5, 6, 8 and 9 are not shell commands. 5 is Windows-only. 6 runs in the extension's own
service-worker console (`chrome://extensions` → Developer mode → the collector → "service worker").
8 and 9 run in DevTools on a signed-in Observatory tab, because `proxy.ts` gates `/api/` on the
session cookie — a `curl` equivalent would need that cookie on the command line, which is exactly
what should not happen.

Run **9 first and keep its output**: it is the Phase 2 baseline, and it cannot be reconstructed
later.

---

## 5. Decision

### The named gap

**Claude allowance freshness — which is unmeasurable before it is unattended.**

The gap has two halves, and the order matters more than either half:

> **Half A — the instrument.** Reconcile the two staleness definitions and fix the four holes in §2.
> **Half B — the source.** Move the browser adapter's read out of an open tab.

Half A comes first because **Half B's success criterion cannot be measured until Half A lands.** A
dashboard whose "Updated" line always says *now*, which renders readings from sources the owner has
deleted, and which shows a dead collector's 24-hour total as `0`, cannot be used to demonstrate that
freshness improved. Fixing the measurement instrument is not a detour from the gap; it is the first
half of it.

Half A is also unusually cheap, because **the correct implementation already exists in this
repository.** `lib/routing-quota.ts:40` already treats a reading as stale on observation age **or**
reset passed **or** source-heartbeat age; `lib/routing-store.ts:89` already joins
`telemetry_sources` with `AND NOT s.disabled`. The dashboard's `quotaPace` has neither. Half A is
largely the work of making the dashboard agree with the subsystem sitting next to it — and one
reconciled definition of "stale" over one table is a better outcome than two.

### Why not the other two

**Cursor** is not a Phase 2 item at any budget: it fits neither accepted schema, and collecting it
would need a provider credential that plan §1 rules out as **Decided**. It is a product question.

**Codex additional windows** is cheap and worth doing — but nothing in this repository establishes
that Codex emits any window beyond `primary` and `secondary`, so it could ship correctly and surface
nothing. Machine-side check 4 settles that for the price of one command. If it comes back with extra
windows, fold it into Phase 2 as a small extra; if not, close it.

### The success criterion, and the baseline it needs

Stated so it can fail:

> Over a 14-day window after the change, for the Claude account's `five_hour` window, the share of
> hourly observations where `now − max(quota_samples.observed_at)` exceeds the 120-minute staleness
> threshold (`lib/telemetry-contract.ts:46`) is **strictly below the pre-change share**, measured by
> the same query on both sides — while Claude Code is not invoked on the collecting machine.

Plus three pass/fail assertions for Half A, each decidable by a component test over a fixture:

1. A quota sample whose source has `disabled = true` does not render an allowance card.
2. The 24-hour token card renders a no-fresh-data state, not `0`, when no enabled local source has
   checked in within 2 h — the same `recent` gate its two neighbours already use.
3. The `Updated …` line reflects the newest actual collection time, not the cache-fill time.

**The baseline does not exist yet and cannot be reconstructed later.** Run machine-side check 9
hourly for seven days *before* any code changes. Without it the criterion is unfalsifiable, and an
unfalsifiable criterion fails the 0b gate.

### Reuse decision: no reuse

The plan permits inspecting at most one upstream routine, and only if it fills the named gap. **It
does not.** The four surveyed projects are about acquiring *channels*; the named gap is the
Observatory's own freshness correctness plus one browser-extension change. The single upstream
routine that would have been relevant — UsageAtlas's Claude OAuth provider — maps onto option (a),
which is blocked by a product decision rather than by effort.

So: **no upstream code is inspected or imported for Phase 2.** The plan lists "no reuse" as an
acceptable outcome, and this is that outcome, recorded with its reason. If option (a) is ever
unblocked by the owner, this decision should be revisited — not before.

### Revised estimates

| Phase | Was | Now | What changed |
| --- | --- | --- | --- |
| 1 | 6–8 | **6–9** | Four-file change confirmed; `lib/catalog.ts` copy and a subject predicate add a little. No bundle regeneration — Phase 1 touches no collector or extension file |
| 2 | 20–28 (cap 30) | **16–24** | Rescoped to Half A + the comparison mode + the Half B spike |
| 2b | — | **14–20**, conditional | Half B, gated on the spike. Split out rather than raising Phase 2's budget, per the overrun rule |
| 3 | 10–14 | **12–16** | History and compare views cannot reuse the dashboard read — it is bounded to 35 days of buckets and 9 of quota, so they need their own queries |
| 4 | 6–8 | **6–8** | Unchanged. A method already ships; Phase 4 reviews and bounds it |
| 5 | 8–10 | **8–10** | Unchanged. The disabled-intake response is confirmed as genuinely new work |

Totals: **42–57 h** committed, plus **14–20 h** if the Half B spike succeeds. At the confirmed
7 h/week both fit the original window with slack.

**Confidence.** High on Phase 1 and Half A — every file was read and the precedent is in-repo.
Medium on Phase 2b, entirely because of the service-worker premise. Low on anything Cursor-shaped,
which is why it is not in the table.

### What is still blocked

1. **The Half B spike** — does an MV3 service-worker fetch to `claude.ai` carry the profile's
   session? Two hours, and Phase 2b should not be committed before it runs.
2. **The baseline** — seven days of check 9, starting before any code change.
3. **Machine-side checks 1–11** generally; the acceptance gate's "actual coverage" is not answerable
   from source.
4. **Cursor's local-log question** — one command, and it decides whether Cursor is ever a collector
   candidate or only ever a dashboard-API one.
