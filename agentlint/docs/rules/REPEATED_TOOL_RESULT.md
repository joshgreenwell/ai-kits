# REPEATED_TOOL_RESULT — Identical sizeable result entered the context repeatedly

Category: `cost` · Tier: `proven` · Confidence: `medium`

Requirements: `result_fingerprint(full)`, `result_bytes`

## Problem

The same sizeable result enters the context multiple times, even when the arguments that produced it differ.

## Detection

At least `min_results` (N) distinct tool-call events with an equal `full` result fingerprint and `result_bytes` of at least `min_result_bytes` (B), regardless of tool name or arguments.

## Prerequisites

`result_fingerprint(full)` and `result_bytes` on tool-call events. Events whose fingerprint is not `full` are skipped and listed in a `rule_partial` note; no equality claim is made about them.

## Evidence

The locator of every repeated result, the shared result hash (excerpt), each result's size, and the tool name and args fingerprint that produced it.

## Exclusions

Empty or status results (under 16 bytes or placeholders are never fingerprinted, so never equal); deliberate rereads tagged `reread` by the loader; redaction or truncation collisions (fingerprints that are not `full`).

## Thresholds

`min_results` — N, how many identical results it takes; `min_result_bytes` — B, the smallest size that counts, in bytes. Provisional; never tuned per run.

Defaults:

- `min_result_bytes` = 8192
- `min_results` = 3

## Limitations

Identical bytes can be legitimately needed repeatedly (a schema, a manifest); the rule cannot judge necessity.

## Remediation

Cache at the tool boundary or reference the earlier result.

## Tier / Confidence

`proven` / `medium`: equality and size are arithmetic on fingerprints and byte counts; necessity is unknown.

## Fixtures

`tests/fixtures/rules/rtr_positive.json` (three 10 KiB results with one hash and different args), `rtr_small.json` (2 KiB, no finding), `rtr_status_strings.json` (`"ok"` results never hashed, no finding), `rtr_truncated.json` (one side truncated, no claim, partial note).
