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

## Status

Version `0.0.1` contains the core in-memory model and normalization helpers
(`agentlint.model`, `agentlint.dedup`, `agentlint.fingerprint`,
`agentlint.tokens`). Loaders, rules and the command-line interface arrive in
later stories; `agentlint` on the command line currently exits with status 1
and a "not implemented yet" message.

## Development

```sh
cd agentlint
uv sync --extra dev
uv run ruff check .
uv run pytest -q
```

Python 3.11 or newer. No runtime dependencies.
