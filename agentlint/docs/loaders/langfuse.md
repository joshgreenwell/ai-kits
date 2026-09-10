# Loader: `langfuse-observations`

Module: `agentlint.loaders.langfuse`. Format label: **`langfuse-observations`**.

Loads rows exported from the Langfuse **Observations API** — the observation
objects themselves, not OTLP spans. The loader reads files only; it never
calls the Langfuse API or any other network endpoint.

## Version note: v2 vs the older Observations API

Langfuse has shipped two shapes for an observation's usage:

| Shape | How usage is carried | Loader behaviour |
| -- | -- | -- |
| **v2 (targeted)** — `GET /api/public/v2/observations` | `usageDetails` object: `input`, `output`, `total` plus provider-specific detail keys such as `input_cached_tokens` or `cache_read_input_tokens`; costs in `costDetails` | Fully mapped, including `token_basis` (see below). |
| **older** — `GET /api/public/observations` and early exports | Top-level `promptTokens` / `completionTokens` / `totalTokens`, and/or a `usage` object with `input` / `output` / `total` / `unit` | Loaded, but reported with a **loud coverage note** `legacy_observation_shape` naming the fields found, plus the run reason `legacy_observation_shape` (run is `incomplete`). Counts are mapped when `unit` is `TOKENS` or absent; `token_basis` stays `null` because cache semantics are undocumented for this shape. A non-token `unit` (for example `CHARACTERS`) maps no counts and adds `usage_unit_not_tokens`. |

A row that carries both (`usageDetails` next to a deprecated `usage` object,
as v2 responses do) is treated as v2. Which shape was found is recorded per
run in the coverage notes, so a reviewer never has to guess.

Observation types are read case-insensitively. The v2 API's newer span
types (`AGENT`, `CHAIN`, `RETRIEVER`, `EVALUATOR`, `GUARDRAIL`) are treated
like `SPAN`; `EMBEDDING` is treated like `GENERATION` because it carries a
model and usage.

## Accepted files

| File | Layout | `source_locator` |
| -- | -- | -- |
| `*.json` | A JSON array of observation objects, **or** one API page object `{"data": [...], "meta": {...}}` (a top-level `_fixture` key is tolerated and ignored) | `<file>#/<index>` or `<file>#/data/<index>` (JSON pointer) |
| `*.jsonl`, `*.ndjson` | One observation object per line; blank lines skipped | `<file>#<line index>` (0-based) |
| `*.csv` | One observation per row; header row uses the API field names. Cells for `usageDetails`, `usage`, `metadata`, `input`, `output`, `modelParameters`, `costDetails` may be JSON text. Flattened columns such as `usageDetails.input` are folded back into the object. An empty cell is absent, never `0` or `""`. | `<file>#<row index>` (0-based, header excluded) |

A directory loads every file in it that `detect()` accepts (sorted by name);
files named explicitly are always parsed. Rows sharing a `traceId` across
files or pages are merged with `agentlint.dedup.merge_runs` and deduplicated
by observation `id`; `Run.source_refs` lists every file that contributed.
Runs are returned sorted by ID.

`detect(path)` is a 64 KiB sniff: JSON / JSONL must mention `"traceId"` and
`"startTime"` and must not contain OTLP markers (`"spanId"`, `"resourceSpans"`);
CSV needs `id`, `traceId` and `type` header columns. It never raises.

## Field mapping

Field groups: `core,basic,time,io,metadata,model,usage,trace_context`.

| Langfuse field | Model field | Notes |
| -- | -- | -- |
| `id` | `Event.id` | Verbatim. A row without `id` is skipped and cited by locator (`rows_skipped`). |
| `traceId` | `Run.id` | One `Run` per trace; a file with several traces yields several runs. A row without `traceId` is a `LoadError`. |
| `parentObservationId` | `Event.parent_id` | Verbatim; never inferred. |
| `sessionId` | `Run.conversation_id` | First sorted value; disagreement within a trace adds `merge_conflict`. |
| `type` | `Event.kind` + `scope.langfuse.type` | See kind mapping below. |
| `name` | `Event.name` | Verbatim label. |
| `startTime`, `endTime` | `start_ms`, `end_ms`, `duration_ms`; `Run.started_at` / `ended_at` (min / max) | ISO-8601 (`Z` or offset; naive is UTC) or numeric epoch ms. Unparseable → `null` + `unparseable_time`. |
| `model` | `Event.model` | Verbatim. `provider` is not derived. |
| `level` | `Event.status` + `scope.langfuse.level` | `ERROR` → `error`; any other level → `ok`; absent → `unknown`. |
| `statusMessage` | — | Inspected for nothing; **never copied**. `error_type` stays `null`. |
| `usageDetails` (v2) | `tokens_in` ← `input`, `tokens_out` ← `output`, `tokens_total` ← `total`, `cache_read_tokens` ← one of `input_cached_tokens`, `cache_read_input_tokens`, `input_cache_read`, `cached_tokens`; `cache_write_tokens` ← one of `cache_creation_input_tokens`, `input_cache_creation`, `input_cache_write`; `token_basis` | Ints, integral floats and digit strings accepted. More than one cache-read key present → `cache_read_tokens` `null` + `usage_detail_ambiguous`. |
| `promptTokens`, `completionTokens`, `totalTokens`, `usage.{input,output,total,unit}` (older) | `tokens_in`, `tokens_out`, `tokens_total` | `token_basis` `null`; see version note. |
| `input` | `args_fingerprint` | SHA-256 of canonical JSON (`agentlint.fingerprint.fingerprint`); `null` when absent or under 16 bytes. **Content never copied.** |
| `output` | `result_fingerprint`, `result_bytes` | Fingerprint as above; `result_bytes` is the UTF-8 length of the string or of the canonical JSON of a structured value. |
| `inputTruncated`, `outputTruncated` | fingerprint `representation` = `truncated`; `Coverage.truncated` | When the export marks a value as cut off. Otherwise `representation` = `full`. |
| `metadata` | `tool_call` detection and `tool_call_id` only | Keys `tool`, `tool_name`, `toolName`, `tool_call_id`, `toolCallId`, `tool_use_id`, `toolUseId`, or `type` / `kind` = `tool` mark a span as a tool call; `tool_call_id` is read verbatim from the `*_call_id` / `*_use_id` keys. **Nothing else in `metadata` is copied.** |

