# agentlint — Agent Trace Linter

Point it at what your agent already recorded — an OpenTelemetry export, a
Langfuse observations export, a Claude Code session log, or your own debug
report — and get one ordered run with explicit coverage, plus deterministic
findings for structural waste.

`agentlint` is a local, offline, deterministic linter for agent run traces.
It never reads the content of prompts or tool results — identifiers, hashes,
counts, sizes and timestamps are enough to see the patterns it reports — and
it never puts a model in the loop.

```sh
uvx agentlint analyze path/to/trace.json
```

## What it answers, and what it does not

**Answers** (from identifiers and numbers, with the evidence cited):

* Was this run's evidence complete enough to lint, and if not, which fields
  are missing? (`incomplete for rules: [...]` names them.)
* Did the agent repeat the same tool call with the same arguments and get
  the same result — a cycle with no progress?
* Did it retry a failed command with identical arguments, and did a model
  call sit between the attempts?
* Did the input token count of comparable model calls jump, and which tool
  results entered the context in between (candidates, not causes)?
* Did a single tool result exceed a size the whole rest of the run pays for?
* Did the same result bytes enter the context several times?

**Does not answer:**

* "Why did the model reason incorrectly?" — that is a semantic question and
  this tool makes no semantic judgments.
* Whether a tool choice, plan, route or retrieved document was *relevant* or
  *correct*.
* Whether the run was "healthy" on some scale. There is no score.

## What this tool never does

* **Never a hosted service, a database, a viewer or an IDE plugin.** It is a
  command that reads files you name and prints a report.
* **Never LLM analysis.** No model call, no embeddings, no tokenizer. The
  findings are arithmetic over the trace.
* **Never semantic judgments.** No routing, planning or relevance rules; no
  opinion on whether a result was correct.
* **Never a reference framework.** It does not tell you how to build an
  agent; it tells you what the one you built did.
* **Never pricing tables or health scores.** Token counts are reported per
  basis and never converted to money or collapsed into a number.
* **Never the network.** No telemetry, no update checks, no downloads; the
  test suite runs every fixture with socket creation monkeypatched to raise.
* **Never persistent state.** Nothing is cached and no file is written
  except an explicit `--output` target.
* Never synthesizes an identifier from another identifier; every finding
  cites original IDs and source locators.
* Never turns an absent value into a zero, an empty string or an empty
  object — absent stays `null`.
* Never hashes a value shorter than 16 bytes, and never claims two values
  are equal unless both fingerprints are `full` and neither is a placeholder.
* Never sums token counts across different token bases, and never adds an
  aggregate's usage to the usage of its child calls.

## Tiers and coverage

Every finding carries a tier and a confidence, and the report begins with
coverage, not findings:

* `proven` — the pattern is present in the data as a matter of arithmetic.
* `projected` — the data is consistent with the pattern; a candidate, not a cause.
* `unresolved` — the data needed to decide is missing.

A scan whose inputs are incomplete is reported as `incomplete`, never as
"clean". Missing data is named field by field, and a rule whose
prerequisites are missing *abstains* rather than guessing.

## Install and use

Python 3.11 or newer. No runtime dependencies.

```sh
uvx agentlint analyze <file|dir>...            # run from a fresh environment
uv tool install agentlint                      # or install the command
pip install agentlint                          # or plain pip

agentlint analyze <file|dir>... [--format text|json|md] [--run <id>] [--rules a,b,c]
                                [--rules-module path] [--config agentlint.toml]
                                [--experimental-claude-session] [--include-snippets]
                                [--loader <label>] [--output <path>]
agentlint rules                 # every generic and loaded app rule: ID, category, tier, requirements, source
agentlint explain <RULE_ID>     # the rule's documentation, rendered from its metadata
agentlint --version
```

