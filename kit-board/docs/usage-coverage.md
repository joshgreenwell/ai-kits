# Usage coverage

Living document. Updated September 12, 2026.

This page says, per provider and surface, which usage facts the Observatory records, which it cannot, and which process produces each fact. Setup steps live in [usage collection](usage-collection.md), the operating map in [agent handoff](agent-handoff.md), and the wire contract in `lib/usage-contract.ts`. Update this page whenever a collector, a setting, or a provider capability changes: change the matrix cell, then the process section it points to, then the date above.

Legend for the tables:

- **Yes**: collected today when the listed process is enabled.
- **Hashed**: collected as a hash under an opt-in setting; the source value never leaves the machine.
- **Partial**: some sessions or some fields only; the process section says which.
- **Planned**: a data path exists and is designed, but not built.
- **No**: the provider exposes no data path we can use.
- **n/a**: the fact does not apply to that row.

## Table 1. Facts by provider and surface

| Provider and surface | Runs where | Tokens per request | Hourly buckets | Allowance percent | Money | Project | Surface | Process |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code in a terminal | this machine | Yes | Yes | Yes (Pro or Max, after the first response of a session) | No (plan usage has no price) | Hashed | Yes, `cli` | P1, P2, P3 |
| Claude Code desktop app, Local environment | this machine | Yes | Yes | Yes | No | Hashed | Yes, `desktop` | P1, P2, P3 |
| Claude Code VS Code extension | this machine | Yes | Yes | Yes | No | Hashed | Yes, `ide` | P1, P2, P3 |
| Claude Code cloud sessions (web, desktop Cloud environment, mobile, routines) | Anthropic VM | Planned | Planned | Account meter only, unattributed | No | Planned | Planned, `cloud` | P5 |
| Claude Code cloud session after `--teleport` | local copy | Partial | Partial | n/a | No | Hashed | Yes, but as `cli` | P1 |
| Claude.ai chat in a browser | Anthropic | No | No | Yes, quota only | No | No | n/a | P7 |
| Codex CLI | this machine | Yes | Yes | Yes, embedded and app-server | No (plan) | Hashed | Yes, `cli` | P1, P2, P4 |
| Codex desktop app | this machine | Yes | Yes | Yes | No | Hashed | Yes, `desktop` | P1, P2, P4 |
| Codex IDE extension | this machine | Yes | Yes | Yes | No | Hashed | Yes, `ide` | P1, P2, P4 |
| Codex cloud tasks | OpenAI | No | No | Account meter only, unattributed | No | No | No | P6 |
| ChatGPT web | OpenAI | No | No | Planned, quota only | No | No | n/a | P7 |
| Cursor IDE | this machine plus Cursor's servers | Planned, from hosted usage events | Planned | Planned | Planned | No | Planned | P9 |
| Anthropic API, a Console organization | Anthropic | Planned, as buckets | Planned | n/a | Planned | Workspace and API key only | n/a | P8 |
| OpenAI API, a Platform organization | OpenAI | Planned, as buckets | Planned | n/a | Planned | OpenAI project, user, API key only | n/a | P8 |

The Claude and Codex desktop apps write the same local transcript stores as their command-line tools, so the Local environment of either desktop app is fully covered. A cloud session started from the desktop app is a cloud session and follows the cloud row.

## Table 2. Groupings by source

