# OVERSIZED_TOOL_RESULT — Single tool result large enough to dominate the next request

Category: `cost` · Tier: `proven` · Confidence: `high`

Requirements: `result_bytes`

## Problem

A single tool result is large enough to dominate the next request's context, paying for it on every later call.

## Detection

A tool-call event whose `result_bytes` (the model-visible serialized size) is at least `min_result_bytes` (B). `preview_bytes` is never used. When per-call usage exists, the next comparable model call after the result and its predecessor are located and their `tokens_in` delta is attached as a `projected` correlation line.

## Prerequisites

`result_bytes` on tool-call events. Exports that only kept `preview_bytes` make the rule abstain with a coverage note naming `result_bytes`; events without it in a run that otherwise qualifies are skipped and listed in a `rule_partial` note.

## Evidence

The result's locator, `result_bytes`, the tool name, and — when per-call usage exists — the locator of the next comparable model call with its `tokens_in` delta, marked projected.

## Exclusions

Deliberately requested large reads tagged `large_read` by the loader; preview-only sizes (`preview_bytes` is a lower bound and never triggers).

## Thresholds

`min_result_bytes` — B, the smallest model-visible size that counts, in bytes. Provisional; never tuned per run.

Defaults:

- `min_result_bytes` = 65536

## Limitations

Size is not harm: a large result may be exactly what was needed. The token correlation is a projection from ordering, not an attribution.

## Remediation

Paginate, filter or summarize at the tool boundary.

## Tier / Confidence

`proven` / `high` for the size claim (a measured byte count against a threshold); the correlation evidence line is `projected`.

## Fixtures

`tests/fixtures/rules/otr_positive.json` (70 KiB result with per-call usage), `otr_preview_only.json` (only `preview_bytes`, abstention), `otr_tagged_large_read.json` (tagged deliberate large read, no finding).
