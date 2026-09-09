# I linted 200 of my own Claude Code sessions

> **Status: draft.** Every `[N]` below is a placeholder for a number that
> has not been measured yet. The framework-aggregate example and the healthy
> run are real output from the synthetic fixtures in `tests/e2e/`; the
> session-level numbers will come from the author's own transcripts, run
> locally, and will be stated with their coverage. Nothing in this draft
> claims more than the tool proves. See `README.md` in this directory for
> the review checklist.

Agent runs fail in patterns that are visible in their traces long before
they are visible in their outputs. The same tool call three times with the
same arguments and the same result. A retry that reproduces the failure
instead of fixing it. A context that doubles after one tool result and stays
doubled for every call after it. None of that needs a model to spot; it
needs the identifiers and numbers the trace already has, and a little
arithmetic.

So I wrote a linter for it and pointed it at my own work.

## What I ran

`agentlint` is a Python command with no runtime dependencies. It reads what
the agent already recorded — an OpenTelemetry export, a Langfuse export, a
Claude Code session transcript, or a neutral record bundle your app emits —
and prints one ordered run with explicit coverage, then deterministic
findings, then stats.

```sh
uvx agentlint analyze ~/.claude/projects/<project>/ --experimental-claude-session
```

The Claude Code loader is experimental and off by default: the format is
undocumented upstream, and transcripts contain private code and prompts. The
tool never sends anything anywhere and never prints content — identifiers,
hashes, counts and sizes only — but you are still pointing a program at your
own conversations, so the flag is deliberate.

I ran it over `[N]` sessions from `[N]` projects written between `[DATE]` and
`[DATE]` by Claude Code `[VERSIONS]`.

## The first thing it told me was what it could not see

This is the part I want to lead with, because it is the part most tools skip.

Every run starts with a coverage block, and the exit code is about coverage,
not about how bad the run looked. Exit `0` means every input loaded, every
run was complete and every rule ran fully. Exit `2` means something was
missing and the report says what. Findings never change the exit code.

Here is a run — synthetic, from the test suite — where the framework
recorded token usage only on its own wrapper spans, not on the individual
model calls:

```
== run run-e2e-aggregate-usage (record-bundle) ==
Coverage: complete
  events: 5 (dropped as duplicates: 0)
  present: args_fingerprint, end_ms, finish_reason, model, provider, result_bytes, result_fingerprint, seq, start_ms, token_basis, tool_call_id
  partial: parent_id, tokens_in, tokens_out
  absent: cache_read_tokens, error_type
  incomplete for rules: [CONTEXT_GROWTH]
    - CONTEXT_GROWTH did not run: missing tokens_in(model_call)
Findings: none reported (coverage INCOMPLETE — this is not a clean result)
```

The aggregates in that run go from 1,000 to 30,000 input tokens. A tool that
compared them would have printed a dramatic finding. This one abstains,
names the field it needs (`tokens_in` on `model_call` events, not on
aggregates), and exits `2`. I think of `incomplete for rules: [...]` as the
most important line the tool prints: it is the difference between "no
problems found" and "no problems found *in the data I had*", and it tells you
exactly what to instrument next.

Across my `[N]` sessions, `[N]` exited `0`, `[N]` exited `2`, and `[N]`
exited `3` (unparseable — `[REASON]`). The most common reason for a `2` was
`[REASON]`.

## An honest negative

Most of the sessions I lint are fine, and the tool should say so without
dressing it up. This is the healthy fixture from the negative-control suite,
verbatim:

```
== run run-e2e-healthy (record-bundle) ==
conversation: conv-run-e2e-healthy
sources: exampleapp/e2e/run-e2e-healthy
Coverage: complete
  events: 6 (dropped as duplicates: 0)
  present: args_fingerprint, end_ms, finish_reason, result_bytes, result_fingerprint, seq, start_ms, tool_call_id
  partial: model, parent_id, provider, token_basis, tokens_in, tokens_out
  absent: cache_read_tokens, error_type
Findings: none (coverage complete)
Stats:
  events by kind: aggregate=1, model_call=3, tool_call=2
  events by status: ok=6
  run span: 4300 ms
  latency (ms, min/p50/p90/max):
    aggregate: 4300/4300/4300/4300 (1 of 1 measured; slowest agg-01)
    model_call: 900/900/1000/1000 (3 of 3 measured; slowest mc-02)
    tool_call: 400/400/500/500 (2 of 2 measured; slowest tc-02)
  tokens by basis (never summed across bases):
    input_excludes_cache_read: calls=3 in=6100 out=240 cache_read=- cache_write=-

Summary: 1 run(s) analysed, 0 finding(s), coverage complete; exit code 0 (analysis complete)
```

Zero findings, complete coverage, exit `0`. Note what it does *not* say: it
does not call the run "clean", "healthy" or "good". It says every rule ran on
every event it applies to and none of them fired. (The `partial` line is the
aggregate span, which has no model or usage of its own; a field is judged
against the kinds it applies to, and the report says so rather than hiding
it.)

Of my `[N]` sessions with complete coverage, `[N]` had no findings.

## What it did find

The tool ships five rules. Every finding carries a tier, and I am going to
use the tiers by name because they are the whole point:

* **proven** — the pattern is present in the data as a matter of arithmetic;
* **projected** — the data is consistent with the pattern; a candidate, not a cause;
* **unresolved** — the data needed to decide is missing.

`[EXAMPLE: one real NO_PROGRESS_CYCLE or IDENTICAL_RETRY_AFTER_FAILURE
finding from a session, with identifiers, the thresholds line and the
evidence citations, pasted verbatim. Tier: proven.]`

`[EXAMPLE: one real CONTEXT_GROWTH finding, pasted verbatim. Tier:
projected. Point out that the tool result it lists is a *candidate* — it
entered the context between the two model calls — and that the tool does not
claim it caused the growth.]`

Counts across the `[N]` sessions: `[N]` `NO_PROGRESS_CYCLE` (proven), `[N]`
`IDENTICAL_RETRY_AFTER_FAILURE` (`[N]` weak / proven, `[N]` strong /
projected), `[N]` `CONTEXT_GROWTH` (projected), `[N]` `OVERSIZED_TOOL_RESULT`
(proven), `[N]` `REPEATED_TOOL_RESULT` (proven). Thresholds were the
defaults (`agentlint explain <RULE_ID>` prints them); I did not tune anything
against a particular run.

## What it will not tell you

It will not tell you why the model reasoned incorrectly. It will not tell
you whether a tool choice was relevant, whether a plan was good, or whether
a retrieved document was the right one. It has no health score and no
pricing table. It makes no network calls, keeps no state, and calls no
model. Those are design constraints, not roadmap items: the moment a linter
starts judging semantics it needs a model in the loop, and then its output
is no longer deterministic, no longer evidence-backed, and no longer
something you can put in CI.

What it does is narrow: structural waste, cited by identifier, with the
coverage stated. In `[N]` sessions that was enough to `[WHAT CHANGED —
concrete, measured, or delete this sentence]`.

## Try it

```sh
uvx agentlint analyze path/to/your/trace.json
uvx agentlint rules
uvx agentlint explain CONTEXT_GROWTH
```

Source, docs and the privacy statement: <https://github.com/joshgreenwell/ai-kits/tree/main/agentlint>.

If you want the longer version — how to read a trace, which patterns are
worth a rule and which are not, how to instrument so the tool has something
to lint — that is the Agent Debugging Field Guide. Waitlist:
`[WAITLIST_URL]`.