| Grouping | Claude local transcript | Codex local rollout | Claude cloud session | Codex cloud task | Cursor | Anthropic Admin API | OpenAI Admin API | Envelope v2 field | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Project, as a working directory | `cwd` on every line | `session_meta.cwd`, then each `turn_context.cwd` | hook input `cwd`, OTel repository attributes | none | workspace folder, local only | none | none | `activity.request.project_hash` | Hashed today, P2 |
| Git repository | derivable from `cwd` at collection time | `session_meta.git.repository_url`, rarely present | OTel `vcs.repository.*` | none | none | none | none | none | Planned, P2 |
| Git branch | `gitBranch` | `session_meta.git.branch`, rarely present | OTel on commits | none | none | none | none | none | Not planned; needs a contract field |
| Surface or entrypoint | `entrypoint` | `originator`, `source` | fixed `cloud` | Enterprise analytics only | n/a | n/a | n/a | `activity.request.surface` | Yes today, P1 |
| Session | `sessionId` | `session_meta.id` | session id | thread id | `conversationId`, hosted | n/a | n/a | `session_hash` | Yes today, P1 |
| Subagent versus main session | `subagents/` directory, `isSidechain` | n/a | n/a | n/a | n/a | n/a | n/a | `parent_session_hash` | Yes today, P1 |
| Model | `message.model` | `turn_context.model` | OTel `model` | analytics | usage events | `group_by[]=model` | `group_by[]=model` | `model_actual` | Yes today, P1 |
| Effort, speed, service tier | `effort`, `usage.speed`, `usage.service_tier` | n/a | OTel `speed`, `effort` | n/a | `maxMode` | `service_tier`, `speed` | `service_tier` | none | Not planned |
| Session title | `customTitle` | n/a | n/a | n/a | n/a | n/a | n/a | none | Never uploaded; free text |
| Task category | heuristic from tool use and prompt words | heuristic | n/a | n/a | n/a | n/a | n/a | `tools`, hashed names | Monthly report only, P10 |
| Workspace, OpenAI project, API key, user | n/a | n/a | n/a | n/a | n/a | `workspace_id`, `api_key_id` | `project_id`, `user_id`, `api_key_id` | `account.usage_bucket.dimensions` | Planned, P8 |

"Project" means different things per column. In the local transcripts it is the working directory. In the OpenAI Admin API it is an organization-level grouping of API keys. The two never join.

## Table 3. Allowance meters

| Meter | Reader | Per account | Per project | Process |
| --- | --- | --- | --- | --- |
| Claude five-hour and seven-day windows, Pro or Max | statusline JSON; OAuth usage endpoint | Yes | Planned: each statusline sample carries `workspace.project_dir` beside `rate_limits`, so the change between two samples can be attributed to the one project active in between | P3 |
| Claude spend limit behind an apps gateway | statusline | n/a for personal accounts | n/a | P3 |
| Codex five-hour and weekly windows | `rate_limits` embedded in each `token_count`; app-server | Yes | Planned by the same delta method; the rollout carries `cwd` | P4 |
| Codex cloud tasks | none locally | shared with the meters above | No | P6 |
| Cursor plan usage | hosted usage summary | Planned | No | P9 |
| Claude.ai and ChatGPT in a browser | browser extension | Yes for Claude, planned for ChatGPT | No | P7 |

Every provider meters per account. Nothing per project comes from a provider; the per-project rows are derived locally and stay in percentage points. They are never converted to tokens and never summed across windows.

## Processes

### P1. Local transcript scan

The companion's `claude_execution` and `codex_execution` adapters walk the transcript roots (`~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`, or configured roots), resume each file from a checkpoint of size, modification time, file identity, and byte offset, parse only lines that can carry usage, and save one event per provider message keyed by the v1 digest. Hourly buckets are derived from events by session, hour, and model exactly as `collect.py` did, which the parity corpus enforces. At `detail_level` `requests`, every retained event is also emitted as an `activity.request` record.

Nuances:

- `since` pins the backfill start when the state database is created; older files are never read.
- A message that appears in two files, for example a mirrored project directory, is counted once with the larger of each token component.
- Subagent transcripts under `<session>/subagents/` are counted under their parent when `include_subagents` is on, which is the default and matches v1.
- Only assistant lines with a `usage` object count; a `<synthetic>` model is skipped.
- Anthropic documents the transcript format as internal and version-unstable. The parity corpus and golden snapshots catch drift in CI; in production, a shape change shows up as malformed lines in coverage, never as silent zeros.
- Desktop-app sessions sit in the same store as terminal sessions and are told apart by surface (see P2). The Cowork transcripts of the Claude desktop app are not in this store and are not coding usage.
- A cloud session pulled down with `claude --teleport` becomes a local transcript whose assistant lines carry usage, so the scan counts the cloud work as local from the moment of the teleport. There is no marker, so it is counted, but under the wrong surface and in the hour of the teleport rather than of the work.
- Codex rollouts record `cwd` in `session_meta` and again in each `turn_context`; a rollout without `session_meta` (archived, older versions) has no working directory and stays unattributed.

### P2. Hashed project attribution and surface

Setting: `execution.project_attribution` in Usage → Settings, `off` by default, `hashed` to enable. The companion always records, in its local `projects` table, the working directory and its hash; the setting decides only whether the hash is uploaded.

