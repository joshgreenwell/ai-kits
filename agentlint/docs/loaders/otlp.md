# OTLP loaders: `otlp-json` and `otlp-jsonl`

Two loaders read OpenTelemetry trace exports into the neutral `Run` model:

| Format label | Module | Input |
| -- | -- | -- |
| `otlp-json` | `agentlint.loaders.otlp_json` | One OTLP/JSON `resourceSpans` envelope per file (the shape `otlpjson` exporters and `curl`-ed OTLP/HTTP payloads use). |
| `otlp-jsonl` | `agentlint.loaders.otlp_jsonl` | One envelope per line, as written by the OpenTelemetry Collector `file` exporter. |

Both accept a single file, several files, or a directory (direct children
that pass the loader's `detect()` sniff, sorted by name). Both never open a
path outside what they were given, never touch the network, and never copy
prompt or tool content into the model — only identifiers, counts, sizes and
fingerprints.

## Identity

* `Event.id` is the span ID exactly as written in the export: a hex string,
  leading zeros kept, never re-encoded. The trace ID is kept in
  `Event.scope["otlp"]["trace_id"]`. `parent_id` is the parent span ID.
* `Event.source_locator` is a JSON pointer into the file:
  `"<file>#/resourceSpans/i/scopeSpans/j/spans/k"` for `otlp-json` and
  `"<file>:<line>#/resourceSpans/i/scopeSpans/j/spans/k"` for `otlp-jsonl`
  (`<line>` starts at 1). The pre-1.0 `instrumentationLibrarySpans` key is
  accepted and appears verbatim in the pointer.
* `startTimeUnixNano` / `endTimeUnixNano` are string-encoded int64 values.
  They are parsed exactly (no float), `start_ms` / `end_ms` are integer
  floor division by 1 000 000, and the raw span — nanos as strings — is kept
  in `Run.raw_records` as `{"source_locator": ..., "span": ...}`.
* Typed attribute values are decoded without float coercion: `intValue`
  (string or int) → `int`, `stringValue` → `str`, `doubleValue` → `float`,
  `boolValue` → `bool`, `arrayValue` → `list`, `kvlistValue` → `dict`,
  `bytesValue` → the base64 text as given. An attribute that cannot be
  decoded is skipped and reported as a reason; it is never guessed.

## Run ID fallback

Each span's run is resolved in this order; the first hit wins:

1. the app attribute named by `config["run_id_attribute"]` (for example
   `app.run.id`), looked up on the span and then on its resource;
2. `gen_ai.conversation.id` on the span;
3. the same lookup on each ancestor span in the trace (a root `invoke_agent`
   span usually carries the conversation ID for all its children);
4. if the trace contains exactly one distinct run ID from steps 1–2, that ID;
5. the trace ID — flagged with the coverage note `run_id_fallback_trace_id`
   listing the span IDs involved. `Run.conversation_id` stays `None`.

The run ID is never assumed to equal the trace ID silently, and no ID is ever
synthesised from another. `Run.conversation_id` is `gen_ai.conversation.id`
when present (a run whose spans carry several values keeps the first in sort
order and gets a `conversation_id_conflict` note).

## Attribute mapping

The table below is generated from `ATTRIBUTE_MAPPINGS` in
`agentlint.loaders.otlp_mapping` (`python -m agentlint.loaders.otlp_mapping`
prints it; a test asserts this section matches). For each field the names
are tried in order and the first present attribute wins. Values of the wrong
type are reported as reasons and leave the field absent (`None`).

<!-- mapping-table:start -->
| Field | Attribute | Generation | Type | Notes |
| -- | -- | -- | -- | -- |
| `model` | `gen_ai.response.model` | current | str | Model name; the response model wins over the requested one. |
|  | `gen_ai.request.model` | current | str |  |
| `provider` | `gen_ai.provider.name` | current | str | Provider / system name. |
|  | `gen_ai.system` | legacy | str |  |
| `operation_name` | `gen_ai.operation.name` | current | str | Operation name used for span kind classification. |
| `conversation_id` | `gen_ai.conversation.id` | current | str | Conversation / session ID; second step of the run-ID fallback. |
| `tokens_in` | `gen_ai.usage.input_tokens` | current | int | Input token count. |
|  | `gen_ai.usage.prompt_tokens` | legacy | int |  |
| `tokens_out` | `gen_ai.usage.output_tokens` | current | int | Output token count. |
|  | `gen_ai.usage.completion_tokens` | legacy | int |  |
| `tokens_total` | `gen_ai.usage.total_tokens` | legacy | int | Total token count as reported; never recomputed. |
| `cache_read_tokens` | `gen_ai.usage.cache_read.input_tokens` | current | int | Tokens served from a prompt cache, where the instrumentation reports them. |
|  | `gen_ai.usage.cache_read_input_tokens` | extension | int |  |
| `cache_write_tokens` | `gen_ai.usage.cache_creation.input_tokens` | current | int | Tokens written to a prompt cache, where the instrumentation reports them. |
|  | `gen_ai.usage.cache_creation_input_tokens` | extension | int |  |
| `finish_reason` | `gen_ai.response.finish_reasons` | current | str_or_list | Finish reason(s); a list is joined with commas. |
|  | `gen_ai.response.finish_reason` | legacy | str_or_list |  |
| `tool_call_id` | `gen_ai.tool.call.id` | current | str | Tool call ID; the dedup join key for tool spans. |
| `tool_name` | `gen_ai.tool.name` | current | str | Tool name; becomes the tool event's name. |
| `tool_args` | `gen_ai.tool.call.arguments` | current | content | Tool arguments; fingerprinted, never stored. |
| `tool_result` | `gen_ai.tool.call.result` | current | content | Tool result; fingerprinted and measured, never stored. |
| `error_type` | `error.type` | current | str | Error class or code of a failed span. |
<!-- mapping-table:end -->

Generations: `current` is the present GenAI semantic convention name,
`legacy` an earlier name that exports in the wild still carry, `extension`
a flat spelling some instrumentations emit. Two exports that differ only in
generation load to identical runs (raw records aside).

Other `gen_ai.*` attributes fall into two groups:

* names the conventions define but no rule needs (`gen_ai.request.temperature`,
  `gen_ai.agent.name`, `gen_ai.response.id`, ... — see
  `KNOWN_UNMAPPED_GEN_AI_ATTRIBUTES`) are ignored silently;
* any other `gen_ai.*` name is ignored and listed once per run in the
  coverage note `unknown_gen_ai_attributes`, so drift in the conventions is
  visible instead of silent.

Attributes outside the `gen_ai.*` namespace (`http.*`, `app.*`, ...) are not
interpreted, except the configured run-ID attribute.

Tool content is read from `gen_ai.tool.call.arguments` /
`gen_ai.tool.call.result` on the span, or — for the result — from a
`gen_ai.tool.message` span event (`gen_ai.tool.call.result` or `content`
attribute). A JSON-encoded string is parsed before hashing so key order does
not change the fingerprint. `result_bytes` is the UTF-8 length of the result
as exported. Absent content gives `None`, never an empty-value hash.

## Span kind

| Condition | `Event.kind` |
| -- | -- |
| Any `gen_ai.tool.*` attribute, or `gen_ai.operation.name` in `execute_tool` / `tool` | `tool_call` |
| Model span (`gen_ai.operation.name` in `chat`, `text_completion`, `generate_content`, `embeddings`, or any model / usage / finish-reason field) with no model-call descendant | `model_call` |
| Model span with one or more model-call descendants, or any span with two or more | `aggregate` |
| Anything else | `other` |

Descendants are counted over the whole input, so a wrapper span in one page
sees its children in another. An aggregate's usage is never added to its
children's (see `agentlint.tokens`).

`Event.name` is the span name, except for tool spans, where it is
`gen_ai.tool.name` when present. `Event.seq` is always `None`: OTLP carries
no sequence, only timestamps.

## Status

| Span status | `Event.status` |
| -- | -- |
| `STATUS_CODE_ERROR` / `2` | `error` (`error.type` → `error_type`) |
| `STATUS_CODE_OK` / `1` | `ok` |
| `STATUS_CODE_UNSET` / `0` / absent, and a parsed result is present (finish reason or output tokens for model spans; a result value for tool spans) | `ok` |
| otherwise | `unknown` |

## Usage and token basis

Missing usage attributes stay `None` — never `0` — and the run's
`coverage.fields` report `tokens_in` / `tokens_out` as `absent` when no
model call has them and `partial` when only some do. Model calls without any
usage are listed in a `usage_absent` note.

The conventions do not say whether `gen_ai.usage.input_tokens` includes
prompt-cache reads; that depends on the provider. `Event.token_basis` is
therefore `None` unless the caller passes `config["token_basis"]`
(`input_includes_cache_read` or `input_excludes_cache_read`), in which case
it is recorded on every model call and aggregate that carries usage. Calls
without a basis are comparable to nothing.

## Coverage and errors

A malformed record never crashes the loader:

* a span without `traceId` / `spanId`, a non-object span, a float timestamp
  or an undecodable attribute becomes a reason
  (`"<locator>: <what was wrong>"`) on the affected run, which is marked
  `incomplete`; a problem that cannot be tied to one trace is attached to
  every run from that file;
* a file that is not valid JSON, cannot be read, or yields no span becomes a
  `LoadError` with path, reason and locator; other files still load;
* a missing path or an empty directory is also a `LoadError`.

Coverage note codes emitted by these loaders: `run_id_fallback_trace_id`,
`conversation_id_conflict`, `unknown_gen_ai_attributes`, `usage_absent`,
`dropped_attributes` (spans reporting `droppedAttributesCount > 0`), plus the
`dedup_*`, `merge_conflict` and `*_token_basis` notes from normalization.

## Multi-file merge

Runs are built per file and merged by run ID with `agentlint.dedup.merge_runs`,
then normalized. Spans of one run split across pages or rotated files land
in one `Run` (`source_refs` lists every file). The same span written into two
files is collapsed by span ID and counted in `coverage.events_dropped_dedup`
with a `dedup_merged` note citing the span.

## `otlp-jsonl` record convention

* One complete OTLP/JSON envelope (`{"resourceSpans": [...]}`) per line,
  UTF-8, `\n` terminated — the Collector `file` exporter's default output.
* Blank lines and a trailing newline are tolerated and skipped.
* A line that is not valid JSON is skipped: it is recorded in
  `coverage.truncation_notes` (and `reasons`) as
  `"<file>:<line>: line <line> is not valid JSON (...); line skipped"` on
  every run from that file, which is marked `incomplete`. Every other line
  still loads. A file with no loadable line is a `LoadError`.
* `detect()` accepts a file whose first non-blank line is a complete JSON
  object mentioning `resourceSpans`. A pretty-printed envelope (first line
  `{`) belongs to `otlp-json`; a compact single-line envelope is accepted by
  both loaders and loads identically.

## Configuration

`load(paths, config)` reads these optional keys:

| Key | Meaning |
| -- | -- |
| `run_id_attribute` | App attribute naming the run (step 1 of the fallback). |
| `token_basis` | `token_basis` to record on model calls that carry usage. |
| `token_config` | `agentlint.tokens.TokenConfig` used during normalization. |
