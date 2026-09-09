# Record bundle: the neutral input format for app debug reports

Format label: `record-bundle`. Schema: [`record-bundle.schema.json`](record-bundle.schema.json)
(JSON Schema draft 2020-12, `schema_version` `"1"`).

A *record bundle* is one JSON document that any application can emit from its own debug
report so that `agentlint` can lint the run without knowing anything about the
application. It carries **identifiers, kinds, statuses, timestamps, counts, sizes and
fingerprints** — never the content of prompts, tool arguments or tool results. The
application-specific mapper (debug report → record bundle) lives with the application;
this repository only publishes the target shape and the loader that reads it.

## Worked example

A short run: a framework turn (aggregate) wrapping one model call, a multi-target
command that failed, a policy approval that was denied, and the single-target retry.
Everything below is invented.

```json
{
  "schema_version": "1",
  "run_id": "run-0001",
  "conversation_id": "conv-0001",
  "source_refs": ["exampleapp/debug-report-0001"],
  "started_at": 1700000000000,
  "ended_at": 1700000060000,
  "final_status": "failed",
  "records": [
    {
      "id": "row-1",
      "kind": "aggregate",
      "status": "error",
      "name": "agent.turn",
      "seq": 1,
      "start_ms": 1700000000000,
      "end_ms": 1700000060000,
      "included_result_ids": ["row-2"]
    },
    {
      "id": "row-2",
      "kind": "model_call",
      "status": "ok",
      "parent_id": "row-1",
      "seq": 2,
      "start_ms": 1700000001000,
      "end_ms": 1700000003000,
      "model": "model-a",
      "provider": "provider-x",
      "token_basis": "input_excludes_cache_read",
      "tokens_in": 1200,
      "tokens_out": 80,
      "cache_read_tokens": 4000,
      "finish_reason": "tool_use"
    },
    {
      "id": "row-3",
      "source_locator": "exampleapp/debug-report-0001/rows/3",
      "kind": "tool_call",
      "status": "error",
      "parent_id": "row-2",
      "seq": 3,
      "name": "exec_group",
      "start_ms": 1700000003500,
      "end_ms": 1700000005000,
      "error_type": "TargetUnavailable",
      "tool_call_id": "call-0001",
      "native_tool_call_id": "native-0001",
      "args_fingerprint": {
        "hash": "3626c3989584d8ae50a79546943696d3e4e94eac50bb876ff0b3830ddbb62e4d",
        "representation": "full"
      },
      "result_fingerprint": {
        "hash": "94ca1481a12bf0f1fffbbc75409dc4ec3ef052cff13ce40fabb0891feddc1935",
        "representation": "full"
      },
      "result_bytes": 2048,
      "preview_bytes": 512,
      "scope": {
        "exampleapp": {"targets": ["target-a", "target-b"], "selection": "explicit"}
      },
      "raw": {"row": 3, "request_type": "exec_group"}
    },
    {
      "id": "row-4",
      "kind": "approval",
      "status": "blocked",
      "parent_id": "row-2",
      "seq": 4,
      "name": "policy.approval",
      "start_ms": 1700000005500,
      "tool_call_id": "call-0002",
      "scope": {"exampleapp": {"decision": "denied"}}
    },
    {
      "id": "row-5",
      "kind": "tool_call",
      "status": "ok",
      "parent_id": "row-2",
      "seq": 5,
      "name": "exec",
      "start_ms": 1700000009500,
      "end_ms": 1700000011000,
      "tool_call_id": "call-0003",
      "args_fingerprint": {
        "hash": "c2d9b13aec38fba7ffe3171a0b423ae2d42ec177695256b62eb487f08175be7d",
        "representation": "full"
      },
      "result_bytes": 300,
      "scope": {"exampleapp": {"targets": ["target-a"], "selection": "single"}}
    }
  ]
}
```

Loading it (`agentlint.loaders.record_bundle.load(path)`) yields one `Run` with
`source_format = "record-bundle"`, five events in `(start_ms, seq, id)` order, per-field
coverage judged only against the kinds a field applies to (`result_bytes` is `present`:
the approval needs none, and both tool calls have it; `end_ms` is `partial`: `row-4` has
none; `result_fingerprint` is `partial`: `row-5` has none), and the whole document
retained verbatim in `raw_records`. The run is `complete`: nothing was dropped or
truncated. A field being `partial` or `absent` is reported, not treated as an error.

## Absent means absent

* An optional field that the application does not know is **omitted**. `null` is not a
  value in this format: the schema forbids it, and a record containing one is dropped as a
  schema violation (the loader tells you which key, by JSON pointer). This keeps one
  encoding for "absent" and makes emitted bundles byte-deterministic.
* A missing key becomes `None` on the `Event`, and coverage reports the field as
  `partial` or `absent`. The loader never fills a gap: no `0` for unknown tokens, no
  `duration_ms` computed from `start_ms` and `end_ms`, no `result_bytes` derived from
  `preview_bytes`, no `tokens_total` summed from parts.
