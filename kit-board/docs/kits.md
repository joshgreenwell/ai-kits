# Observatory kits

Decided September 30, 2026. The Observatory is one board fed by five kits: AI usage, daily tasks, readings, audit, and PR watch. This page records the boundary between them, who owns each contract, and where every file lives today. The signed-in `/kits` page renders the same contracts and endpoints for producers.

## The rule

Some of the pieces named here arrive in later phases. The [extraction order](#extraction-order) table says which ones exist yet.

- **The board** (`kit-board/`) owns sign-in, the navigation shell, every ingestion API, storage and migrations, the views, and every wire contract it accepts.
- **A kit** (`kit-<name>/` at the repository root) is everything that runs outside the board to feed it: a collector, a runner, or an agent-schedule template. It also carries a copy of its contract, synthetic fixtures, tests, a README, and its own CI workflow.
- **Kits copy; they never import.** A kit keeps a byte-identical copy of each board-generated file it depends on in `kit-<name>/contract/`, under the same file name as the board's `lib/generated/contracts/` original. `.github/workflows/contracts.yml` is the only job that reads both sides, and it fails when a copy drifts. The companion's copy of `usage-v2.schema.json` predates this layout and is still checked by `companion.yml`.
- **Kit manifests are the board's registry.** `lib/kits/` lists each kit's pages, report kinds, producer scopes, schedules, endpoints, contracts, and downloads. Navigation, the `/kits` page, and `ProducerKind` derive from it. `proxy.ts` stays a hand-written allowlist, and `tests/kit-manifests.test.ts` fails when the two disagree.
- **The envelope is shared; payloads are per kind.** `lib/contracts.ts` defines the report envelope every kind posts. `lib/report-contracts.ts` defines each kind's payload and generates one JSON Schema per kind covering the whole request body (`npm run contracts`).
- **Payload contracts start in observe mode.** The producers are scheduled agents, and their output drifts. Ingestion still accepts any envelope-valid report, returns the contract result in its receipt, and the `/kits` page shows how many recent revisions match. A kind is switched to `enforce`, which answers 422, only once its recent uploads match cleanly. The switch is `enforcement` in the kind's manifest entry.

## Ownership

| Area | Kit directory | Kit owns | Board keeps |
|---|---|---|---|
| AI usage | `kit-usage/` (not yet extracted) | companion, browser quota bridge, `scripts/telemetry/`, collector-side fixtures, machine-side docs | `lib/usage-contract.ts`, usage/telemetry/allowance/reset-feed libraries, `/api/v1/usage`, `/api/v1/companion/*`, `/api/reports`, `/usage`, `/settings/*` |
| Daily tasks | `kit-daily-tasks/` | schedule template, fixtures, contract copies (`tasks-v1`, `standup-v1`) | `lib/daily-tasks.ts`, `lib/daily-briefing.ts`, `/tasks` |
| Readings | `kit-readings/` | `render-readings.mjs`, schedule template, fixtures, contract copy (`readings-v1`) | `lib/readings.ts`, the readings view |
| Audit | `kit-audit/` (not yet extracted) | `publish-assets.mjs`, fixtures, contract copy (`audit-v1`) | `lib/artifact*`, `lib/assets*`, `lib/report-selection.ts`, `/audit` |
| PR watch | `kit-pr-watch/` | runner, decision core, decision tests, contract copies | `lib/pr-watch-contract.ts`, `lib/pr-watch-store.ts`, both route sets, `/reviews` |
| Board core | — | — | auth, `proxy.ts`, `lib/db.ts`, the envelope, `scripts/publish.mjs`, migrations |

Agent routing (`/api/v1/agent-events`, `/api/v1/quota-state`) is a board API with no kit. Its contract is canonical in the workspace repository and copied into `lib/routing-contract/`.

`scripts/publish.mjs` stays in the board. It is the reference client for the board's envelope, and the scheduled agents call it by path.

## Contracts

`npm run contracts` writes `lib/generated/contracts/`, and `prebuild` runs it too. For each contract it writes `<id>.schema.json`, the JSON Schema of the whole request body, and `<id>.example.json`, a synthetic body that passes it. It also writes `validate.mjs`, a copy of `lib/contract-validator.mjs`. CI fails when the committed files differ from a fresh run.

| Contract | Kind | Mode |
|---|---|---|
| `report-envelope-v1` | every `/api/v1/reports/:kind` body | enforced; ingestion refuses a bad envelope with 400 |
| `tasks-v1` | `tasks` | observe |
| `standup-v1` | `standup` | observe |
| `readings-v1` | `readings` | observe |
| `audit-v1` | `audit` | observe |
| `usage-v2` | the companion upload, `lib/generated/usage-v2.schema.json` | enforced |

The PR watch contracts are added with `kit-pr-watch/` in phase 4.

`validate.mjs` has no dependencies. It checks a report against a schema on any machine with Node:

```bash
node lib/generated/contracts/validate.mjs lib/generated/contracts/tasks-v1.schema.json report.json
```

It exits 1 when the report does not match. It also refuses a schema that uses a keyword it does not check, so a schema it only partly understands can never pass a report. The generator emits nothing that the zod source checks and the schema cannot express, except the envelope's two date checks: `produced_at` may not be in the future, and `period_key` must be a real calendar date.

Each ingestion receipt carries `contract: { id, enforcement, valid, issues }`, with at most 20 issues. `scripts/publish.mjs` prints it, and writes a warning to stderr when a stored report does not match.

`POST /api/v1/reports/:kind/validate` answers what ingestion would decide about a body and stores nothing: `{ kind, accepted, envelope: { valid, issues }, contract }`. It takes the kind's producer key when an `Authorization` header is sent, and otherwise a signed-in, same-origin browser session; either way it authenticates before it reads the body. `scripts/publish.mjs --dry-run` calls it when the config holds a credential, and `--offline` keeps the check local.

## The kits pages

`/kits` lists every kit with its contracts, how many of the last 20 revisions of each kind match the current contract, and the board's own endpoints. `/kits/<id>` documents one kit:

- **Contracts.** Each contract's mode, the recent-revision match with its most common issues (array indexes folded, each counted once per revision), a field table derived from the generated JSON Schema by `lib/contract-fields.ts`, the example body, and a form that posts a pasted body to the validate endpoint.
- **Endpoints, schedules and collectors.** The manifest's endpoints and schedules; the AI usage kit also shows each collection source and reset feed, the table that used to sit on `/schedules`.
- **Downloads.** Links to the repository on GitHub, pinned to the commit the deployment was built from (`VERCEL_GIT_COMMIT_SHA`, or `main` outside Vercel), with a raw link for single files. The repository is public, so there is no download route; schemas and examples come from `lib/generated/contracts/` at that commit.

`/schedules` redirects to `/kits`. The match counts read stored revisions and show only field paths and contract messages, never field values.

## Extraction order

| Phase | Work | Status |
|---|---|---|
| 0 | This page and the layout rules in `CONTRIBUTING.md` | Done |
| 1 | Kit manifests, payload contracts, generated schemas, observe-mode validation | Done |
| 2 | The `/kits` documentation pages and the validate endpoint | Done |
| 3 | `kit-daily-tasks/` and `kit-readings/` | Pending |
| 4 | `kit-pr-watch/` | Pending |
| 5 | `kit-audit/`, then a structured `audit-v2` payload | Not started |
| 6 | `kit-usage/`, last: companion, browser bridge, telemetry scripts, release configuration | Not started |

Before phase 6, confirm on each machine that no unpacked browser extension loads from `kit-board/browser/`, that no v1 LaunchAgent or Windows task points at `kit-board/scripts/telemetry/`, and that no machine builds the companion from this checkout.

## Outside the repository

Moving kit files does not change the scheduled agents that produce reports: Codex `daily-personal-assistant`, `weekly-luumen-ai-audit` and `monthly-ai-usage`, and the Claude Desktop `daily-tech-intel-snapshot`. Their prompts and schedules live in those apps. Each kit's `schedule/` template records what the board needs from the schedule. It is documentation, not the schedule's source of truth.
