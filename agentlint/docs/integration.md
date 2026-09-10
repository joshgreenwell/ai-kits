# Integrating `agentlint` into an application

A task-oriented guide for an engineer adding `agentlint` to an existing
application: choosing an input, installing from a local checkout, emitting a
record bundle from your own debug report, reading the exit codes, adding an
app-specific rule, configuring thresholds, and running it in CI.

Every command on this page was run against this repository and every block of
output below one is that run's real output, abridged with `…` where it was
long. Paths use `$AI_KITS` for your local checkout, and absolute paths in the
output are elided the same way:

```sh
export AI_KITS=/path/to/ai-kits    # the directory holding agentlint/
```

Reference material this guide points at rather than repeats:
[`docs/cli.md`](cli.md) (commands, formats, output order),
[`docs/record-bundle.md`](record-bundle.md) (the full field reference),
[`docs/rules/`](rules/README.md) (one page per generic rule) and
[`PRIVACY.md`](../PRIVACY.md).

## 1. Choose your input

`agentlint` reads what your agent already recorded. Pick the row that matches
what you have today:

| What the app already has | Give agentlint | Loader | Code change |
| -- | -- | -- | -- |
| An OTLP export (`resourceSpans` envelope, one per file) | the exported `.json` files | `otlp-json` | **none** |
| OTLP JSON Lines from the Collector `file` exporter | the exported `.jsonl` files | `otlp-jsonl` | **none** |
| A Langfuse Observations export (JSON, JSONL or CSV) | the exported file(s) | `langfuse-observations` | **none** |
| Neither — but a debug report, an audit log or database rows describing the run | a **record bundle** you emit (§3) | `record-bundle` | a mapper you own |
| Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`) | the `.jsonl` files, with `--experimental-claude-session` | `claude-session-jsonl` | none |

For the first three rows there is **nothing to change in your application**:
point the command at the files you already export and read the report. Inputs
are detected by shape; `--loader <label>` forces one when detection is not
what you want.

For an application integrating deliberately — one that wants to control which
identifiers are cited, which fields are covered, and what never leaves the
process — the **record bundle is the recommended path**. It is the published
neutral schema: your mapper decides exactly what is measured, and coverage
gaps come back named field by field instead of guessed at.

The Claude Code session loader is experimental and off by default: the format
is undocumented upstream and the transcripts routinely contain private code
and prompts.

## 2. Install from a local checkout (before the PyPI release)

`agentlint` is **not on PyPI yet**, so install it from the checkout. It needs
**Python 3.11 or newer** and has **zero runtime dependencies** — standard
library only, no HTTP client, no SDK.

### A throwaway run, nothing installed

```sh
uvx --from "$AI_KITS/agentlint" agentlint --version
```

```
   Building agentlint @ file:///…/agentlint
      Built agentlint @ file:///…/agentlint
Installed 1 package in 1ms
agentlint 0.0.1
```

`uvx` builds the checkout into a temporary environment and runs the command;
nothing is added to your project. Use it to try the tool on a trace before
deciding anything:

```sh
uvx --from "$AI_KITS/agentlint" agentlint analyze bundle.json
```

```
…
Summary: 1 run(s) analysed, 1 finding(s), coverage complete; exit code 0 (analysis complete)
```

### An editable install into your app's virtual environment

Use this when the app's own tests or scripts call `agentlint`, and you want
edits in the checkout to take effect immediately:

```sh
uv pip install -e "$AI_KITS/agentlint"
```

```
Using Python 3.11.15 environment at: appvenv
Resolved 1 package in 3ms
   Building agentlint @ file:///…/agentlint
      Built agentlint @ file:///…/agentlint