- The key is `sha256(["project", cwd])` in the repository's stable JSON form, where `cwd` has trailing separators trimmed and is bounded to 400 characters. The same directory produces the same key from Claude and Codex, so one project groups across providers on one machine. Two machines produce different keys for the same repository because their paths differ; a label on the Observatory is what joins them.
- The hash is unsalted. A guessed path can be confirmed by hashing it, which is acceptable for a private server and is the price of a key that is stable across installs. The path itself is never uploaded.
- `observatory projects` prints, per binding, every hash with its path and first and last sighting. It is the only place hash and path appear together, and it runs on the machine.
- Turning the setting on later works retroactively: at `requests` detail the adapter re-emits every retained event, the record's content hash changes, and the server stores a revision; canonical rows are chosen at read time.
- Events saved by a companion build older than state schema 2 have no working directory, and file checkpoints stop those files from being re-read. Only development state databases predate schema 2; a fresh state database backfills from `since` with attribution.
- `surface` is always uploaded because it was already in the contract. Claude Code's per-line `entrypoint` maps `cli` → `cli`, `claude-desktop` → `desktop`, `claude-vscode` → `ide`, `sdk-*` → `sdk`, anything newer → `unknown`; a line without the field counts as `cli`. Codex's `session_meta.originator` decides first (`codex_cli_rs` and `codex_exec` → `cli`, anything containing `desktop` → `desktop`, a VS Code or JetBrains originator → `ide`), then `source`. On this machine every Claude event so far came from the desktop app and every Codex event from Codex Desktop.
- Server side: `activity_requests.project_hash` is a column in the pending unified-usage migration and the store writes it. There is no label table, no API to set labels, and no by-project view yet. That is the next step: a `project_labels` table keyed by hash, an authenticated route to name a hash, and a group-by in the usage dashboard.
- Git branch and repository URL are available locally (Claude writes `gitBranch`; Codex sometimes writes `git.branch` and `git.repository_url`) but have no contract field. Adding one means a schema regeneration, a vendored schema update, a migration column, and fixture changes, so it is deliberately not done here.

### P3. Claude statusline inbox

`observatory statusline` reads the JSON Claude Code passes to the statusline command and appends the `rate_limits` windows to a local inbox; the next run turns them into `allowance.reading` records with reader `statusline` and meter keys `five_hour` and `seven_day`.

- The windows appear only for Pro and Max sign-ins, and only after the first API response of a session.
- The inbox is machine-wide and is attributed to the install's first Claude binding.
- The receiver deliberately keeps no `cwd`, session id, transcript path, or prompt today.
- Planned: when project attribution is `hashed`, keep `sha256(["project", workspace.project_dir])` on each sample and, at read time only, attribute the change between two consecutive samples to a project when exactly one project was active in between. Samples with more than one active project, a reset between them, or a gap longer than the window stay unattributed. This needs a nullable `project_hash` on `allowance.reading` in the contract, so it is a contract change with schema regeneration, migration, and fixtures.

### P4. Codex embedded rate limits and app-server

Each Codex `token_count` event embeds the account's `rate_limits` (`primary` and `secondary` windows with `used_percent`, `resets_at`, `window_minutes`); the scan keeps the freshest reading per window per UTC hour and emits it with reader `embedded` and meter key `<limit_id>:<minutes>`. The `app_server` reader asks the Codex CLI's own login for the same numbers.

- The rollout that carries the reading also carries `cwd`, so the per-project delta method of P3 applies once the contract field exists.
- Local turns and cloud tasks draw from the same five-hour bucket. A meter that drops with no local activity is cloud or another-device usage; the Observatory reports it as unattributed account usage and never allocates it.

### P5. Claude Code cloud sessions

Sessions started on claude.ai/code, from the desktop app's Cloud environment, from the mobile app, or by routines run in Anthropic-managed VMs. They leave no local transcript, share the account's rate limits, and have no separate compute charge. Three paths exist; none is built.

