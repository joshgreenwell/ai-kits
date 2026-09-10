# NO_PROGRESS_CYCLE — Same call, same result, repeated without progress

Category: `reliability` · Tier: `proven` · Confidence: `medium`

Requirements: `args_fingerprint(full)`, `result_fingerprint(full)`, `ordering`

## Problem

The agent re-issues the same tool call and gets the same result back, making no progress while spending calls and tokens.

## Detection

At least `min_calls` (N) sequential, non-overlapping calls to the same tool with an equal `full` args fingerprint AND an equal `full` result fingerprint and byte-identical `scope`. A cycle requires strictly ordered, non-overlapping intervals (each call starts at or after the previous one ended); when only `seq` is available the sequence order is used. Other calls may occur between the members of a cycle.

## Prerequisites

`args_fingerprint(full)`, `result_fingerprint(full)` and `ordering` (`start_ms` with `end_ms`/`duration_ms`, or `seq`). When no event provides one of these the rule abstains with a coverage note naming it; events lacking them in a run that otherwise qualifies are skipped and listed in a `rule_partial` note.

## Evidence

The locator of every call in the cycle, the shared args and result hashes (excerpts), the tool name, and the statement that `scope` was identical. Scope values themselves are never quoted.

## Exclusions

Calls tagged `polling` or `reread` by the loader (app-declared polling and explicit rereads); fan-out (overlapping intervals); differing `scope`; fingerprints that are not `full` (redaction or truncation collisions); placeholder or under-16-byte values (never fingerprinted, so never equal).

## Thresholds

`min_calls` — the story's N: the smallest number of identical sequential calls that counts as a cycle. Provisional; never tuned per run.

Defaults:

- `min_calls` = 3

## Limitations

Cannot tell whether the repetition was intentional and does not judge whether the result was correct. A cycle interleaved with other work is still reported.

## Remediation

Add a stop condition or memoization at the tool boundary; surface the prior result to the model so it can see nothing changed.

## Tier / Confidence

`proven` / `medium`: the repetition is arithmetic on fingerprints and ordering; the confidence is medium because intent is unknown.

## Fixtures

`tests/fixtures/rules/npc_positive.json` (three ordered identical calls), `npc_fanout.json` (overlapping intervals, no finding), `npc_progress.json` (result changes, no finding), `npc_scope_differs.json` (scope differs, no finding), `npc_polling_tag.json` (tagged polling, no finding), `npc_redacted_results.json` (redacted results, abstention).
