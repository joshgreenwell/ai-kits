# Usage coverage

Living document. Updated September 13, 2026.

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
| Subagent versus main session | `subagents/` directory, `isSidechain`, `attributionAgent` | `session_meta.source.subagent.thread_spawn` | hook `agent_id`, OTel `query_source` | n/a | n/a | n/a | n/a | `parent_session_hash` | Partial today, P1; the full breakdown is Table 4 and P11 |
| Model | `message.model` | `turn_context.model` | OTel `model` | analytics | usage events | `group_by[]=model` | `group_by[]=model` | `model_actual` | Yes today, P1 |
| Effort, speed, service tier | `effort`, `usage.speed`, `usage.service_tier` | n/a | OTel `speed`, `effort` | n/a | `maxMode` | `service_tier`, `speed` | `service_tier` | none | Not planned |
| Session title | `customTitle` | n/a | n/a | n/a | n/a | n/a | n/a | none | Never uploaded; free text |
| Task category | heuristic from tool use and prompt words | heuristic | n/a | n/a | n/a | n/a | n/a | `tools`, hashed names | Monthly report only, P10 |
| Tool | `tool_use` blocks in each assistant line's `message.content`, repeated in the line's `wireToolInputs` by tool-use id | `response_item` of type `function_call` (`name`, `namespace`) or `custom_tool_call` (`name`) | hook `tool_name`; OTel `tool_result` event `tool_name` | none | none | none | none | `activity.request.tools[]`, `tool_calls` | Planned, P12; the full breakdown is Table 5 |
| Resource a tool call touched, for example an Obsidian vault | derived at collection time from the paths in `tool_use.input` and the line's `cwd` against locally configured roots | derived from the tool arguments and the turn's `cwd` | hook `tool_input` and `cwd` allow the same match, but the VM holds no copy of a local vault | none | none | none | none | none | Planned, P12 |
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

## Table 4. Agent attribution by source

Verified on September 12, 2026 against Claude Code 2.1.266 by spawning a background subagent from a desktop session and reading the files it left; the Codex column comes from the rollouts the monthly analyzer already reads. Same legend as above.

| Fact | Claude local transcript | Codex local rollout | Claude cloud session | Codex cloud task | Cursor | Anthropic Admin API | OpenAI Admin API | Envelope v2 field | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Request ran inside a subagent | file under `<session>/subagents/`; every line `isSidechain: true` and `agentId`; every assistant line `attributionAgent` | `session_meta.source` JSON with a `subagent.thread_spawn` block; `thread_source` `subagent` | `SubagentStart`, `SubagentStop`, and tool hooks carry `agent_id`; OTel `query_source` is `main`, `subagent`, or `auxiliary` | none | none | none | none | `parent_session_hash` | Partial, P1: path-based only, and the value equals `session_hash` because subagent lines carry the parent session id |
| Subagent identity | `agentId` on every line, also the file name `agent-<agentId>.jsonl` | child thread id; `thread_spawn.parent_thread_id` | hook `agent_id`; OTel trace spans `agent_id` and `parent_agent_id` (events and metrics carry none) | none | none | none | none | none | Planned, P11: hashed agent id on `activity.request` |
| Agent type by name | `attributionAgent` on assistant lines; `agentType` in `agent-<agentId>.meta.json`; `subagent_type` in the parent's `Agent` tool call | `thread_spawn.agent_role`, `agent_path` | hook `agent_type`; OTel `agent.name` (built-in names verbatim, custom agents as the literal `custom`) | none | none | none | none | none | Planned, P11: allowlisted built-in names, custom names under the `tool_detail` policy |
| Built-in delegation versus custom profile | name lookup: `general-purpose`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `claude` are built in; anything defined in `.claude/agents`, `~/.claude/agents`, a plugin `agents/` directory, or `--agents` is custom | `agent_role` present means a custom role, absent means a generic spawn; `codex-auto-review` is the Guardian reviewer | OTel metrics make the split natively; hooks give the name, the lookup is ours | none | none | none | none | none | Planned, P11: `agent_class` of `main`, `builtin`, `custom`, `unknown` |
| Who started the delegation, the model or the user | not recorded; an explicit `@agent` mention and a model-chosen delegation produce the same `Agent` tool call | not recorded | not recorded in hooks or OTel | none | none | none | none | none | No |
| Spawn depth, nested agents | `spawnDepth` in `agent-<agentId>.meta.json`; a nested agent's file sits under its own parent | `thread_spawn.depth` | SDK messages carry `parent_agent_id`; hooks and OTel events do not | none | none | none | none | none | Planned, P11 |
| Foreground versus background | `requestShape` and `requestNonInteractive` in the meta file; `run_in_background` in the parent's tool call | n/a | n/a | n/a | n/a | n/a | n/a | none | Planned, P11 |
| Requested versus resolved model | `model` in the parent's `Agent` tool call, `resolvedModel` in its tool result, `message.model` on the subagent's own lines | `turn_context.model` on the child thread | OTel `model` only | none | none | none | none | `model_requested` exists, `model_actual` filled | Partial, P1: `model_actual` only; `model_requested` stays null |
| Join to the parent tool call | `toolUseId` in the meta file matches the parent's tool-use block; the tool result carries `agentId` | `parent_thread_id` | SDK `parent_tool_use_id` only | none | none | none | none | none | Not planned; local only |
| Per-agent token total | sum of the subagent file; the desktop app also writes a task notification with `subagent_tokens`, `tool_uses`, `duration_ms` into the parent transcript | sum of the child thread | none | none | none | none | none | derivable from request records once the agent block exists | Planned, P11 |
| Subagent share of hourly buckets | same as above | same | none | none | none | none | none | `account.usage_bucket` has no agent dimension | Not planned; buckets stay keyed by session, hour, and model for v1 parity |

