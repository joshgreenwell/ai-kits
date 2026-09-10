# Loader: `claude-session-jsonl` (experimental)

> **Warning: experimental, undocumented upstream format.** Claude Code writes
> its session transcripts as JSONL under `~/.claude/projects/<project>/*.jsonl`
> (subagent transcripts under a `subagents/` subdirectory). Anthropic does not
> document this format and changes it between releases. This loader is
> **off by default** and must be enabled explicitly:
>
> * Python: `claude_session.load(paths, experimental=True)`, or a `config`
>   whose `experimental` (or `experimental_claude_session`) flag is true;
> * command line: `--experimental-claude-session` (arrives with the CLI story).
>
> Without the opt-in, `load()` returns no runs and one `LoadError` that says
> how to enable it. Nothing is read from disk until the gate is passed.

Module: `agentlint.loaders.claude_session` — `FORMAT_LABEL = "claude-session-jsonl"`,
`EXPERIMENTAL = True`, `detect(path)`, `load(paths, config=None, *, experimental=False)`.

## Version note

The mapping and the synthetic fixtures under `tests/fixtures/claude_session/`
are modelled on the record shapes of session logs written by **Claude Code
2.1.x** (2.x line). The `version` strings inside the fixtures (`2.1.0`,
`2.1.1`) are placeholders, not observed builds. Every log line that carries a
`version` field contributes a `source_refs` entry `claude-code-version=<v>` to
its run, so a scan of a directory records which builds wrote it; a run with no
version string at all gets a `claude_code_version_unknown` coverage note.
Older or newer builds may write records this loader does not recognise —
those are reported, never skipped (see the table below).

## Identity join

| Log field | Model field |
| -- | -- |
| `sessionId` | `Run.id` and `Run.conversation_id` |
| record `uuid` (first line of an assistant message) | `Event.id` of the `model_call` |
| `message.id` (API message id) | `scope.claude_session.message_id`; groups the lines of one streamed message |
| `parentUuid` | ordering hint: `Event.seq` is the record's depth in the `parentUuid` chain (computed across every file passed); the raw value is kept as `scope.claude_session.parent_uuid` |
| `tool_use.id` ↔ `tool_result.tool_use_id` | `Event.id`, `tool_call_id` and `native_tool_call_id` of the `tool_call` (all the same original id; nothing is synthesised) |
| `isSidechain: true` + `agentId` | a separate run: `Run.id = agentId`, `Run.conversation_id = sessionId` |
| `timestamp` (ISO-8601) | `Event.start_ms` / `end_ms`, `Run.started_at` / `ended_at` as integer Unix milliseconds |
| `version` | `Run.source_refs` entry `claude-code-version=<v>` |

`source_locator` is `<file>:<line>` for a record and
`<file>:<line>#/message/content/<i>` for a content block, where `<file>` is
the path as passed (or `<dir>/<name>.jsonl` for a directory argument).

## Record-type table

| Top-level `type` | Handling |
| -- | -- |
| `assistant` | **mapped** → one `model_call` per `message.id`. A streamed response is written as several lines (one per content block, `apiBlockIndex`), each repeating `usage`; the loader keeps the *last* line's `usage`, `stop_reason` and `model` and uses the *first* line's `uuid` and `timestamp`. `tool_use` blocks → `tool_call` events with `parent_id` = the `model_call` id. `isApiErrorMessage: true` → `status = "error"`, `error_type = "api_error"`. |
| `user` | **mapped** for `tool_result` blocks → attached to the matching `tool_call` (`result_bytes`, `result_fingerprint`, `end_ms`, `status`). Human prompts (`content` as a string or `text` blocks) produce no event and are never read. |
| `summary`, `system`, `file-history-snapshot`, `progress`, `attachment`, `queue-operation`, `last-prompt` | **ignored with note** (`ignored_record_type`, with a count). They describe UI state, hooks, file snapshots or queue bookkeeping, not model or tool operations. The run stays `complete`. |
| anything else | **incomplete**: reason `unknown_record_type:<type>` plus a note citing the count and the first locator. Never skipped silently. |
| not JSON / not an object | **incomplete**: reason `unparseable_line:<file>:<line>`. A file with no usable records is a `LoadError`. |

Content block types inside `message.content[]`:

| Block `type` | Handling |
| -- | -- |
| `tool_use` | `tool_call` event: `name`, `args_fingerprint = fingerprint(input)`; `input` shorter than 16 bytes (or `{}`) yields no fingerprint |
| `tool_result` | `result_bytes` = UTF-8 length of `content` (a string, or the canonical JSON of a block list); `result_fingerprint = fingerprint(content)`; `is_error: true` → `status = "error"`, `error_type = "tool_error"`; otherwise `status = "ok"` |
| `text`, `thinking`, `redacted_thinking`, `image`, `document` | skipped; content never read |
| anything else | **incomplete**: reason `unknown_content_block:<type>` |