* Counts and timestamps are JSON **integers**. `12.5`, `true` and `"12"` are violations.
  (Draft 2020-12 would accept `12.0` as an integer; this loader does not.)

## Hashes, not content

The bundle never contains a prompt, a command line, a file path from a tool call, or a
tool result. What it contains instead:

| Instead of… | The bundle carries | Rule |
| -- | -- | -- |
| tool arguments | `args_fingerprint {hash, representation}` | SHA-256 over canonical JSON (sorted keys, no whitespace, arrays in order). Never computed over fewer than 16 bytes — omit the fingerprint for a placeholder (`{}`, `""`) or a tiny value; `agentlint.fingerprint.fingerprint()` returns `None` in that case. |
| tool result | `result_fingerprint` and `result_bytes` | `result_bytes` is the UTF-8 length of the *full* model-visible result (`agentlint.fingerprint.utf8_length`). |
| a truncated / redacted result | `representation: "truncated"` or `"redacted"` | Such fingerprints are kept for provenance and never support an equality claim. |
| a preview kept by the debug report | `preview_bytes` | Never a stand-in for `result_bytes`. If only a preview is known, omit `result_bytes`; coverage for it becomes `partial`/`absent`, the loader adds a `preview_only` note, and size rules abstain. |
| the original record | `raw` | Opaque, retained verbatim as evidence, never interpreted. **The application must redact it before emitting**; `agentlint` does not redact. |

Two records with the same `args_fingerprint` are byte-identical calls. Rules never compare
arguments semantically; if the application wants "same command, different targets"
distinguished, the targets belong in the arguments that are hashed *and*, if a rule needs
them, in `scope`.

## Top-level fields

| Field | Required | Meaning |
| -- | -- | -- |
| `schema_version` | yes | `"1"`. |
| `run_id` | yes | The application's own run identifier. Documents sharing it are merged into one run. |
| `conversation_id` | no | Conversation / session identifier. |
| `source_refs` | no | Report identifiers or export names. Recorded as `Run.source_refs`; when omitted the loader records the path of the file it read. |
| `started_at`, `ended_at` | no | Integer epoch milliseconds. |
| `final_status` | no | How the run ended, in the application's vocabulary. The neutral model has no run-level status; it is kept in the retained document (see below). |
| `records` | yes | The operations. Order is irrelevant. |

Keys starting with `_` (for example `_fixture` in the test fixtures) are annotations:
ignored and retained. Any other unknown top-level key is ignored too, and reported in an
`unknown_top_level_keys` coverage note so a misspelling is noticed.

## Record fields

| Field | Type | Meaning |
| -- | -- | -- |
| `id` | string, required | **Source identity**: the ID the application already has (row ID, span ID, message ID). Never derived from another ID. Records repeating an `id` are one operation and are collapsed. |
| `source_locator` | string | Where the record came from, in the application's terms. Defaults to `<file>#/records/<index>` — the JSON pointer of the record in the file the loader read. |
| `seq` | integer ≥ 0 | Application sequence number; second ordering key after `start_ms`. Two records without it are ordered by `id` only, which implies no causal order. |
| `parent_id` | string | `id` of the enclosing record. |
| `kind` | enum | `model_call`, `tool_call`, `approval`, `aggregate`, `other`. A framework span that summarises children is an `aggregate`, never a `model_call`; a permission decision is an `approval`. |
| `name` | string | Tool name, request type or span name. Generic rules match whole words of it against a visible routing / retrieval / compaction exclusion list. |
| `status` | enum, required | `ok`, `error`, `blocked` (denied by an approval or policy — not `error`), `unknown`. |
| `error_type`, `error_code` | string | Error class and code as the source names them (never a message). |
| `start_ms`, `end_ms`, `duration_ms` | integer ≥ 0 | Epoch milliseconds / milliseconds. `duration_ms` only when the source records it. |
| `model`, `provider`, `adapter` | string | As the source reports them. |
| `token_basis` | string | What `tokens_in` measures: `input_includes_cache_read` or `input_excludes_cache_read` are the documented values. Counts are compared and totalled only among records that share a basis and a model; a record without one is comparable to nothing. |
| `tokens_in`, `tokens_out`, `tokens_total`, `cache_read_tokens`, `cache_write_tokens` | integer ≥ 0 | Usage on the stated basis. `0` is a real value; unknown is omitted. |
| `finish_reason` | string | As the source reports it. |
| `tool_call_id` | string | Application-level call ID. Records of the same kind sharing it are one operation; an `approval` and the `tool_call` it decides share it without being merged. |
| `native_tool_call_id` | string | The model provider's ID for the same call; never substituted for `tool_call_id`. |
| `args_fingerprint`, `result_fingerprint` | `{hash, representation}` | See *Hashes, not content*. `hash` is lowercase hex; `representation` is `full`, `redacted` or `truncated`. |
| `result_bytes`, `preview_bytes` | integer ≥ 0 | See *Hashes, not content*. |
| `included_result_ids` | string[] | For an aggregate: the records it summarises. Also excludes the aggregate's usage from token comparisons when children exist. |
| `scope` | object of objects | Namespaced application data: `{"<namespace>": {...}}`. Passed through **untouched**; generic rules never read it. The one neutral namespace is `agentlint` with a `tags` list (`routing`, `retrieval`, `compaction`) that the token-basis helpers honour. |
| `raw` | any non-null | The original record, opaque. |