The main session's lines never carry `attributionAgent`; Anthropic's monitoring docs describe the same split as `query_source` `main` versus `subagent`. Explore and Plan inherit the parent's model, `general-purpose` inherits it unless `CLAUDE_CODE_SUBAGENT_MODEL` is set, `claude-code-guide` runs Haiku, and `statusline-setup` runs Sonnet, so a cheaper model inside a subagent file with a built-in name is the parent delegating, not a custom profile. No custom agent is defined on any machine we collect from today, so the custom branch is untested against real data.

## Table 5. Tool-call attribution by source

Verified on September 13, 2026 against the transcripts on the Windows machine: 5 Claude Code transcripts, all from the desktop app, and 329 Codex rollouts, of which 33 ran inside an Obsidian vault and about 550 tool calls named a vault path. The hook and OTel columns come from Anthropic's hooks and monitoring references read the same day. Same legend as above.

| Fact | Claude local transcript | Codex local rollout | Claude cloud session | Codex cloud task | Cursor | Anthropic Admin API | OpenAI Admin API | Envelope v2 field | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A tool call happened, and its name | `tool_use` block in the assistant line's `message.content` with `id` and `name`; the same inputs again in the line's `wireToolInputs`, keyed by tool-use id | `response_item` of type `function_call` (`name`, `namespace`, `call_id`) or `custom_tool_call` (`name`, `call_id`); on this machine `exec` is the shell and `apply_patch` the editor | `PreToolUse` and `PostToolUse` carry `tool_name` and `tool_use_id`; OTel `tool_result` event carries `tool_name`, `tool_use_id`, `success`, `duration_ms` | none | none | none | none | `activity.request.tools[]` (name and call count, at most 50 names) and `tool_calls` | Planned, P12: the fields exist and the server stores them; the companion sends `tool_calls` null and no `tools` today |
| MCP server behind the tool | name prefix `mcp__<server>__<tool>` | `namespace` of `mcp__<server>` with the bare tool name in `name`; built-in namespaces are `collaboration` and `clock` | hook `tool_name` keeps the prefix; OTel `mcp_server_scope` always, `mcp_server_name` and `mcp_tool_name` behind `OTEL_LOG_TOOL_DETAILS` | none | none | none | none | `tools[].name` under the `tool_detail` policy: a custom name is hashed or omitted | Planned, P12. No Obsidian MCP server is configured on any machine we collect from, so no vault access carries a tool name today |
| Arguments: path, command, pattern, URL | `tool_use.input`: `file_path` for Read, Write, Edit; `pattern` and `path` for Grep and Glob; `command` for Bash; `url` for WebFetch; file paths absolute with native separators | `function_call.arguments` JSON: `shell_command` has `command`, `workdir`, `timeout_ms`; `custom_tool_call.input`: `exec` is JavaScript calling `tools.exec_command({cmd})`, `apply_patch` is patch text with `*** Update File:` headers | hook `tool_input` in full; OTel `tool_input` (values truncated at 512 characters) and the tool span's `file_path` and `full_command`, all behind `OTEL_LOG_TOOL_DETAILS` | none | none | none | none | none | Never uploaded; free text and paths. Read on the machine only, to derive the resource row |
| Result size and outcome | user line with `tool_result` (`tool_use_id`, `is_error`) and `toolUseResult`: Bash `stdout`, `stderr`, `interrupted`, `persistedOutputSize`; Read `file.numLines`, `file.totalLines`; Grep `numFiles`, `numLines`; WebFetch `bytes`, `code` | `function_call_output` and `custom_tool_call_output` with `call_id` and `output` text; the exit code sits inside the text | hook `tool_response`; OTel `tool_result_size_bytes`, `tool_input_size_bytes`, `success`, `error_type` | none | none | none | none | none | Planned, P12: kept locally as the weight for splitting a request's input across resources |
| Resource the call touched, for example an Obsidian vault | derived: match the argument paths, the quoted paths inside `command`, and the line's `cwd` against locally configured roots | derived: same over `arguments`, `input`, and the turn's `cwd`; a session opened inside the vault attributes every call of the turn | hook `tool_input` and `cwd` allow the same match, but the VM holds no local vault unless it sits inside the repository | none | none | none | none | none | Planned, P12: `resources[]` on `activity.request` with a label code or hash, a call count, and an estimated input share |
| Tokens the tool result cost | the next assistant line's `usage` after the `tool_result` user line: `input_tokens` and `cache_creation_input_tokens` carry the result; `parentUuid` chains the lines and the user line's `sourceToolAssistantUUID` names the issuing line | the `token_count` event after the output: in the rollouts read, 13,492 gaps between consecutive counts held exactly one tool output, 699 held none, one held two | OTel `api_request` follows but has no tool linkage; hooks carry no token counts | none | none | none | none | `activity.request.tokens` of the following request | Planned, P12: exact when one result feeds the request, estimated by result size when several do |
| Join between the call, its result, and the requests around it | `tool_use.id` equals `tool_result.tool_use_id`; `requestId` on the issuing assistant line; `promptId` on the user line | `call_id` on the call and its output | `tool_use_id` in hooks, on the OTel `tool_result` and `tool_decision` events, and on the tool span | none | none | none | none | `semantic_key` of the issuing and the following request | Not planned; local only, like the agent join |
| Denied or failed tool call | `tool_result.is_error`; `toolUseResult.interrupted`; a denial is a `tool_result` carrying the refusal text | non-zero exit code inside `output`; a refused `exec` still writes an output | `PostToolUseFailure` and `PermissionDenied` hooks; OTel `tool_decision`, and `success` with `error_type` on `tool_result` | none | none | none | none | none | Not planned; a failed call still costs the following request's input |
| Server-side tools, web search and fetch | `usage.server_tool_use.web_search_requests` and `web_fetch_requests` on the assistant line | `response_item` of type `web_search_call` with `action` and `status` | no hook fires; they run inside the API | none | none | not a `group_by` dimension of the usage report | none | none | Not planned; included in a plan request, priced separately on the API |