Prepared 1 package in 274ms
Installed 1 package in 0.81ms
 + agentlint==0.0.1 (from file:///…/agentlint)
```

The plain-`pip` equivalent, for a project that does not use `uv`:

```sh
python -m pip install -e "$AI_KITS/agentlint"
```

```
…
Installing collected packages: agentlint
Successfully installed agentlint-0.0.1
```

Either way you get the `agentlint` command:

```sh
agentlint --version
```

```
agentlint 0.0.1
```

### Importing the library from your app's code

The mapper in §3 needs the fingerprint helpers, so the same install makes
them importable:

```sh
python -c "
from agentlint.fingerprint import fingerprint, utf8_length, MIN_HASH_INPUT_BYTES
print(MIN_HASH_INPUT_BYTES)
print(fingerprint({'query': 'open orders for account 8871', 'limit': 20}))
print(fingerprint('ok'))
print(utf8_length('{\"orders\": []}'))
"
```

```
16
Fingerprint(hash='b4c3177f0ac51e1bc48ade7fcef784b60597a0c834520c52887b33ea772b3e06', representation='full')
None
14
```

Note the `None`: `"ok"` is shorter than the 16-byte floor, so it is never
hashed. That is the behaviour §3 relies on.

## 3. Emit a record bundle from your app

A record bundle is one JSON document describing one run:
identifiers, kinds, statuses, timestamps, counts, sizes and fingerprints.
The mapper lives in your repository; this repository publishes the target
shape ([`docs/record-bundle.md`](record-bundle.md), schema
[`record-bundle.schema.json`](record-bundle.schema.json)).

Six rules decide whether the bundle is worth linting:

1. **Hashes, not content.** Never copy a prompt, a command line, a file path
   from a tool call or a tool result into the bundle. Arguments and results
   become `args_fingerprint` / `result_fingerprint` (SHA-256 over canonical
   JSON) and `result_bytes`.
2. **Absent means omit the key.** Never write `null`, never write `0`, `""`
   or `{}` for something you do not know. `null` is a schema violation and
   drops the record; a `0` you invented is a lie the rules will believe.
3. **Counts and timestamps are integers.** `12.5`, `"12"` and `true` are
   violations — and so is `12.0`.
4. **Identifiers come from the source.** `id` is the row / span / message ID
   your report already has. `f"{run_id}-{i}"` is a position, not an identity;
   evidence that cites it cannot be looked up in your system.
5. **The 16-byte floor is deliberate.** `fingerprint()` returns `None` for a
   placeholder (`{}`, `""`) or a value shorter than 16 bytes, because such a
   hash is reversible by guessing. Omit the key when it returns `None`; a
   fingerprint that never existed is better than one no rule may trust.
6. **App data is namespaced.** Anything specific to your application goes
   under `scope["<yourapp>"]`. Generic rules never read it; your own rules
   read nothing else (§5).

### The mapper

A complete, runnable mapper for an imaginary support application. Save it in
your repository as `emit_bundle.py` (wherever your tooling lives) and adapt
`ROWS` to your debug report's actual rows:

```python
# agentlint-docs: record-bundle-example
"""agentlint-integration-example: map an app debug report to a record bundle."""

import json

from agentlint.fingerprint import fingerprint, utf8_length

# Identity comes from the application; nothing here is synthesised.
RUN_ID, CONVERSATION_ID = "acme-run-3f9c", "acme-conv-0b21"
SCOPE = {"acme": {"workspace_id": "ws-42", "surface": "support-inbox"}}
ARGS = {"query": "open orders for account 8871", "limit": 20}
RESULT = '{"orders": [], "note": "no open orders for account 8871"}'

# Rows exactly as the imaginary app's debug report stores them.
ROWS = [
    {"id": "dbg-9001", "seq": 1, "op": "model", "t0": 1712000000000, "t1": 1712000001400},
    {"id": "dbg-9002", "seq": 2, "op": "tool", "t0": 1712000001500, "t1": 1712000002100},
    {"id": "dbg-9003", "seq": 3, "op": "model", "t0": 1712000002200, "t1": 1712000003300},
    {"id": "dbg-9004", "seq": 4, "op": "tool", "t0": 1712000003400, "t1": 1712000004000},
    {"id": "dbg-9005", "seq": 5, "op": "model", "t0": 1712000004100, "t1": 1712000005200},
    {"id": "dbg-9006", "seq": 6, "op": "tool", "t0": 1712000005300, "t1": 1712000005900},
]
TOKENS_IN = {"dbg-9001": 4200, "dbg-9003": 5100, "dbg-9005": 6000}
CALL_IDS = {"dbg-9002": "call-77a", "dbg-9004": "call-77b", "dbg-9006": "call-77c"}


def to_record(row):
    """One debug-report row -> one bundle record. Absent means omit the key."""
    record = {
        "id": row["id"],  # the app's own row ID, never derived
        "source_locator": f"acme/debug-report/3f9c/rows/{row['id']}",
        "seq": row["seq"],
        "status": "ok",
        "start_ms": row["t0"],
        "end_ms": row["t1"],
        "scope": SCOPE,  # namespaced; generic rules never read it
    }
    if row["op"] == "model":
        record.update(
            kind="model_call", name="chat", model="acme-chat-1", provider="acme",
            token_basis="input_excludes_cache_read", tokens_in=TOKENS_IN[row["id"]],
            tokens_out=90, finish_reason="tool_use",
        )
        return record
    record.update(kind="tool_call", name="search_orders", tool_call_id=CALL_IDS[row["id"]])
    args_fp, result_fp = fingerprint(ARGS), fingerprint(RESULT)
    if args_fp is not None:  # None below the 16-byte floor: omit, never null
        record["args_fingerprint"] = args_fp.to_dict()
    if result_fp is not None:
        record["result_fingerprint"] = result_fp.to_dict()
    record["result_bytes"] = utf8_length(RESULT)  # full model-visible size
    return record


bundle = {
    "schema_version": "1",
    "run_id": RUN_ID,
    "conversation_id": CONVERSATION_ID,
    "source_refs": ["acme/debug-report/3f9c"],
    "started_at": ROWS[0]["t0"],
    "ended_at": ROWS[-1]["t1"],
    "final_status": "cancelled",
    "records": [to_record(row) for row in ROWS],
}
with open("bundle.json", "w", encoding="utf-8") as handle:
    json.dump(bundle, handle, indent=2, sort_keys=True)
    handle.write("\n")
print(f"wrote bundle.json with {len(bundle['records'])} records")
```

`token_basis` on every model call is what lets token counts be compared at
all; `tool_call_id` is the application-level call ID (an `approval` record
about the same call carries the same one); `source_locator` is what makes a
citation clickable in your system. `final_status` lives at the top level
because the neutral model has no run-level status.

Every other field — `parent_id`, `included_result_ids`, `preview_bytes`,
`error_type`, `cache_read_tokens`, `raw` — is in the field reference in
[`docs/record-bundle.md`](record-bundle.md).

### Run it, then lint its output

```sh
python emit_bundle.py
```

```
wrote bundle.json with 6 records
```

```sh
agentlint analyze bundle.json
```

```
agentlint 0.0.1

Inputs:
  - bundle.json [record-bundle] runs: acme-run-3f9c

== run acme-run-3f9c (record-bundle) ==
conversation: acme-conv-0b21
sources: acme/debug-report/3f9c
Coverage: complete
  events: 6 (dropped as duplicates: 0)
  present: args_fingerprint, end_ms, finish_reason, model, provider, result_bytes, result_fingerprint, seq, start_ms, token_basis, tokens_in, tokens_out, tool_call_id
  absent: cache_read_tokens, error_type, parent_id
Findings (1):
  1. NO_PROGRESS_CYCLE [proven/medium] Same call, same result, repeated without progress
     pattern: 3 sequential non-overlapping calls to tool search_orders with identical arguments (b4c3177f0ac5…) and identical results (c39d93db927a…) in the same scope
     impact: 2 call(s) after the first produced nothing new
     thresholds: min_calls=3
     evidence (3 citation(s)):
       - dbg-9002 @ acme/debug-report/3f9c/rows/dbg-9002 result_fingerprint=c39d93db927af7a89b832b92024349a7ef573b6f31db5677d9db9fc99f322c1f (call 1/3: tool search_orders, args_fingerprint b4c3177f0ac5…, scope identical)
       - dbg-9004 @ acme/debug-report/3f9c/rows/dbg-9004 result_fingerprint=c39d93db927af7a89b832b92024349a7ef573b6f31db5677d9db9fc99f322c1f (call 2/3: tool search_orders, args_fingerprint b4c3177f0ac5…, scope identical)
       - dbg-9006 @ acme/debug-report/3f9c/rows/dbg-9006 result_fingerprint=c39d93db927af7a89b832b92024349a7ef573b6f31db5677d9db9fc99f322c1f (call 3/3: tool search_orders, args_fingerprint b4c3177f0ac5…, scope identical)
     limitation: cannot tell whether the repetition was intentional
     limitation: does not judge whether the result was correct
     fingerprint: 51b799dc5c44…
Stats:
  events by kind: model_call=3, tool_call=3
  events by status: ok=6
  run span: 5900 ms
  latency (ms, min/p50/p90/max):
    model_call: 1100/1100/1400/1400 (3 of 3 measured; slowest dbg-9001)
    tool_call: 600/600/600/600 (3 of 3 measured; slowest dbg-9006)
  tokens by basis (never summed across bases):
    input_excludes_cache_read: calls=3 in=15300 out=270 cache_read=- cache_write=-

Summary: 1 run(s) analysed, 1 finding(s), coverage complete; exit code 0 (analysis complete)
```

Read the top of that report before the bottom. `Coverage: complete` with no
`incomplete for rules:` line means all five generic rules ran fully — so the
one finding is a claim about the run, not an artefact of missing data. The
three `absent` fields (`cache_read_tokens`, `error_type`, `parent_id`) are
reported, not errors: no rule this run needed them.

`tests/test_docs_integration.py` in this repository extracts the block above
from this file, runs it, and asserts exactly that output's coverage and exit
code, so the guide cannot drift from the tool.

## 4. Read the output and the exit codes

| Code | Meaning | What you do |
| -- | -- | -- |
| `0` | every input loaded, every run complete, every rule ran fully | read the findings; they are claims about the run |
| `2` | incomplete coverage — a run is `incomplete`, a file could not be loaded, or a rule abstained | read `incomplete for rules: [...]`; it names the field to start recording |
| `3` | unparseable input — at least one input yielded no run | fix the input or the loader before believing anything else |
| `1` | usage or configuration error | fix the flag, rule ID, loader label or `agentlint.toml` |

**Findings never change the exit code**, and neither do rule errors. The run
in §3 exits `0` *with* a finding. A run with no findings and exit `2` is not
clean — the report says so in words (`none reported (coverage INCOMPLETE —
this is not a clean result)`).

Exit `2` is the common, useful case: it is the tool telling you which data it
would need. Here is the same bundle with `token_basis` dropped from the model
calls, abridged:

```sh
agentlint analyze no-basis.json
```

```
…
Coverage: complete
  events: 6 (dropped as duplicates: 0)
  present: args_fingerprint, end_ms, finish_reason, model, provider, result_bytes, result_fingerprint, seq, start_ms, tokens_in, tokens_out, tool_call_id
  absent: cache_read_tokens, error_type, parent_id, token_basis
  note [token_basis_absent]: 3 model call(s) have no token_basis; their token counts are comparable to nothing
  incomplete for rules: [CONTEXT_GROWTH]
    - CONTEXT_GROWTH did not run: missing token_basis(model_call)
Findings (1):
  1. NO_PROGRESS_CYCLE [proven/medium] Same call, same result, repeated without progress
…
  tokens by basis (never summed across bases):
    none (no model call with a known token basis)
    model calls without a token basis: 3

Summary: 1 run(s) analysed, 1 finding(s), coverage INCOMPLETE; exit code 2 (analysis ran with incomplete coverage)
```

A reviewer reads that as a work item for the *mapper*, not for the agent:
start recording `token_basis` and `CONTEXT_GROWTH` will run next time. Exit
`3`, by contrast, means nothing was analysed at all and no finding — present
or absent — carries any information (§9).

## 5. Add an app-specific rule

A rule is metadata plus a pure function; there is no framework, no base class
and no registry to edit. A module exposes either a `RULES` list or a
`META` / `run` pair.

The contract:

* **`META` is a `RuleMeta`** with an `UPPER_SNAKE_CASE` `id`, a `title`, a
  `category`, a `tier`, a `confidence`, its default `thresholds`, and a
  `RuleDoc` filling **all ten Appendix A sections** (Problem, Detection,
  Prerequisites, Evidence, Exclusions, Thresholds, Limitations, Remediation,
  Tier / Confidence, Fixtures). An empty section is a load-time error:
  `agentlint explain <RULE_ID>` and `docs/rules/<RULE_ID>.md` are rendered
  from this metadata and never hand-written.
* **`requirements[]`** use the documented grammar — `ordering`, an event kind
  (`tool_call`, `model_call`, …), or an event field, optionally qualified:
  `field(kind)` narrows to one kind and `*_fingerprint(full)` demands a
  `full`, non-placeholder fingerprint. An unmet requirement makes the rule
  *abstain* with a note naming the missing field, instead of guessing.
* **`run(run, config) -> list[Finding]` is pure**: no I/O, no clock, no
  network, no global state; the same run and config must always produce the
  same findings. `config.threshold("<name>")` reads a threshold; copy
  `dict(config.thresholds)` onto every finding so the report shows the values
  used.
* **App fields live under a namespaced `Event.scope`**, and your rule reads
  *only* its own namespace. Generic rules never read `scope` at all (the one
  neutral exception is the loader tag list under `scope["agentlint"]["tags"]`).
* **Evidence must cite locators that are present in the run**: build each
  `Evidence` from an event's own `id` and `source_locator`. Never synthesise
  an identifier, and never quote content — counts, IDs and hashes only.

The worked example in this repository is
[`examples/rules/grouped_request_scope_loss.py`](../examples/rules/grouped_request_scope_loss.py):
it detects a failed multi-target request re-issued as a single-target one,
reads only `scope["exampleapp"]`, compares arguments only through
`fingerprints_equal`, and downgrades itself to `unresolved` when the app's
selection data is absent. Read it before writing your own.

A smaller one, matching the bundle from §3 — every `search_orders` call on an
approval-gated surface must have an `approval` record sharing its
`tool_call_id`:

```python
"""App rule: customer-data tool calls on the support surface need an approval record."""

from agentlint.model import Evidence, Finding
from agentlint.rules.base import RuleDoc, RuleMeta

NAMESPACE = "acme"
RULE_ID = "ACME_TOOL_CALL_WITHOUT_APPROVAL"
SURFACES_REQUIRING_APPROVAL = frozenset({"support-inbox"})

META = RuleMeta(
    id=RULE_ID,
    title="Tool call on an approval-gated surface has no approval record",
    category="policy",
    requirements=["tool_call", "tool_call_id", "ordering"],
    tier="proven",
    confidence="medium",
    thresholds={"min_calls": 1},
    doc=RuleDoc(
        problem="Customer data was read on a support surface with no approval recorded.",
        detection=(
            "Tool calls whose `acme.surface` is approval-gated and whose `tool_call_id` "
            "is not shared by any `approval` event of the run; reported once per run "
            "when at least `min_calls` such calls exist."
        ),
        prerequisites="`tool_call`, `tool_call_id`, `ordering`, and `acme.surface` in scope.",
        evidence="Each unapproved call's event ID, source locator and tool_call_id.",
        exclusions="Calls on surfaces outside the gated set; calls with an approval.",
        thresholds="`min_calls` — how many unapproved calls a run must have to report.",
        limitations="Approvals granted outside the debug report are invisible here.",
        remediation="Emit the decision as an `approval` record sharing the tool_call_id.",
        tier_confidence="`proven` / `medium`: the absent record is arithmetic; intent is not.",
        fixtures="`tests/bundles/unapproved_support_read.json` in the application repo.",
    ),
)


def run(run, config):
    """Pure: one finding per run listing every gated tool call without an approval."""
    events = run.sorted_events()
    approved = {e.tool_call_id for e in events if e.kind == "approval" and e.tool_call_id}
    unapproved = [
        e
        for e in events
        if e.kind == "tool_call"
        and e.tool_call_id is not None
        and e.tool_call_id not in approved
        and (e.scope.get(NAMESPACE) or {}).get("surface") in SURFACES_REQUIRING_APPROVAL
    ]
    if len(unapproved) < int(config.threshold("min_calls")):
        return []
    return [
        Finding(
            rule_id=RULE_ID,
            title=META.title,
            category=META.category,
            tier=META.tier,
            confidence=META.confidence,
            run_id=run.id,
            observed_pattern=(
                f"{len(unapproved)} approval-gated tool call(s) with no approval record"
            ),
            impact="customer data was read without a recorded decision",
            evidence=[
                Evidence(
                    event_id=e.id,
                    source_locator=e.source_locator,
                    field="tool_call_id",
                    value=e.tool_call_id,
                    note=f"tool {e.name} on an approval-gated surface",
                )
                for e in unapproved
            ],
            limitations=["approvals granted outside the debug report are invisible"],
            thresholds=dict(config.thresholds),
        )
    ]


RULES = [(META, run)]
```

### Running it

`--rules-module <path>` is repeatable and works with `analyze`, `rules` and
`explain`. Check that it loads first:

```sh
agentlint rules --rules-module acme_rules.py
```

```
ID                               CATEGORY     TIER       CONFIDENCE  REQUIREMENTS                                                                             SOURCE
NO_PROGRESS_CYCLE                reliability  proven     medium      args_fingerprint(full), result_fingerprint(full), ordering                               builtin
IDENTICAL_RETRY_AFTER_FAILURE    reliability  proven     medium      args_fingerprint(full), status, ordering                                                 builtin
CONTEXT_GROWTH                   context      projected  medium      model_call, tokens_in(model_call), token_basis(model_call), model(model_call), ordering  builtin
OVERSIZED_TOOL_RESULT            cost         proven     high        result_bytes                                                                             builtin
REPEATED_TOOL_RESULT             cost         proven     medium      result_fingerprint(full), result_bytes                                                   builtin
ACME_TOOL_CALL_WITHOUT_APPROVAL  policy       proven     medium      tool_call, tool_call_id, ordering                                                        module:acme_rules.py
```

Then run it over the bundle from §3, abridged:

```sh
agentlint analyze bundle.json --rules-module acme_rules.py
```

```
…
Findings (2):
  1. ACME_TOOL_CALL_WITHOUT_APPROVAL [proven/medium] Tool call on an approval-gated surface has no approval record
     pattern: 3 approval-gated tool call(s) with no approval record
     impact: customer data was read without a recorded decision
     thresholds: min_calls=1
     evidence (3 citation(s)):
       - dbg-9002 @ acme/debug-report/3f9c/rows/dbg-9002 tool_call_id=call-77a (tool search_orders on an approval-gated surface)
       - dbg-9004 @ acme/debug-report/3f9c/rows/dbg-9004 tool_call_id=call-77b (tool search_orders on an approval-gated surface)
       - dbg-9006 @ acme/debug-report/3f9c/rows/dbg-9006 tool_call_id=call-77c (tool search_orders on an approval-gated surface)
     limitation: approvals granted outside the debug report are invisible
     fingerprint: d4daac3cfede…
  2. NO_PROGRESS_CYCLE [proven/medium] Same call, same result, repeated without progress
…
Summary: 1 run(s) analysed, 2 finding(s), coverage complete; exit code 0 (analysis complete)
```

The rendered documentation comes from the metadata, with no extra file to
keep in sync:

```sh
agentlint explain ACME_TOOL_CALL_WITHOUT_APPROVAL --rules-module acme_rules.py
```

```
# ACME_TOOL_CALL_WITHOUT_APPROVAL — Tool call on an approval-gated surface has no approval record

Category: `policy` · Tier: `proven` · Confidence: `medium`

Requirements: `tool_call`, `tool_call_id`, `ordering`

## Problem

Customer data was read on a support surface with no approval recorded.
…
```

### Registering it permanently

For an installed application, register the module under the `agentlint.rules`
entry-point group instead of passing `--rules-module` every time. Rules found
there load automatically, with `source` reported as `entry-point:<name>`:

```toml
# your application's pyproject.toml
[project.entry-points."agentlint.rules"]
acme = "acme.agentlint_rules"
```

Two rules may not share an ID: a collision is a load error naming both
sources.

## 6. Configure thresholds

Thresholds are visible, provisional and overridable per rule — including for
your own rules. Put an `agentlint.toml` in the app repository:

```toml
# Thresholds: one table per rule. Unknown keys for a loaded rule are a usage error.
[rules.OVERSIZED_TOOL_RESULT]
min_result_bytes = 32768        # our tool results are paginated at 32 KiB

[rules.REPEATED_TOOL_RESULT]
min_results = 2                 # two identical results already mean a wasted round trip

[rules.CONTEXT_GROWTH]
min_delta_tokens = 6000
min_ratio = 1.4

# App rules take overrides too, under their own ID.
[rules.ACME_TOOL_CALL_WITHOUT_APPROVAL]
min_calls = 1

[loaders]
experimental_claude_session = false
otlp_token_basis = "input_excludes_cache_read"   # what our OTLP instrumentation counts
otlp_run_id_attribute = "acme.run_id"
```

Pass it with `--config agentlint.toml`; command-line flags override the file.
Every finding records the threshold values it used, so a report always says
which numbers produced it.

**Unknown keys for a loaded rule are a usage error, never ignored** — a typo
fails before any analysis runs:

```sh
agentlint analyze bundle.json --config bad.toml
```

```
agentlint: bad thresholds in bad.toml: unknown threshold(s) min_bytes for rule OVERSIZED_TOOL_RESULT; known: min_result_bytes
```

(Exit code `1`.) Overrides for rule IDs that are *not* loaded are left alone,
so the file may mention rules from a module you did not pass this time. The
same strictness applies to `[loaders]`: an unrecognised key there is reported
with the list of known keys.

## 7. Run it in CI

One step, using the local checkout. Fail the job on exit `3` (and `1`),
surface exit `2` as a warning, and gate on findings yourself by parsing
`--format json`:

```yaml
- name: agentlint
  run: |
    set +e
    uvx --from ./vendor/ai-kits/agentlint agentlint analyze traces/ \
      --config agentlint.toml --format json --output agentlint.json
    code=$?
    set -e
    case "$code" in
      0) ;;
      2) echo "::warning::agentlint coverage incomplete — see agentlint.json" ;;
      *) echo "::error::agentlint exited $code"; exit 1 ;;
    esac
    python - <<'PY'
    import json, sys
    doc = json.load(open("agentlint.json"))
    proven = [f for r in doc["runs"] for f in r["findings"] if f["tier"] == "proven"]
    for f in proven:
        print(f"{f['rule_id']}: {f['observed_pattern']}")
    sys.exit(1 if proven else 0)
    PY
