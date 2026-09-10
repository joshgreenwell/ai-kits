# The `agentlint` command line

`agentlint` is a local, offline, deterministic linter for agent run traces.
It reads exported trace files, prints **coverage first**, then findings, then
run statistics, and exits with a code that describes how complete the
analysis was — never how "bad" the run looked.

```
agentlint analyze <file|dir>... [--format text|json|md] [--run <id>] [--rules a,b,c]
                                [--rules-module path]... [--config agentlint.toml]
                                [--experimental-claude-session] [--include-snippets]
                                [--loader <label>] [--output <path>]
agentlint rules   [--format text|json] [--rules-module path]...
agentlint explain <RULE_ID> [--rules-module path]...
agentlint --version
```

Everything happens in one process on the files you name. There is no
`doctor` subcommand: coverage is part of `analyze`.

## `analyze`

### Inputs and loaders

Each argument is a file or a directory. A directory contributes the regular
files directly inside it (subdirectories are listed as skipped; pass them
explicitly). Every file is sniffed against the registered loaders in this
order and the first one that accepts it loads it:

| Label | Format | Notes |
| -- | -- | -- |
| `otlp-json` | OTLP/JSON envelope (`resourceSpans`), one per file | `docs/loaders/otlp.md` |
| `otlp-jsonl` | OTLP JSON Lines (Collector file exporter), one envelope per line | `docs/loaders/otlp.md` |
| `langfuse-observations` | Langfuse v2 observations export: JSON, JSONL or CSV | `docs/loaders/langfuse.md` |
| `record-bundle` | The published neutral record-bundle schema | `docs/record-bundle.md` |
| `claude-session-jsonl` | Claude Code session transcripts (**experimental**, off by default) | `docs/loaders/claude-session.md` |

`--loader <label>` forces one loader for every input instead of detecting by
shape. Files of one loader are handed to it together, so a run split across
files (pages, rotated exporter files) still merges by run ID.

The `claude-session-jsonl` loader runs only with `--experimental-claude-session`
(or `[loaders] experimental_claude_session = true` in the config file).
Without it, a session file is reported under *incomplete input* with the
flag named, and the loader is never invoked.

Every file's outcome is recorded in the **input manifest** (`inputs` in JSON,
the `Inputs:` block in text): its loader, its status (`loaded`, `unloadable`,
`experimental_disabled`, `missing`, `skipped`) and the IDs of the runs it
produced. Anything that could not be loaded is also listed under
**`incomplete`**, which every renderer prints first.

### Output order

All three formats render the same document, in the same order:

1. **Incomplete input** — files no loader recognised, loader errors, missing
   paths, gated experimental files. Printed first, prominently, whenever it
   is non-empty.