The vault access on the Windows machine is entirely shell-based: Codex `exec` calls that read Markdown files under the two vault directories, and sessions opened inside them. Nothing distinguishes those calls from any other file read except the path in the arguments, which is why the resource row is derived and the argument row is never uploaded. Obsidian lists its vaults with stable ids and paths in its own `obsidian.json` under the application data directory, which gives `setup` a discovery path and a key that survives a moved vault. The Codex scan's byte filter (`interesting()` in `jsonl.rs`) skips every `response_item` line today, so no Codex tool call is parsed at all; the Claude tool blocks sit inside the assistant lines the scan already reads and are ignored.

## Processes

### P1. Local transcript scan

The companion's `claude_execution` and `codex_execution` adapters walk the transcript roots (`~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`, or configured roots), resume each file from a checkpoint of size, modification time, file identity, and byte offset, parse only lines that can carry usage, and save one event per provider message keyed by the v1 digest. Hourly buckets are derived from events by session, hour, and model exactly as `collect.py` did, which the parity corpus enforces. At `detail_level` `requests`, every retained event is also emitted as an `activity.request` record.

Nuances:

- `since` pins the backfill start when the state database is created; older files are never read.
- A message that appears in two files, for example a mirrored project directory, is counted once with the larger of each token component.
- Subagent transcripts under `<session>/subagents/` are counted under their parent when `include_subagents` is on, which is the default and matches v1. What else those files carry, and what the scan drops, is P11.
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

