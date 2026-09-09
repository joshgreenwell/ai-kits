# CONTEXT_GROWTH — Sharp input-token growth between consecutive model calls

Category: `context` · Tier: `projected` · Confidence: `medium`

Requirements: `model_call`, `tokens_in(model_call)`, `token_basis(model_call)`, `model(model_call)`, `ordering`

## Problem

Input tokens jump sharply between consecutive model calls, usually because large tool results entered the context.

## Detection

Between two consecutive comparable model calls (same `token_basis`, same `model`, routing / retrieval / compaction calls excluded), `tokens_in` rises by at least `min_delta_tokens` (Δ) AND to at least `min_ratio` (x) times the previous value. Both conditions are required. Tool-call events ordered between the two calls, plus any listed in the later call's `included_result_ids`, are reported as candidates.

## Prerequisites

Per-call `tokens_in` on `model_call` events with `token_basis` and `model`, and `ordering`. Aggregate usage without a per-call breakdown does not qualify: the rule abstains with a coverage note naming `tokens_in(model_call)`.

## Evidence

The locators of the two model calls with their `tokens_in`, the basis and model, and the locator of every candidate tool result with its `result_bytes` where present.

## Exclusions

Aggregate usage (no per-call breakdown); routing, retrieval and compaction calls; growth across a `token_basis` change or a `model` change (the series is split there); calls without a basis; incomplete spans without ordering.

## Thresholds

`min_delta_tokens` — Δ, the absolute rise in `tokens_in`; `min_ratio` — x, the rise relative to the previous call. Provisional; never tuned per run.

Defaults:

- `min_delta_tokens` = 8000
- `min_ratio` = 1.5

## Limitations

Cannot attribute growth to a specific result without `included_result_ids`; prompt and system changes are invisible; the candidates are candidates, not causes.

## Remediation

Truncate or summarize the candidate results; check for duplicated results (REPEATED_TOOL_RESULT).

## Tier / Confidence

`projected` / `medium`: the token rise is measured, but which result caused it is inferred from ordering only.

## Fixtures

`tests/fixtures/rules/cg_positive.json` (+12,000 tokens and 2x with two tool results between), `cg_aggregate_only.json` (abstention), `cg_basis_change.json` and `cg_model_change.json` (growth across a boundary, no finding), `cg_ratio_too_small.json` (+9,000 but 1.2x, no finding).