2. **Inputs** — the manifest.
3. Per run:
   1. **Coverage** — `complete` or `INCOMPLETE` with the loader's reasons and
      truncation notes; `events_total` and `events_dropped_dedup`; per-field
      coverage grouped as `present` / `partial` / `absent`; loader coverage
      notes; and, when any rule could not run fully, the summary line
      `incomplete for rules: [A, B]` followed by each abstention note naming
      the missing fields or the events the rule made no claim about.
   2. **Findings** — one entry per collapsed pattern, showing rule ID, tier
      and confidence, the observed pattern, impact, the *thresholds the rule
      used*, the evidence (first three citations, `event_id @ source_locator
      field=value`, then `... +N more`), limitations and the fingerprint. A
      run without findings reads `none (coverage complete)` when everything
      was covered and `none reported (coverage INCOMPLETE — this is not a
      clean result)` otherwise. The word "clean" is never used affirmatively.
   3. **Rule errors** — rules that raised or produced unusable evidence
      (reported, never findings, never an exit-code change).
   4. **Stats** — event counts per kind and status, run span, the latency
      distribution per kind (`min / p50 / p90 / max` in ms over measured
      durations, with the slowest event's ID; nearest-rank percentiles, so
      each value is a real event's duration) and token totals **per basis**
      (never summed across bases, aggregates flagged, calls without a basis
      counted separately). A kind with no measurable duration shows `-`
      (`null` in JSON), never `0`.
4. **Summary** — runs analysed, findings, coverage state and the exit code
   with its meaning.

### Formats

* `--format text` (default): the terminal rendering above.
* `--format json`: the full analysis document — byte-deterministic (sorted
  keys, two-space indent, fixed separators, UTF-8, trailing newline). Identical
  input produces identical bytes. Shape:

  ```
  {
    "agentlint_version": "...",
    "options": { ... what was asked ... },
    "inputs": [ {"path", "kind", "files": [ {"path", "loader", "status", "reason", "run_ids"} ]} ],
    "incomplete": [ {"path", "reason", "loader", "locator"} ],
    "runs": [
      {
        "run": { id, conversation_id, source_format, source_refs, started_at, ended_at,
                 events: [...], raw_records_retained: n },
        "coverage": { fields, events_total, events_dropped_dedup, truncated, truncation_notes,
                      completeness, reasons, notes },
        "findings": [...], "abstentions": [...], "errors": [...],
        "incomplete_for_rules": [...], "rules_run": [...], "summary": "incomplete for rules: [...]" | null,
        "thresholds": { RULE_ID: {...} },
        "stats": { events_total, events_dropped_dedup, by_kind, by_status, errors, latency, tokens_by_basis,
                   calls_without_token_basis, span_ms },
        "exclusions": { config, excluded: {event_id: reason}, series: [...] },
        "snippets": { "<event_id>@<source_locator>": "..." }   // only with --include-snippets
      }
    ],
    "summary": { runs, runs_loaded, findings, incomplete, incomplete_inputs, inputs_without_runs,
                 unknown_run_id, exit_code, exit_meaning }
  }
  ```

  `raw_records` are never included — only their count. Absent values are
  `null`, never `0` or `""`.
* `--format md`: a shareable Markdown report with the same order and content
  (tables for the manifest, findings and latency).

`--output <path>` writes the report to that file instead of stdout. It is the
only file the command ever writes.

### Selecting runs and rules

* `--run <id>` analyses one run of a multi-run input. An ID that matches no
  loaded run prints the loaded IDs and exits 3.
* `--rules A,B,C` restricts the rule set; an unknown ID is a usage error
  listing the valid IDs.
* `--rules-module <path>` (repeatable) loads app rules from a Python file that
  exposes a `RULES` list or a `META` / `run` pair. Rules registered under the
  `agentlint.rules` entry-point group load automatically.

## `agentlint.toml`

```toml
# Thresholds: one table per rule, keys are the rule's threshold names.
# Unknown keys for a loaded rule are a usage error, never ignored.
[rules.OVERSIZED_TOOL_RESULT]
min_result_bytes = 32768

[rules.CONTEXT_GROWTH]
min_delta_tokens = 8000
min_ratio = 1.5

# Loader options.
[loaders]
experimental_claude_session = false   # enable the Claude Code session loader
otlp_token_basis = "input_excludes_cache_read"   # what the OTLP instrumentation counts
otlp_run_id_attribute = "app.run_id"  # app attribute naming the run
loader = "otlp-json"                  # force one loader (same as --loader)
```

Command-line flags override the file. Threshold names and defaults are shown
by `agentlint explain <RULE_ID>` and recorded on every finding.

## `rules` and `explain`

`agentlint rules` lists every generic rule and every loaded app rule with its
ID, category, tier, confidence, requirements and source (`builtin`,
`module:<path>` or `entry-point:<name>`); `--format json` emits the full
metadata. `agentlint explain <RULE_ID>` renders the rule's documentation
(Problem, Detection, Prerequisites, Evidence, Exclusions, Thresholds,
Limitations, Remediation, Tier / Confidence, Fixtures) from its metadata —
the same text as `docs/rules/<RULE_ID>.md`. An unknown ID exits 1 and lists
the valid IDs.

## Exit codes

| Code | Meaning |
| -- | -- |
| `0` | Analysis complete: every input loaded, every run `complete`, every rule ran fully. |
| `2` | Analysis ran with **incomplete coverage**: a run is `incomplete`, a file could not be loaded, or a rule abstained / ran partially. The report is still printed in full. |
| `3` | Unparseable input: at least one input yielded no run (or `--run` named a run that does not exist). |
| `1` | Usage or configuration error: unknown flag, rule ID or loader label, unreadable or invalid `agentlint.toml`, a rules module that fails to load. |

**Findings never change the exit code.** Neither do rule errors (a rule that
raised): they are printed under *Rule errors* and the code reflects coverage
only. Exit `2` is deliberately common — abstention (`incomplete for rules:
[...]`) is a feature: the tool is telling you which data it would need.

## Privacy defaults

Trace files are highly sensitive. The defaults are:

* **No content in the output.** Findings cite identifiers, source locators,
  hashes (excerpted), counts and sizes. `raw_records` never leave the process.
* **Minimum hash input of 16 bytes.** Values shorter than that are never
  fingerprinted (`null` instead), so a hash can never be reversed by guessing.
* **`--include-snippets` is explicit.** With it, each cited evidence item may
  carry a *snippet*: the canonical JSON of the raw record the evidence cites
  (an OTLP span, a record-bundle record's `raw` value, or the record itself)
  — **redacted first, then cut to 200 characters**. Redaction replaces API
  keys (`sk-…`), AWS access keys (`AKIA…` / `ASIA…`), `Bearer` tokens, GitHub
  (`ghp_…`, `github_pat_…`) and Slack (`xox…`) tokens, PEM private-key blocks
  and the values of `password` / `secret` / `token` / `api_key` /
  `access_key` / `authorization` / `credential`-style fields with labelled
  `[REDACTED:…]` markers, in every format. Snippets come only from
  `raw_records`; nothing is fetched or inferred.
* **Zero network, no state.** Nothing is sent, fetched or checked; nothing is
  cached; no file is written unless you pass `--output`. The test suite runs
  every fixture with socket creation monkeypatched to raise, and audits the
  lockfile for HTTP clients, SDKs and data-science packages.