### P11. Agent attribution

Not built. The facts in Table 4 are on disk for every local Claude and Codex session, and the companion already opens the files that carry them; it keeps only the parent relationship.

- Today: `subagent_parent()` in the scan recognises the `<session>/subagents/` directory and sets `parent_session_hash`. Subagent lines carry the parent's `sessionId`, so `session_hash` and `parent_session_hash` are the same value and the request record has no agent id, type, depth, or requested model. `include_subagents` off drops the files entirely. Buckets fold subagent tokens into the parent session by model, so a Haiku Explore request and a Haiku main-session request are the same row. The Codex parser reads `session_meta.source` for surface only. The hook receiver keeps event name, tool name, and session hash, and no `SubagentStart` or `SubagentStop` hook is installed.
- Contract change: an `agent` object on `activity.request` with a hashed agent id, `agent_class` (`main`, `builtin`, `custom`, `unknown`), the agent name under the existing `tool_detail` policy (built-in names verbatim, custom names hashed or omitted), `spawn_depth`, and `request_shape`; fill `model_requested` from the parent's `Agent` tool call and its `resolvedModel`. Same cost as any contract change: schema regeneration, vendored schema, migration column, fixtures.
- Companion change: read `agentId` and `attributionAgent` from the lines rather than the path, so an older transcript with inline `isSidechain` lines classifies the same way; read `agent-<agentId>.meta.json` for depth and shape; index the parent transcript's `Agent` tool results by `agentId` for the requested model; for Codex read `thread_spawn.agent_role` and `depth` from `session_meta.source`. The parity fixture `agent-1.jsonl` gains `agentId`, `attributionAgent`, and a meta file; the v1 bucket digests must not move.
- Built-in versus custom: a fixed allowlist of built-in names plus a scan of the agent definition directories at collection time. The Observatory shows the class and the built-in name; a custom name appears only when `tool_detail` is `hashed_custom`, matching how custom tool names are handled.
- Cloud sessions: no transcript, so the hook path in P5 is the only local-code route, and `SubagentStart` and `SubagentStop` give `agent_id` and `agent_type` without token counts; the OTel path gives `agent.name` and `query_source` on every `api_request` event, which is enough for the class split but not for per-agent totals without the trace spans.
- Out of reach: whether the user asked for the agent or the model chose it. Report the split as built-in delegation versus custom role, which is what the monthly report's `agent_orchestration` block already calls `generic` and `custom`.

### P12. Tool-call attribution

Not built. Every fact in Table 5 is in the local transcripts of both providers, and the companion already opens the files that carry them; it drops every tool block. Phase 4 of the companion plan covers `tools[]` and `tool_calls` under the `tool_detail` setting; the resource rows extend that phase.