Records without a `sessionId` (snapshots, summaries) are attributed to the
file's first session and counted in a `records_without_session_id` note. A
`tool_result` whose `tool_use` is in none of the files passed becomes a
`tool_call` with `name = null` and the run is marked incomplete with reason
`tool_result_without_tool_use` (usually a continuation whose earlier part was
not passed in). A `tool_use` with no result keeps `status = "unknown"` and
`result_bytes = null`; that is not incompleteness, the run may simply have
ended there.

Not mapped (time-boxed): `toolUseResult` (the app-level structured result; the
model-visible `tool_result` block is used instead), `system` hook errors,
`end_ms` / `duration_ms` of model calls (the log records when lines were
written, not when the API call returned), `provider` (left `null`; the log
does not say which endpoint served the call), `tokens_total` (the log carries
no total and the loader never sums).

## Token basis

Every `model_call` with a `usage` object carries
`token_basis = "input_excludes_cache_read"` (the module constant
`CLAUDE_SESSION_TOKEN_BASIS`, equal to
`agentlint.model.TOKEN_BASIS_INPUT_EXCLUDES_CACHE_READ`). Reading of the
Anthropic usage semantics: `input_tokens` counts only the uncached part of the
prompt; `cache_read_input_tokens` (prompt tokens served from the prompt cache)
and `cache_creation_input_tokens` (prompt tokens written to the cache) are
reported separately and are *not* included in `input_tokens`. The mapping is

| `usage` field | `Event` field |
| -- | -- |
| `input_tokens` | `tokens_in` (excludes cache reads and cache writes) |
| `output_tokens` | `tokens_out` |
| `cache_read_input_tokens` | `cache_read_tokens` |
| `cache_creation_input_tokens` | `cache_write_tokens` |
| (none) | `tokens_total` stays `null` |

A message without `usage` gets `null` counts and a `null` token basis, so it
is comparable to nothing (see `agentlint.tokens`). A zero the log carries
(for example `cache_creation_input_tokens: 0`) is kept as `0`; an absent field
is `null`.

## Sidechain (subagent) policy

Claude Code runs subagents as *sidechains*: records with `isSidechain: true`
that share the parent's `sessionId` and (in 2.1.x) carry an `agentId`; recent
builds write them to `subagents/<agentId>.jsonl`, older builds interleaved them
in the parent file. Either way the sidechain is a separate conversation with
its own context window, so its events are **never merged into the parent run
as if they were sequential**:

* with an `agentId`, the sidechain becomes its own run with `id = agentId`
  and `conversation_id = <parent sessionId>`; the parent run gets a
  `sidechain_split` note naming the agent ids that were split out of the same
  file, and the parent's own delegation `tool_call` (for example the `Agent`
  tool) still joins with its `tool_result` as usual;
* without an `agentId` there is no original identifier to key a run on, so the
  sidechain records are left out and the parent run is marked **incomplete**
  with reason `sidechain_without_agent_id` and a note citing the count and the
  first locator.

Pass the `subagents/` directory (or its files) alongside the parent file to
load both; a directory argument is deliberately not recursive.

## Multiple files and directories

`load()` accepts files and directories. A directory contributes only the
regular `*.jsonl` files directly inside it — no recursion, no symlinks, no
other suffixes — and **nothing outside the paths passed is ever opened**.
Files are processed in sorted path order, so the caller's argument order does
not change the output. Runs that share an id across files (a session split
over several files, or a resumed session) are merged with
`agentlint.dedup.merge_runs` and normalised with `normalize_runs`: the two
halves of a `tool_call` (the `tool_use` in one file, the `tool_result` in
another) collapse into one event, recorded as a `dedup_merged` note. The
result's runs are sorted by id and the output is byte-identical for the same
input.

## Privacy statement

Session logs contain the full conversation: prompts, model output, thinking,
tool inputs (commands, file paths), tool results (file contents, command
output), the working directory and the git branch. **The loader keeps none of
that.** What survives into the model is limited to:

* identifiers: `sessionId`, record `uuid`s, `parentUuid`, `message.id`,
  `agentId`, `tool_use` ids, the model name and tool names;
* numbers: token counts, timestamps, byte lengths of tool results, sequence
  depths;
* SHA-256 fingerprints of tool inputs and tool results (never computed over
  values shorter than 16 bytes);
* the Claude Code `version` string and the path of the log file as passed.

`Run.raw_records` is left empty on purpose; `cwd`, `gitBranch`, prompt text,
`text` / `thinking` blocks, `tool_use.input` and `tool_result.content` are
read only to compute the hashes and lengths above and are never stored.
Fixtures in this repository are hand-written with invented values.