`analyze` prints **coverage first**, then findings (one per pattern, evidence
collapsed, thresholds and tier / confidence shown), then run stats (latency
distribution per event kind, token totals per basis). Anything that could not
be loaded is printed before everything else under *incomplete input*, and an
incomplete run is never rendered as clean. `--format json` is the full model,
byte-identical for identical input; `--format md` is a shareable, redacted
report. Full details: [`docs/cli.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/cli.md).

### Supported loaders

Inputs are detected by shape (or forced with `--loader <label>`):

| Label | Format | Version note |
| -- | -- | -- |
| `otlp-json` | OTLP/JSON `resourceSpans` envelope, one per file ([docs](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/loaders/otlp.md)) | GenAI semantic conventions, current *and* legacy `gen_ai.*` attribute names (input/prompt tokens, provider.name/system, …); the pre-1.0 `instrumentationLibrarySpans` key is accepted. |
| `otlp-jsonl` | OTLP JSON Lines from the OpenTelemetry Collector `file` exporter, one envelope per line ([docs](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/loaders/otlp.md)) | Same mapping as `otlp-json`; rotated files merge by run ID. |
| `langfuse-observations` | Langfuse Observations export as JSON, JSONL or CSV ([docs](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/loaders/langfuse.md)) | Targets the v2 Observations API shape (`usageDetails`); the older `promptTokens` / `completionTokens` shape is detected and loaded with a loud coverage note. |
| `record-bundle` | The published neutral record-bundle schema any app can emit from its debug report ([docs](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/record-bundle.md), [schema](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/record-bundle.schema.json)) | `schema_version` `"1"`. |
| `claude-session-jsonl` | Claude Code session transcripts (`~/.claude/projects/**/*.jsonl`) ([docs](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/loaders/claude-session.md)) | **Experimental, off by default**: enable with `--experimental-claude-session`. The format is undocumented upstream; the mapping is modelled on Claude Code 2.1.x logs and unknown record types mark the run `incomplete`. |

### Exit codes

| Code | Meaning |
| -- | -- |
| `0` | analysis complete: every input loaded, every run complete, every rule ran fully |
| `2` | incomplete coverage: a run is `incomplete`, a file could not be loaded, or a rule abstained — the report is still printed in full |
| `3` | unparseable input: at least one input yielded no run |
| `1` | usage or configuration error (unknown flag / rule ID / loader, bad `agentlint.toml`, bad rules module) |

**Findings never change the exit code**, and neither do rule errors. Exit `2`
is a feature: `incomplete for rules: [...]` names the data the tool would need.

### Rules

Five generic rules ship with provisional, visible thresholds; every finding
records the values it used. Documentation is rendered from the rules'
metadata (`agentlint explain <RULE_ID>`, committed under
[`docs/rules/`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/rules/README.md)):

| Rule | Tier | Default thresholds |
| -- | -- | -- |
| `NO_PROGRESS_CYCLE` | proven | `min_calls = 3` |
| `IDENTICAL_RETRY_AFTER_FAILURE` | proven (weak) / projected (strong) | `min_failures = 3`, `min_failures_strong = 2` |
| `CONTEXT_GROWTH` | projected | `min_delta_tokens = 8000`, `min_ratio = 1.5` |
| `OVERSIZED_TOOL_RESULT` | proven | `min_result_bytes = 65536` |
| `REPEATED_TOOL_RESULT` | proven | `min_results = 3`, `min_result_bytes = 8192` |

App-specific rules load from `--rules-module <file>` or the `agentlint.rules`
entry-point group; they read only their own namespace under `Event.scope`.
See `examples/rules/grouped_request_scope_loss.py`.

### `agentlint.toml`

```toml
# Thresholds: one table per rule; unknown keys for a loaded rule are an error, never ignored.
[rules.OVERSIZED_TOOL_RESULT]
min_result_bytes = 32768

[rules.CONTEXT_GROWTH]
min_delta_tokens = 8000
min_ratio = 1.5

# Loader options.
[loaders]
experimental_claude_session = false            # enable the Claude Code session loader
otlp_token_basis = "input_excludes_cache_read" # what the OTLP instrumentation counts
otlp_run_id_attribute = "app.run_id"           # app attribute naming the run
```

Pass it with `--config agentlint.toml`; command-line flags override the file.

## Privacy

Trace files are highly sensitive. By default the output contains **no
content**: identifiers, source locators, hashes, counts and sizes only, and
values shorter than 16 bytes are never hashed. `--include-snippets` shows,
per cited evidence item, at most 200 characters of the raw record it cites,
with credential patterns redacted first. Nothing is sent, fetched, cached or
written. The full statement, including what each loader reads, is in
[`PRIVACY.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/PRIVACY.md).

## Documentation

* [`docs/cli.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/cli.md) — commands, output order, formats, exit codes, configuration.
* [`docs/rules/`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/rules/README.md) — one page per rule, generated from metadata.
* [`docs/loaders/otlp.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/loaders/otlp.md), [`docs/loaders/langfuse.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/loaders/langfuse.md), [`docs/loaders/claude-session.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/loaders/claude-session.md) — what each loader maps, its version note, its coverage vocabulary.
* [`docs/record-bundle.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/docs/record-bundle.md) — the neutral input format and how to map your own debug report to it.
* [`PRIVACY.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/PRIVACY.md) — what leaves the process (nothing) and what stays out of the output.
* [`CHANGELOG.md`](https://github.com/joshgreenwell/ai-kits/blob/main/agentlint/CHANGELOG.md).

## Development

```sh
cd agentlint
uv sync --extra dev
uv run ruff check .
uv run pytest -q                                   # includes the end-to-end negative controls
uv run python scripts/render_rule_docs.py --check  # rule docs match the metadata
uv run python scripts/check_fixture_hygiene.py     # fixture headers, no credentials, no private IDs
```

Fixtures are synthetic and declare `origin`, `ref`, `completeness` and
`excerpt_or_raw`; the end-to-end controls under `tests/e2e/` run every
mandatory negative case (fan-out, same error with different commands, same
result with changed arguments, aggregate-only usage, placeholder arguments,
re-imported events, and a healthy run that exits 0) through the real command
line. Source: <https://github.com/joshgreenwell/ai-kits>. License: BSD 2-Clause.
