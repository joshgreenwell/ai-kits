# IDENTICAL_RETRY_AFTER_FAILURE — Failed call retried with identical arguments

Category: `reliability` · Tier: `proven` · Confidence: `medium`

Requirements: `args_fingerprint(full)`, `status`, `ordering`

## Problem

After a tool fails, the agent retries the exact same call without changing anything, so the same failure comes back.

## Detection

Weak form: at least `min_failures` (N) distinct executions of the same tool with `status=error`, an equal `full` args fingerprint and byte-identical `scope`. Strong form: at least `min_failures_strong` such failures where a `model_call` begins after each failure ends and before the next attempt starts (by interval, or by `seq` when intervals are absent). Both forms may be reported for the same group; they are different claims.

## Prerequisites

`args_fingerprint(full)`, `status` (at least one tool call with a known status) and `ordering`. The strong form additionally needs `model_call` events with timing or `seq`; without them only the weak form can fire.

## Evidence

The locator of every failed attempt with its `error_type` / `error_code`, and for the strong form the locator of each intervening model call.

## Exclusions

SDK or network retries that share one `tool_call_id` (collapsed by dedup and additionally ignored here) or carry the loader tag `retry`; approval waits (`kind=approval`) and `status=blocked` are never failures; calls tagged `backoff`; a differing `scope` (for example another host); the same error produced by different arguments.

## Thresholds

`min_failures` — N for the weak form; `min_failures_strong` — N for the strong form. Provisional; never tuned per run.

Defaults:

- `min_failures` = 3
- `min_failures_strong` = 2

## Limitations

Cannot know whether the retry was reasonable (a transient error may deserve one); the strong form infers model involvement from ordering only.

## Remediation

Surface the error content to the model; cap identical retries at the tool boundary.

## Tier / Confidence

Weak form `proven` / `medium` (identical failures are arithmetic on fingerprints and status). Strong form `projected` / `medium` (the model's involvement is inferred from ordering).

## Fixtures

`tests/fixtures/rules/irf_weak_positive.json` (three identical failures), `irf_strong_positive.json` (two failures with model calls between), `irf_different_commands.json` (same error, different args, no finding), `irf_sdk_retries_same_tool_call_id.json` (one `tool_call_id`, no finding after dedup), `irf_blocked_approval.json` (blocked approval then re-issue, no finding), `irf_status_absent.json` (status unknown, abstention).