- Today: `activity.request.tools` and `tool_calls` are in the contract, the pending unified-usage migration has `activity_requests.tools` and `tool_calls`, and the store writes them, but the companion sends `tool_calls` null and no `tools`, and the dashboard has no per-tool view. The hook receiver keeps the event name, the tool name, and a hashed session id from the hook JSON and discards `tool_input`, `tool_response`, and `cwd` by design; no tool hook is installed on the machines we collect from. The Codex scan admits `token_count`, `session_meta`, `turn_context`, `task_started`, and assistant lines only, so `function_call` and `custom_tool_call` lines are never parsed.
- Resource roots stay on the machine. The settings document can turn a mode on or off but can never name a path (`settings.rs`), so roots go in `companion.json` beside the binding roots as a list of `{ key, roots }` entries, where the key is a short label code. `setup` can propose Obsidian vaults from the application's `obsidian.json` (Roaming AppData on Windows, Application Support on macOS), keyed by the id Obsidian assigns so a moved vault keeps its key. `observatory resources` lists key and root together, the way `observatory projects` lists hash and path, and runs on the machine only.
- Contract change: a `resources` array on `activity.request`, each entry `{ key, calls, input_share }`. `key` is a label code or `h:<16 hex>` under the same policy as `tool_detail`; `calls` is exact; `input_share` is the estimated fraction of the request's fresh and cache-write input that came from tool results matched to that resource, and the record's `basis` becomes `estimated` when more than one result fed the request. Same cost as any contract change: schema regeneration, vendored schema, migration column, fixtures.
- Companion change, Claude: read the `tool_use` blocks on the assistant lines the scan already parses; take `file_path`, `path`, `pattern`, `notebook_path`, and `url` by name, and quoted or whitespace-delimited tokens that look like paths out of `command`; resolve relative paths against the line's `cwd`; normalize separators and, on Windows, case; match by prefix against the roots. Keep the matched keys and the result size from the answering user line's `toolUseResult` in the checkpoint context until the next assistant line with `usage`, then attribute that request.
- Companion change, Codex: widen the byte filter to `function_call`, `custom_tool_call`, and their outputs; take `command` and `workdir` from `shell_command`, quoted path tokens out of `exec` input, and `*** Update File:` and `*** Add File:` headers out of `apply_patch`; a turn whose `turn_context.cwd` is inside a root attributes every call of that turn; the following `token_count` carries the cost. The parity corpus gains tool lines, and the v1 bucket digests must not move.
- Accounting: charge the request that consumed the result, never the one that issued the call. Call counts are exact. Token shares are estimates, shown as such, never summed into allowance; the unattributed remainder is displayed as such. Output tokens are never attributed to a resource.
- Cloud sessions: hooks would give `tool_input` and `cwd` with no token counts, and the VM holds no copy of a local vault unless it sits inside the repository, so the resource row is local-only in practice. The OTel `tool_result` event gives name, success, and result size, and the tool span gives `file_path` and `full_command` behind `OTEL_LOG_TOOL_DETAILS`, which is enough to classify once an OTLP receiver exists (P5). Codex cloud tasks expose nothing.
- Out of reach: whether the model used what it read; a script that opens vault files through code rather than a literal path; files reached through a symlink or junction outside the root. If an Obsidian MCP server is added later, the tool name alone carries the signal under `tool_detail`, but it does not cover the history that already exists.

## Reference points in the market

- `ccusage` groups local Claude Code usage by project with `--instances`, filters with `--project`, and warns on the five-hour block with `--token-limit`; it reads the same transcript store as P1.
- CodeBurn keys projects on the sanitized working-directory folder across about forty tools, classifies thirteen task categories from tool patterns and prompt keywords without model calls, and models a subscription plan so covered usage shows a net cost of zero.
- None of the local tools handle cloud sessions, and the ones that read Cursor's local database report counters that are not billed usage.
- Neither local tool attributes a tool call to the directory it touched. CodeBurn reads tool names as a task-category signal only, and `ccusage` reports no tool dimension.
