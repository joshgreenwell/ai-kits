# AI Kits

Two independent, open-source engineering tools for teams running LLM agents.
They live in one repository for convenience but share **no code, runtime, or data model**.

| Kit | Directory | Runtime | What it does |
| -- | -- | -- | -- |
| 1 — Agent Trace Linter | [`agentlint/`](agentlint/) | Python 3.11+, `uvx agentlint` | Joins an agent run's evidence from whatever the app already recorded into one ordered, coverage-annotated timeline, and runs small deterministic rules over it. |
| 2 — Agent Control-Surface Diff | [`agent-surface/`](agent-surface/) | Node 20+, `npx agent-surface` | Tells reviewers when a repository change expands the control surface granted to Claude Code before it reaches developer machines. |

## Shared principles (both kits)

* **Local, offline, deterministic.** No network, telemetry, update checks, persistent state, LLM, embeddings, or tokenizer.
* **Evidence-backed.** Every finding cites original identifiers. Never synthesize an ID from another ID.
* **Tiered claims.** `proven` / `projected` / `unresolved`. `incomplete` is a scan state that is never rendered as "clean".
* **Coverage first.** Missing data produces `incomplete` with the missing fields named. Absent values never become zero or empty.
* **Redaction by default.** Never hash values shorter than 16 bytes.

Each kit has its own README, tests, and release process inside its directory.

## Adding a kit to your project

Both kits are pre-release: install them from a checkout of this repository, not
from PyPI or npm.

* **Kit 1** — [`agentlint/docs/integration.md`](agentlint/docs/integration.md):
  choosing an input, installing from a local checkout, emitting a record bundle
  from your own debug report, adding an app-specific rule, and running it in CI.
* **Kit 2** — [`agent-surface/docs/integration.md`](agent-surface/docs/integration.md):
  running from a local checkout, reading the verdict, choosing a failure policy,
  and wiring the check into pull-request CI.

## License

BSD 2-Clause. See [LICENSE](LICENSE).