```

Gating on `tier == "proven"` keeps `projected` findings (candidates, not
causes) out of the pass/fail decision; upload `agentlint.json` as an artifact
and read them by hand. `--format json` is byte-deterministic for identical
input, so the file diffs cleanly between runs.

## 8. Privacy

* **Nothing leaves the process.** No network, no telemetry, no update check,
  no cache, no state; the only file written is the one you name with
  `--output`.
* **The default output carries no content**: identifiers the source already
  had, source locators, hashes, counts, sizes and timestamps only. Values
  shorter than 16 bytes are never hashed.
* **`--include-snippets` is opt-in** and redacts credential patterns *before*
  truncating each snippet to 200 characters — treat a report produced with it
  as containing trace content.
* **The trace files themselves stay sensitive.** An OTLP or Langfuse export
  can hold prompts, file contents, command lines and customer data;
  `agentlint` reading it does not make it safe to attach to a ticket. Full
  statement: [`PRIVACY.md`](../PRIVACY.md).

## 9. Troubleshooting

| Symptom | What it means | Fix |
| -- | -- | -- |
| `no loader recognised this file`, exit `3` | no loader's shape check accepted the file — wrong export, an `expected.json`-style sidecar in the same directory, or a bundle missing `schema_version` / `run_id` / `records` | pass the file the exporter actually produced, or force one with `--loader <label>` to see the loader's own error |
| `incomplete for rules: [CONTEXT_GROWTH]`, `missing token_basis(model_call)` | token counts exist but nothing says what they measure, so they are comparable to nothing | record bundle: emit `token_basis` (`input_excludes_cache_read` or `input_includes_cache_read`) on every `model_call`. OTLP: set `[loaders] otlp_token_basis` in `agentlint.toml` — it applies to the OTLP loaders only, not to bundles |
| `note [preview_only]` and `incomplete for rules: [OVERSIZED_TOOL_RESULT, REPEATED_TOOL_RESULT]` | records carry `preview_bytes` but no `result_bytes`; a preview is a lower bound, never a stand-in | measure the full model-visible result with `utf8_length` and emit `result_bytes`; keep `preview_bytes` as extra if you have it |
| `missing args_fingerprint(full)` although every record has one | the fingerprints are placeholder hashes (`{}`, `""`) or not `full`; no equality claim may be built on them | do not fingerprint placeholders — `fingerprint()` returns `None` below 16 bytes, so omit the key; hash the real arguments where the app still has them |
| `schema violation at report.json#/records/3/tokens_in: expected integer, got null` | that record was dropped and the run marked `incomplete`; the JSON pointer names the exact key | omit unknown keys instead of writing `null`; keep counts as integers. An unknown property (`token_in`) is reported the same way — app data belongs under `scope` or `raw` |
| `the claude-session-jsonl loader is experimental; enable it with --experimental-claude-session`, exit `3` | the session loader is gated off by default | pass `--experimental-claude-session` (or `[loaders] experimental_claude_session = true`) for files you intend to lint — and only those |
| `unknown threshold(s) … for rule …`, exit `1` | `agentlint.toml` names a threshold a loaded rule does not declare | use the names from `agentlint explain <RULE_ID>` |
| Exit `2` with no findings | coverage was incomplete: this is **not** a clean result | read the `incomplete for rules:` block; it names the field to start recording |