1. **Teleport.** `claude --teleport <session>` copies the conversation into a local transcript, after which P1 counts it (see the teleport nuance there). Manual, after the fact, and mis-surfaced.
2. **Repository hooks.** Claude Code fires the same hooks in cloud sessions, taken from the repository's `.claude/settings.json` or server-managed settings, and every hook receives `cwd`, `session_id`, and `transcript_path`. A `SessionEnd` or `Stop` hook could read the VM's transcript, count usage the way P1 does, and post an envelope to `/api/v1/usage` with surface `cloud` and `execution_host` `cloud`. It needs a binding key inside the cloud environment as an environment variable and network access to the Observatory host, so it depends on the environment's network setting. Hook payloads carry no token counts themselves.
3. **OpenTelemetry.** The cloud environment's variables can enable Claude Code's OTel export. `claude_code.api_request` events carry model, tokens, cost, and session id; `OTEL_METRICS_INCLUDE_REPOSITORY=true` adds the repository name and owner; `OTEL_RESOURCE_ATTRIBUTES` adds free tags such as a project name. The Observatory would need an OTLP over HTTP receiver with its own authentication. The same variables work for local sessions as a second signal.

Not usable: the Compliance API is Enterprise only, excludes Claude Code on the web, and carries no token counts; the Claude Code Analytics API needs an organization Admin key, reports per user per day, and has no project dimension; individual accounts cannot use either.

### P6. Codex cloud tasks

No local rollout is written. Individual ChatGPT plan users see plan usage in settings or with `/status`; Business, Enterprise, and Edu workspaces get an analytics dashboard and API per user and per surface, not per repository. `codex cloud` applies a task's diff locally without a transcript. Cloud tasks draw from the same five-hour bucket as local turns, so they appear only as unattributed allowance movement (P4).

### P7. Browser adapters

`claude_browser`, `codex_browser`, and `cursor_browser` read the allowance meters of a signed-in web app through the browser extension and submit `allowance.reading` records only: never tokens, never money, never a project. The Claude extension exists and is quota-only by design; the Codex and Cursor readers are planned.

### P8. Provider Admin APIs

The `anthropic_api` and `openai_api` adapters (stubs today, behind `billing.*` settings and keys in `secrets.json`) will read organization-level reports into `account.usage_bucket` and `money.entry` records.

- Anthropic: `/v1/organizations/usage_report/messages` groups by `api_key_id`, `workspace_id`, `model`, `service_tier`, `context_window`, `inference_geo`, and `speed` (beta header) in 1m, 1h, or 1d buckets; `/v1/organizations/cost_report` groups by `workspace_id` and `description` daily. The Admin API is unavailable for individual accounts and reports API spend only, never Pro or Max subscription usage. The Claude Code Analytics API adds per-user daily productivity and cost with a `customer_type` of `api` or `subscription` for organizations.
- OpenAI: `/v1/organization/usage/completions` groups by `project_id`, `user_id`, `api_key_id`, `model`, `batch`, and `service_tier`; the costs endpoint groups by project and line item. An Admin key is required. Codex usage under a ChatGPT plan is not in these reports.
- Mapping: `workspace_id` and OpenAI `project_id` → `dimensions.workspace_ref`, keys → `api_key_ref`, users → `user_ref`, all hashed. These buckets are a separate ledger and are never summed with the request ledger.

### P9. Cursor

Cursor's local `state.vscdb` keeps per-message token counters, but they are not billed usage and its usage data is empty; the hosted dashboard's usage events (model, kind, tokens, cents per event, no repository) are the authoritative ledger, and the Teams Admin API reports per user, automation, and billing group. A per-project view would mean joining local conversation timestamps with hosted events by time, which is a heuristic and is not planned. The `cursor_execution` and `cursor_account` adapters are stubs until provider fixtures exist.

### P10. Monthly detailed report

The optional `detailed_report` step runs the installed local analyzers on the Mac and uploads a report envelope with token composition, daily activity, models, projects, task families, work modes, and agent orchestration. Everything is computed locally from transcripts, so it covers local and desktop sessions only, and it is a separate ledger from the hourly buckets and request records. It is the only place a task category exists today.

## Reference points in the market

- `ccusage` groups local Claude Code usage by project with `--instances`, filters with `--project`, and warns on the five-hour block with `--token-limit`; it reads the same transcript store as P1.
- CodeBurn keys projects on the sanitized working-directory folder across about forty tools, classifies thirteen task categories from tool patterns and prompt keywords without model calls, and models a subscription plan so covered usage shows a net cost of zero.
- None of the local tools handle cloud sessions, and the ones that read Cursor's local database report counters that are not billed usage.
