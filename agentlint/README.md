# agentlint — Agent Trace Linter

`agentlint` reads exported agent run traces (OTLP JSON, observation exports,
neutral record bundles) and reports **evidence-backed, tiered findings** about
how a run behaved: no-progress cycles, identical retries after failure,
context growth candidates, oversized and repeated tool results.

## Thesis

Agent runs fail in patterns that are visible in their traces long before they
are visible in their outputs. Those patterns can be detected **locally,
offline and deterministically** from the identifiers and numbers the trace
already contains, without reading the content of prompts or tool results, and
without any model in the loop. A finding is only worth reporting when it
cites the original identifiers it was derived from and states how confident
the detection is:

* `proven` — the pattern is present in the data as a matter of arithmetic.
* `projected` — the data is consistent with the pattern; a candidate, not a cause.
* `unresolved` — the data needed to decide is missing.

A scan whose inputs are incomplete is reported as `incomplete`, never as
"clean". Missing data is named field by field.

## What this tool never does

* Never touches the network: no telemetry, no update checks, no downloads.
* Never keeps persistent state between invocations.
* Never calls an LLM, computes embeddings, or runs a tokenizer.
* Never synthesizes an identifier from another identifier; every finding
  cites original IDs and source locators.
* Never turns an absent value into a zero, an empty string, or an empty
  object — absent stays `null`.
* Never hashes a value shorter than 16 bytes, and never claims two values are
  equal unless both fingerprints are `full` and neither is a placeholder.
* Never sums token counts across different token bases, and never adds an
  aggregate's usage to the usage of its child calls.
* Never judges routing, planning, relevance or semantic correctness.
* Never produces a "run health score".

## Usage

```sh
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
report. Full details: [`docs/cli.md`](docs/cli.md).

Supported loaders (auto-detected by shape, or forced with `--loader`):

| Label | Format |
| -- | -- |
| `otlp-json` | OTLP/JSON envelope, one per file ([docs](docs/loaders/otlp.md)) |
| `otlp-jsonl` | OTLP JSON Lines from the Collector file exporter ([docs](docs/loaders/otlp.md)) |
| `langfuse-observations` | Langfuse v2 observations export as JSON, JSONL or CSV ([docs](docs/loaders/langfuse.md)) |
| `record-bundle` | the published neutral record-bundle schema ([docs](docs/record-bundle.md)) |
| `claude-session-jsonl` | Claude Code session transcripts — **experimental**, only with `--experimental-claude-session` ([docs](docs/loaders/claude-session.md)) |

### Exit codes

| Code | Meaning |
| -- | -- |
| `0` | analysis complete: every input loaded, every run complete, every rule ran fully |
| `2` | incomplete coverage: a run is `incomplete`, a file could not be loaded, or a rule abstained — the report is still printed in full |
| `3` | unparseable input: at least one input yielded no run |
| `1` | usage or configuration error (unknown flag / rule ID / loader, bad `agentlint.toml`, bad rules module) |

**Findings never change the exit code**, and neither do rule errors. Exit `2`
is a feature: `incomplete for rules: [...]` names the data the tool would need.

### Privacy defaults

Trace files are highly sensitive. By default the output contains **no
content**: identifiers, source locators, hashes, counts and sizes only, and
values shorter than 16 bytes are never hashed. `--include-snippets` shows, per
cited evidence item, the raw record it cites — credential patterns redacted
(`sk-…`, `AKIA…`, `Bearer …`, GitHub / Slack tokens, private-key blocks,
password / secret / token fields) and then truncated to 200 characters. The
tool never touches the network, keeps no state, and writes no file except an
explicit `--output` target; the test suite proves this by monkeypatching
socket creation and auditing the lockfile.

Thresholds and loader options come from `agentlint.toml` (`[rules.<RULE_ID>]`
and `[loaders]`, see `docs/cli.md`). App rules load from `--rules-module` or
the `agentlint.rules` entry-point group; see
`examples/rules/grouped_request_scope_loss.py` and `docs/rules/`.

## Development

```sh
cd agentlint
uv sync --extra dev
uv run ruff check .
uv run pytest -q
```

Python 3.11 or newer. No runtime dependencies.