Records reject unknown properties, so a misspelled field (`token_in`) is a violation
rather than silently lost. Application data goes under `scope` or `raw`.

## Identity join and merging

The loader accepts a single file, several files, or a directory (its `*.json` files,
not recursive). Files are read in sorted path order, so the result does not depend on the
order they were given. Documents sharing `run_id` are merged with
`agentlint.dedup.merge_runs` (events, retained documents and coverage notes concatenated;
`started_at` min, `ended_at` max; `source_refs` unioned in order) and each run is then
normalized: records that share an `id`, or the same `kind` and `tool_call_id`, collapse
into one event (the richer field set wins, conflicts become `dedup_conflict` notes, and
`coverage.events_dropped_dedup` counts the drops); events are sorted by
`(start_ms, seq, id)`; per-field coverage is computed. Two records with different
`tool_call_id` values are never merged, however similar their fingerprints.

## Validation

The loader validates every document against the published schema before mapping it,
with a small hand-written validator (`agentlint.loaders.record_bundle.validate`) that
implements exactly the draft 2020-12 keywords the schema uses: `type`, `enum`,
`required`, `properties`, `additionalProperties`, `items`, `minimum`, `minLength`,
`pattern` and local `$ref`. There is no third-party dependency. A test asserts that the
schema uses no keyword outside that set, so nothing in it is silently unchecked.

* A violation **inside a record** drops that record. The run still loads and is marked
  `incomplete`: `coverage.reasons` gets one entry per violation with its JSON-pointer
  locator (`report.json#/records/3/tokens_in: expected integer, got number`) and
  `coverage.notes` gets one `schema_violation` note per dropped record naming the fields
  involved and the record's `id` when it had one. An `incomplete` run is never rendered
  as clean.
* A violation **at the top level** (missing `run_id`, unknown `schema_version`, `records`
  not an array, the document not an object), unreadable input, or invalid JSON is a
  `LoadError` with the file path and the pointer of the first violation; no run is
  produced for that file. Other files in the same call still load.

## Mapping your own debug report

1. **Pick the identity.** `run_id` is the identifier your report already has for the run;
   `id` on each record is the row / span / message ID you already store. Do not build
   one from another (`f"{run_id}-{i}"` is not an identifier, it is a position).
2. **Locate each record.** Set `source_locator` to whatever lets a reader find the row in
   your system (report ID + row ID). If you have nothing better, leave it out and the
   loader records the JSON pointer in the emitted file.
3. **Classify.** One record per operation: model requests are `model_call`; commands,
   tool executions and grouped requests are `tool_call`; permission and policy decisions
   are `approval` with `status: blocked` when denied; framework turns and batches that
   wrap children are `aggregate` with `included_result_ids`; keep anything else as
   `other` if its order matters.
4. **Link.** `parent_id` for nesting; `tool_call_id` for the application-level call ID
   shared by a call and its approval; `native_tool_call_id` for the provider's ID.
5. **Measure, don't copy.** Fingerprint arguments and results with the canonical-JSON
   SHA-256 (or `agentlint.fingerprint.fingerprint`); record `result_bytes` only when you
   have the full result and `preview_bytes` when you have a preview; state
   `token_basis` for every usage figure.
6. **Namespace your extras.** Anything a rule of yours needs — targets, selection mode,
   policy names, final run status per record — goes under `scope["<yourapp>"]`. Put the
   original (redacted) row under `raw` if you want it as evidence. Run-level data such as
   `final_status` goes at the top level.
7. **Omit what you do not know.** Never write `null`, `0`, `""` or `{}` for an unknown.
8. **Page if you must.** Several files with the same `run_id` are one run.

## Run-level data and re-emitting

`Run.raw_records` holds each loaded bundle document verbatim (one entry per file), so
every `<file>#/records/<i>` locator resolves inside it. Run-level fields the neutral
model has no slot for — `final_status`, annotation keys — stay there:
`bundle_headers(run)` returns the top-level fields of each retained document and
`final_status(run)` the status the documents agree on (or `None`).

`to_record_bundle(run)` re-emits any `Run` as a bundle: records are built from the
events in canonical order with absent fields omitted and `source_locator` always
explicit; the header starts from the first retained document (so `final_status` and
annotations carry over) and is overwritten with the run's own identifiers and
timestamps; `raw` is carried for a record when the retained documents hold exactly one
value for its `id`. Loading the result gives the same events and coverage. For a bundle
already in this canonical form — records in `(start_ms, seq, id)` order, explicit
locators, no invalid records — the re-emitted document equals the original.

To regenerate the published schema after editing `SCHEMA` in
`src/agentlint/loaders/record_bundle.py`:

```sh
uv run python -c "from agentlint.loaders.record_bundle import schema_json; import sys; sys.stdout.write(schema_json())" > docs/record-bundle.schema.json
```