Recognised but unused (ignored silently): `projectId`, `environment`,
`version`, `release`, `completionStartTime`, `latency`, `timeToFirstToken`,
`modelId`, `modelParameters`, `promptId`, `promptName`, `promptVersion`,
`costDetails`, calculated cost and price fields, `unit`, `traceName`,
`traceTags`, `traceTimestamp`, `traceEnvironment`, `traceVersion`,
`traceRelease`, `traceMetadata`, `userId`, `traceUserId`, `createdAt`,
`updatedAt`. Any other field is ignored and listed once per run in an
`unknown_fields` coverage note.

Fields the model has but this export cannot supply stay `null`: `seq`,
`provider`, `adapter`, `finish_reason`, `error_type`, `error_code`,
`native_tool_call_id`, `preview_bytes`.

### Observation type → `Event.kind`

| Type | Kind |
| -- | -- |
| `GENERATION`, `EMBEDDING` | `model_call` |
| `TOOL` | `tool_call` |
| `SPAN` (or `AGENT`, `CHAIN`, `RETRIEVER`, `EVALUATOR`, `GUARDRAIL`) with tool metadata | `tool_call` |
| span-like type with at least one `model_call` descendant (via `parentObservationId` within the trace) | `aggregate` |
| `EVENT`, any other span, unknown or missing type | `other` |

Tool metadata wins over wrapping: a span marked as a tool is a `tool_call`
even if a generation sits under it.

## `token_basis` derivation (assumption — read this)

Langfuse documents `usageDetails` as a set of **disjoint** usage categories
whose sum is `total` (when `total` is omitted, Langfuse computes it as the
sum of the other keys). Under that reading `input` does **not** contain the
tokens reported under a cache-read detail key, so:

* `usageDetails` with a cache-read detail key present → `token_basis =
  input_excludes_cache_read`, `cache_read_tokens` = that key's value.
* `usageDetails` with `input` / `output` / `total` but **no** cache-read key →
  `token_basis = input_excludes_cache_read` is **assumed** from the same
  semantics and the run gets a `token_basis_assumed` coverage note naming the
  events. The export cannot say whether the integration that produced the row
  folded cache reads into `input`; if you know it did, treat those events as
  `input_includes_cache_read` yourself.
* Older shape (`promptTokens` / `usage.unit`) → `token_basis = null`; the
  counts are comparable to nothing (`token_basis_absent`).
* No usage at all → every token field `null`, `token_basis = null`.

This is the loader's reading of the Langfuse documentation, not a statement
by Langfuse; it is recorded here so it can be corrected in one place.

## What this loader never does

* Never copies `input`, `output`, `metadata` or `statusMessage` content into
  the model or the JSON output — only fingerprints, byte sizes and
  identifiers. `Run.raw_records` holds content-free identity records
  (`id`, `traceId`, `parentObservationId`, `type`, locator) only.
* Never calls an API; rows come from files you exported.
* Never invents an identifier or a parent link.
* Never turns absent usage into zero: a missing `usage` / `usageDetails`
  column leaves every token field `null`, sets `Coverage.fields.tokens_in`
  (and friends) to `absent`, and marks the run `incomplete` with reason
  `usage_absent` when the trace has model calls.

## Coverage notes emitted

| Code | Meaning |
| -- | -- |
| `legacy_observation_shape` | Rows use the older API shape; names the fields found. Also a run reason. |
| `usage_unit_not_tokens` | Older-shape rows report a non-token unit; counts not mapped. |
| `token_basis_assumed` | v2 rows without a cache-read detail key; basis assumed (see above). |
| `usage_detail_ambiguous` | More than one cache-read detail key on a row. |
| `usage_absent` | No model call in the trace carries usage; says whether the column was absent or empty. Also a run reason. |
| `unknown_fields` | Fields outside the known vocabulary, ignored. |
| `unparseable_time` | `startTime` / `endTime` not ISO-8601 or epoch. |
| `rows_skipped` | Rows with a `traceId` but no `id`, cited by locator. Also a run reason. |
| `merge_conflict` | Rows of one trace disagree on `sessionId`. |

Dedup and token-basis notes from `agentlint.dedup.normalize_run` apply as well.

## Producing the export

1. **From the API** (no SDK needed): page through
   `GET /api/public/v2/observations?fields=core,basic,time,io,metadata,model,usage,trace_context&traceId=<id>&limit=100&page=<n>`
   with your project's basic-auth keys and save each response body as
   `page-<n>.json`. Point `agentlint` at the directory; pages of one trace
   merge into one run. Drop `io` from `fields` if you would rather the
   export never contain content at all — the loader then reports
   `args_fingerprint` / `result_bytes` as absent instead.
2. **From the UI**: export the Observations table as CSV or JSON with the
   same field groups. JSON cells inside the CSV are decoded; empty cells are
   absent.
3. Concatenate observation objects one per line for a `.jsonl` file if your
   tooling streams them.

Rows from several traces may share a file; each trace becomes its own run.
