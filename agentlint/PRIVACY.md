# Privacy statement

`agentlint` reads agent trace files. **Trace files are highly sensitive**: a
single export can contain prompts, system instructions, file contents,
command lines, credentials pasted into a conversation, customer data returned
by tools, and the paths and hostnames of the machine that produced it. This
document states what the tool does with that material, what its output
contains, and what it never does. Every statement here is backed by a test in
`tests/`.

## Nothing leaves the process

* **Zero network.** The tool opens no socket. It sends no telemetry, checks
  for no updates, fetches no rules, models or schemas. The test suite runs
  every fixture through every command and output format with socket creation
  monkeypatched to raise (`tests/test_cli_privacy.py::TestZeroNetwork`), and
  the packaging test installs the built wheel into a fresh virtual
  environment and runs it with `socket.socket` disabled process-wide
  (`tests/test_packaging.py`).
* **No persistent state.** Nothing is cached between invocations, no
  configuration is written, and no file is created except the one you name
  with `--output`. Running twice on the same input produces byte-identical
  output.
* **No third-party runtime dependencies.** The package depends on the Python
  standard library only; the lockfile is audited in CI for HTTP clients, SDKs
  and data-science packages.
* **No model in the loop.** No LLM, embeddings or tokenizer is ever invoked.

## What the output contains by default

By default the report — text, JSON or Markdown — contains **no content from
the trace**. It carries only:

* **identifiers** the source already had: run, conversation, span,
  observation, message and tool-call IDs, model and tool names, and the
  source locator of each record (file path as given plus a JSON pointer,
  line or row index);
* **counts and sizes**: token counts on their stated basis, byte lengths of
  tool results, event counts, durations and timestamps;
* **hashes**: SHA-256 fingerprints of tool arguments and tool results,
  labelled with what they were computed over (`full`, `redacted`,
  `truncated`); messages quote the first 12 hex characters.

`Run.raw_records` — the loader's verbatim source records — stay in memory for
evidence validation and are never written to any output. The JSON document
reports only how many were retained.

### The 16-byte minimum

A hash of a short value can be reversed by guessing (`"ok"`, `"true"`, a
two-digit status code). `agentlint` therefore **never fingerprints an input
shorter than 16 bytes** (`agentlint.fingerprint.MIN_HASH_INPUT_BYTES`); such
values yield `null`, and rules that would compare them abstain instead of
claiming equality. Placeholders (`{}`, `""`, `[]`, `null`) fall under the same
floor and can never produce an equality claim.

## `--include-snippets`

Snippets are opt-in. With `--include-snippets`, each evidence item a finding
cites may carry a *snippet* of the raw record it points to (an OTLP span, a
record-bundle record's `raw` value, or the record itself). Two rules apply,
in this order:

1. **Redaction first.** Credential patterns are replaced with labelled
   markers — `[REDACTED:api-key]` (`sk-…`), `[REDACTED:aws-key]`
   (`AKIA…` / `ASIA…`), `[REDACTED:bearer]`, `[REDACTED:github-token]`
   (`ghp_…`, `github_pat_…`), `[REDACTED:slack-token]` (`xox…`),
   `[REDACTED:private-key]` for PEM blocks, and `[REDACTED]` for the values
   of `password` / `secret` / `token` / `api_key` / `access_key` /
   `authorization` / `credential`-style fields — in every output format.
2. **Then truncation to 200 characters**, ellipsis included. Redacting before
   cutting means a cut can never hide a secret from the patterns.

Snippets come only from records already in memory; nothing is fetched or
inferred. Treat a report produced with `--include-snippets` as containing
trace content, because it may.

## What each loader reads

Every loader reads only the paths you pass (a directory contributes the
regular files directly inside it; subdirectories are listed as skipped and
never entered). Tests monkeypatch `open` to prove no other path is touched.

| Loader | Reads to compute | Never stores |
| -- | -- | -- |
| `otlp-json`, `otlp-jsonl` | span identifiers, timestamps, `gen_ai.*` usage and model attributes, `error.type`; tool arguments and results are hashed and measured | attribute values other than the mapped ones |
| `langfuse-observations` | observation identity and parent links, times, `model`, `usageDetails`, `level`, tool markers in `metadata`; `input` / `output` are hashed and measured | `input`, `output`, `metadata` values; `raw_records` hold identity fields only |
| `record-bundle` | the bundle as published: identifiers, kinds, statuses, timestamps, counts, sizes, fingerprints, `scope`, `raw` | the bundle carries no content by design; the application redacts `raw` before emitting |
| `claude-session-jsonl` (experimental) | `sessionId`, record `uuid`s, `parentUuid`, `message.id`, `agentId`, `tool_use` ids, model and tool names, `usage` counts, timestamps, the Claude Code `version` string; `tool_use.input` and `tool_result.content` are hashed and measured | prompt text, `text` / `thinking` blocks, `cwd`, `gitBranch`, tool inputs and results; `raw_records` are left empty |

The Claude Code session loader is off by default because it reads local
transcripts under `~/.claude/projects/` that routinely contain private code
and prompts; enable it with `--experimental-claude-session` only for files
you intend to lint.

## Fixtures and this repository

Everything under `tests/fixtures/` and `tests/e2e/` is synthetic and says so
in a header (`origin`, `ref`, `completeness`, `excerpt_or_raw`). A hygiene
check (`scripts/check_fixture_hygiene.py`, run in CI) fails on any fixture
without that header, on credential-shaped strings not marked synthetic, and
on a short list of private identifiers from the application whose spike
produced this tool. Full traces never enter the repository.

## Reporting a problem

If you find a way for trace content to reach the default output, or any
network access, please open an issue at
<https://github.com/joshgreenwell/ai-kits/issues> with a synthetic
reproduction — never with a real trace.
