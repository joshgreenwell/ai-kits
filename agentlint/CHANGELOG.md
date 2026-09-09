# Changelog

All notable changes to `agentlint` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Releases are tagged
`agentlint-v<version>` in the monorepo.

## [0.0.1] — unreleased

First public V0: a local, offline, deterministic linter for agent run traces.

### Loaders

| Label | Input | Notes |
| -- | -- | -- |
| `otlp-json` | OTLP/JSON `resourceSpans` envelope, one per file | current and legacy `gen_ai.*` attribute names; exact int64 and hex-ID preservation; run ID from an app attribute, `gen_ai.conversation.id` or the trace ID (flagged) |
| `otlp-jsonl` | OpenTelemetry Collector `file` exporter, one envelope per line | multi-file / rotated-file merge by run ID; bad lines become truncation notes |
| `langfuse-observations` | Langfuse v2 Observations export as JSON, JSONL or CSV | `usageDetails` → token counts with a derived token basis; older shape detected with a loud note; io content hashed, never copied |
| `record-bundle` | the published neutral schema (`docs/record-bundle.schema.json`, `schema_version` `"1"`) | validated with a hand-written draft 2020-12 subset; invalid records dropped with JSON-pointer locators |
| `claude-session-jsonl` | Claude Code session transcripts | **experimental**, off by default: enable with `--experimental-claude-session` or `[loaders] experimental_claude_session = true`; modelled on Claude Code 2.1.x logs |

### Rules and default thresholds

| Rule | Tier / confidence | Thresholds |
| -- | -- | -- |
| `NO_PROGRESS_CYCLE` | proven / medium | `min_calls = 3` |
| `IDENTICAL_RETRY_AFTER_FAILURE` | proven (weak) or projected (strong) / medium | `min_failures = 3`, `min_failures_strong = 2` |
| `CONTEXT_GROWTH` | projected / medium | `min_delta_tokens = 8000`, `min_ratio = 1.5` |
| `OVERSIZED_TOOL_RESULT` | proven / high | `min_result_bytes = 65536` |
| `REPEATED_TOOL_RESULT` | proven / medium | `min_results = 3`, `min_result_bytes = 8192` |

Thresholds are provisional, visible on every finding, and overridable from
`agentlint.toml` (`[rules.<RULE_ID>]`); unknown keys are errors. Rules
abstain with a coverage note naming the missing field when their
prerequisites are not met (`incomplete for rules: [...]`). App rules load
from `--rules-module` or the `agentlint.rules` entry-point group.

### Command line

`agentlint analyze <file|dir>...` (text, JSON, Markdown; coverage first,
then findings, then stats), `agentlint rules`, `agentlint explain <RULE_ID>`,
`agentlint --version`.

Exit codes: `0` analysis complete; `2` incomplete coverage (a run is
incomplete, a file could not be loaded, or a rule abstained — the report is
still printed); `3` unparseable input; `1` usage or configuration error.
Findings never change the exit code.

### Privacy

No network, no telemetry, no persistent state, no runtime dependencies.
Output carries identifiers, hashes, counts and sizes only; values shorter
than 16 bytes are never hashed; `--include-snippets` redacts credential
patterns before truncating to 200 characters. See `PRIVACY.md`.

### Testing

599 unit tests plus the end-to-end negative-control suite (`tests/e2e/`):
fan-out of identical calls, same error with different commands, same result
with changed arguments, aggregate-only usage, placeholder arguments,
re-imported events, a healthy run that exits 0, one positive per rule, and
one control per loader (dual `gen_ai` names, missing usage, malformed
records, multi-page merge, hex-ID and large-integer preservation). Fixture
hygiene and a no-network wheel smoke test run in CI.

[0.0.1]: https://github.com/joshgreenwell/ai-kits/releases/tag/agentlint-v0.0.1
