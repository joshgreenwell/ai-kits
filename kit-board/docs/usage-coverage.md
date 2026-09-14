# Usage coverage

Living document. Updated September 13, 2026.

**Capability and roadmap reference, not a production status report.** Start with [the current-system audit](usage-system.md) for what is enabled and receiving data. Production currently uses `buckets_only` and project attribution `off`: the request ledger is empty. The tables below describe supported collection when enabled or clearly marked future work. V1 removal is separate in [the retirement runbook](usage-v1-retirement.md).

The implementation in `companion/crates/observatory-adapters/src/stubs.rs` takes precedence over proposed paths below: Claude OAuth, Codex app-server/web-backend, both Cursor readers, and both Admin API readers are stubs. The v2 browser collector is also unimplemented. A setting, discovered store, or binding is not a working collector.

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
| Codex CLI | this machine | Yes | Yes | Yes, embedded; app-server planned | No (plan) | Hashed | Yes, `cli` | P1, P2, P4 |
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
| Project identity | `cwd` on every line | `session_meta.cwd`, then each `turn_context.cwd` | hook input `cwd`, OTel repository attributes | none | workspace folder, local only | none | native OpenAI project id | `activity.request.project` (`project_hash` is the working-directory compatibility alias) | Built in USG-007 for supported local sources and server-native identities, P2 |
| Git repository | derivable from `cwd` at collection time | `session_meta.git.repository_url`, rarely present | OTel `vcs.repository.*` | none | none | none | none | none | Planned, P2 |
| Git branch | `gitBranch` | `session_meta.git.branch`, rarely present | OTel on commits | none | none | none | none | none | Not planned; needs a contract field |
| Surface or entrypoint | `entrypoint` | `originator`, `source` | fixed `cloud` | Enterprise analytics only | n/a | n/a | n/a | `activity.request.surface` | Yes today, P1 |
| Session | `sessionId` | `session_meta.id` | session id | thread id | `conversationId`, hosted | n/a | n/a | `session_hash` | Yes today, P1 |
| Subagent versus main session | `subagents/` directory, `isSidechain`, `attributionAgent` | `session_meta.source.subagent.thread_spawn` | hook `agent_id`, OTel `query_source` | n/a | n/a | n/a | n/a | `parent_session_hash` | Partial today, P1; the full breakdown is Table 4 and P11 |
| Model | `message.model` | `turn_context.model` | OTel `model` | analytics | usage events | `group_by[]=model` | `group_by[]=model` | `model_actual` | Yes today, P1 |
| Effort, speed, service tier | `effort`, `usage.speed`, `usage.service_tier`; cache-write TTL from `usage.cache_creation` | `turn_context.effort`; context size from `token_count.info.model_context_window` | OTel `speed`, `effort` | n/a | `maxMode` | `service_tier`, `speed` | `service_tier` | `activity.request.pricing`, `account.usage_bucket.dimensions.pricing` | Partial today, P1: recorded local fields only; unsupported dimensions stay null |
| Session title | `customTitle` | n/a | n/a | n/a | n/a | n/a | n/a | none | Never uploaded; free text |
| Task category | heuristic from tool use and prompt words | heuristic | n/a | n/a | n/a | n/a | n/a | `tools`, hashed names | Monthly report only, P10 |
| Tool | `tool_use` blocks in each assistant line's `message.content`, repeated in the line's `wireToolInputs` by tool-use id | `response_item` of type `function_call` (`name`, `namespace`) or `custom_tool_call` (`name`) | hook `tool_name`; OTel `tool_result` event `tool_name` | none | none | none | none | `activity.request.tools[]`, `tool_calls` | Planned, P12; the full breakdown is Table 5 |
| Resource a tool call touched, for example an Obsidian vault | derived at collection time from paths in `tool_use.input`, resolving relative paths against the line's `cwd`, then matching locally configured roots | derived from tool arguments, resolving relative paths against the turn's `cwd` | hook `tool_input` and `cwd` allow the same resolution, but the VM holds no copy of a local vault | none | none | none | none | none | Planned, P12 |
| Workspace, OpenAI project, API key, user | n/a | n/a | n/a | n/a | n/a | `workspace_id`, `api_key_id` | `project_id`, `user_id`, `api_key_id` | `account.usage_bucket.dimensions` | Planned, P8 |

"Project" means different things per column. In the local transcripts it is the working directory. In the OpenAI Admin API it is an organization-level grouping of API keys. The two never join.

## Table 3. Allowance meters

| Meter | Reader | Per account | Per project | Process |
| --- | --- | --- | --- | --- |
| Claude five-hour and seven-day windows, Pro or Max | statusline JSON; OAuth endpoint reader planned | Yes | Planned: each statusline sample carries `workspace.project_dir` beside `rate_limits`, so the change between two samples can be attributed to the one project active in between | P3 |
| Claude spend limit behind an apps gateway | statusline | n/a for personal accounts | n/a | P3 |
| Codex five-hour and weekly windows | `rate_limits` embedded in each `token_count`; app-server reader planned | Yes | Planned by the same delta method; the rollout carries `cwd` | P4 |
| Codex cloud tasks | none locally | shared with the meters above | No | P6 |
| Cursor plan usage | hosted usage summary | Planned | No | P9 |
| Claude.ai and ChatGPT in a browser | browser extension | Yes for Claude, planned for ChatGPT | No | P7 |

Every provider meters per account. Nothing per project comes from a provider; the per-project rows are derived locally and stay in percentage points. They are never converted to tokens and never summed across windows.

## Table 4. Agent attribution by source

Verified on September 12, 2026 against Claude Code 2.1.266 by spawning a background subagent from a desktop session and reading the files it left; the Codex column comes from the rollouts the monthly analyzer already reads. Same legend as above.

| Fact | Claude local transcript | Codex local rollout | Claude cloud session | Codex cloud task | Cursor | Anthropic Admin API | OpenAI Admin API | Envelope v2 field | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Request ran inside a subagent | file under `<session>/subagents/`; every line `isSidechain: true` and `agentId`; every assistant line `attributionAgent` | `session_meta.source` JSON with a `subagent.thread_spawn` block; `thread_source` `subagent` | `SubagentStart`, `SubagentStop`, and tool hooks carry `agent_id`; OTel `query_source` is `main`, `subagent`, or `auxiliary` | none | none | none | none | `parent_session_hash`, `activity.request.agent` | Built in USG-005 for child files, inline Claude sidechains, and Codex thread spawns; unsupported identity is explicit Unknown |
| Subagent identity | `agentId` on every line, also the file name `agent-<agentId>.jsonl` | child thread id; `thread_spawn.parent_thread_id` | hook `agent_id`; OTel trace spans `agent_id` and `parent_agent_id` (events and metrics carry none) | none | none | none | none | `activity.request.agent`, `agent.event` | Built in USG-005 with provider IDs hashed before emission and resumed children deduplicated by stable child identity |
| Agent type by name | `attributionAgent` on assistant lines; `agentType` in `agent-<agentId>.meta.json`; `subagent_type` in the parent's `Agent` tool call | `thread_spawn.agent_role`, `agent_path` | hook `agent_type`; OTel `agent.name` (built-in names verbatim, custom agents as the literal `custom`) | none | none | none | none | `agent.class`, `agent.name` | Built in USG-005; built-in names follow `tool_detail`, custom names remain omitted or hashed |
| Built-in delegation versus custom profile | name lookup: `general-purpose`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `claude` are built in; anything defined in `.claude/agents`, `~/.claude/agents`, a plugin `agents/` directory, or `--agents` is custom | `agent_role` present means a custom role, absent means a generic spawn; `codex-auto-review` is the Guardian reviewer | OTel metrics make the split natively; hooks give the name, the lookup is ours | none | none | none | none | `agent.class` | Built in USG-005 for the verified local formats; absent or unsupported roles remain Unknown |
| Who started the delegation, the model or the user | not recorded; an explicit `@agent` mention and a model-chosen delegation produce the same `Agent` tool call | not recorded | not recorded in hooks or OTel | none | none | none | none | none | No |
| Spawn depth, nested agents | `spawnDepth` in `agent-<agentId>.meta.json`; a nested agent's file sits under its own parent | `thread_spawn.depth` | SDK messages carry `parent_agent_id`; hooks and OTel events do not | none | none | none | none | `agent.depth`, `agent.parent_key` | Built in USG-005; a known parent key is retained even when its transcript is absent |
| Foreground versus background | `requestShape` and `requestNonInteractive` in the meta file; `run_in_background` in the parent's tool call | n/a | n/a | n/a | n/a | n/a | n/a | none | Planned, P11 |
| Requested versus resolved model | `model` in the parent's `Agent` tool call, `resolvedModel` in its tool result, `message.model` on the subagent's own lines | `turn_context.model` on the child thread | OTel `model` only | none | none | none | none | `model_requested`, `model_actual` | Built in USG-005 for Claude when the parent call joins to the child; Codex requested model remains unknown because the local source exposes only the child turn model |
| Join to the parent tool call | `toolUseId` in the meta file matches the parent's tool-use block; the tool result carries `agentId` | `parent_thread_id` | SDK `parent_tool_use_id` only | none | none | none | none | `agent.event.tool_invocation_key` | Built in USG-005 for Claude; Codex local history records the parent child relationship without a spawn-tool invocation identity |
| Per-agent token total | sum of the subagent file; the desktop app also writes a task notification with `subagent_tokens`, `tool_uses`, `duration_ms` into the parent transcript | sum of the child thread | none | none | none | none | none | `activity.request.agent.key` | Built in USG-005 as a breakdown of canonical request tokens; it is never added to the overall total |
| Subagent share of hourly buckets | same as above | same | none | none | none | none | none | `account.usage_bucket` has no agent dimension | Not planned; buckets stay keyed by session, hour, and model for v1 parity |

The main session's lines never carry `attributionAgent`; Anthropic's monitoring docs describe the same split as `query_source` `main` versus `subagent`. Explore and Plan inherit the parent's model, `general-purpose` inherits it unless `CLAUDE_CODE_SUBAGENT_MODEL` is set, `claude-code-guide` runs Haiku, and `statusline-setup` runs Sonnet, so a cheaper model inside a subagent file with a built-in name is the parent delegating, not a custom profile. No custom agent is defined on any machine we collect from today, so the custom branch is untested against real data.

## Table 5. Tool-call attribution by source

Verified on September 13, 2026 against the transcripts on the Windows machine: 5 Claude Code transcripts, all from the desktop app, and 329 Codex rollouts, of which 33 ran inside an Obsidian vault and about 550 tool calls named a vault path. The hook and OTel columns come from Anthropic's hooks and monitoring references read the same day. Same legend as above.

| Fact | Claude local transcript | Codex local rollout | Claude cloud session | Codex cloud task | Cursor | Anthropic Admin API | OpenAI Admin API | Envelope v2 field | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A tool call happened, and its name | `tool_use` block in the assistant line's `message.content` with `id` and `name`; the same inputs again in the line's `wireToolInputs`, keyed by tool-use id | `response_item` of type `function_call` (`name`, `namespace`, `call_id`) or `custom_tool_call` (`name`, `call_id`); on this machine `exec` is the shell and `apply_patch` the editor | `PreToolUse` and `PostToolUse` carry `tool_name` and `tool_use_id`; OTel `tool_result` event carries `tool_name`, `tool_use_id`, `success`, `duration_ms` | none | none | none | none | `tool.event`; legacy `activity.request.tools[]` | Built in USG-006 for supported Claude and Codex local forms. One invocation identity produces one headline call; tool-only and result-less calls remain visible |
| MCP server behind the tool | name prefix `mcp__<server>__<tool>` | `namespace` of `mcp__<server>` with the bare tool name in `name`; built-in namespaces are `collaboration` and `clock` | hook `tool_name` keeps the prefix; OTel `mcp_server_scope` always, `mcp_server_name` and `mcp_tool_name` behind `OTEL_LOG_TOOL_DETAILS` | none | none | none | none | `tool.event.tool.namespace` | Built in USG-006 for local transcript forms. MCP and other non-built-in names/namespaces are omitted or hashed under `tool_detail`; no Obsidian MCP server is configured on a collected machine today |
| Arguments: path, command, pattern, URL | `tool_use.input`: `file_path` for Read, Write, Edit; `pattern` and `path` for Grep and Glob; `command` for Bash; `url` for WebFetch; file paths absolute with native separators | `function_call.arguments` JSON: `shell_command` has `command`, `workdir`, `timeout_ms`; `custom_tool_call.input`: `exec` is JavaScript calling `tools.exec_command({cmd})`, `apply_patch` is patch text with `*** Update File:` headers | hook `tool_input` in full; OTel `tool_input` (values truncated at 512 characters) and the tool span's `file_path` and `full_command`, all behind `OTEL_LOG_TOOL_DETAILS` | none | none | none | none | none | Never uploaded; free text and paths. Read on the machine only, to derive the resource row |
| Result size and outcome | user line with `tool_result` (`tool_use_id`, `is_error`) and `toolUseResult`: Bash `stdout`, `stderr`, `interrupted`, `persistedOutputSize`; Read `file.numLines`, `file.totalLines`; Grep `numFiles`, `numLines`; WebFetch `bytes`, `code` | `function_call_output` and `custom_tool_call_output` with `call_id` and `output` text; the exit code sits inside the text | hook `tool_response`; OTel `tool_result_size_bytes`, `tool_input_size_bytes`, `success`, `error_type` | none | none | none | none | none | Planned, P12: kept locally as the weight for splitting a request's input across resources |
| Resource the call touched, for example an Obsidian vault | derived: match argument paths and quoted paths inside `command`, using the line's `cwd` only to resolve relative arguments | derived: same over `arguments` and `input`, using the turn's `cwd` only to resolve relative arguments; cwd inside a vault is not access evidence by itself | hook `tool_input` and `cwd` allow the same resolution, but the VM holds no local vault unless it sits inside the repository | none | none | none | none | `resource.access` joined by `invocation_key` | Contract and storage ready; collection is USG-008 |
| Tokens the tool result cost | the next assistant line's `usage` after the `tool_result` user line: `input_tokens` and `cache_creation_input_tokens` carry the result; `parentUuid` chains the lines and the user line's `sourceToolAssistantUUID` names the issuing line | the `token_count` event after the output: in the rollouts read, 13,492 gaps between consecutive counts held exactly one tool output, 699 held none, one held two | OTel `api_request` follows but has no tool linkage; hooks carry no token counts | none | none | none | none | `activity.request.tokens` of the following request | Planned, P12: exact when one result feeds the request, estimated by result size when several do |
| Join between the call, its result, and the requests around it | `tool_use.id` equals `tool_result.tool_use_id`; `requestId` on the issuing assistant line; `promptId` on the user line | `call_id` on the call and its output | `tool_use_id` in hooks, on the OTel `tool_result` and `tool_decision` events, and on the tool span | none | none | none | none | `tool.event.invocation_key`, `caller_request_key`, `parent_invocation_key` | Built in USG-006. Claude uses the issuing message key; Codex associates pending calls with the following `token_count`, while calls with no supported accounting event retain a null caller |
| Denied or failed tool call | `tool_result.is_error`; `toolUseResult.interrupted`; a denial is a `tool_result` carrying the refusal text | non-zero exit code inside `output`; a refused `exec` still writes an output | `PostToolUseFailure` and `PermissionDenied` hooks; OTel `tool_decision`, and `success` with `error_type` on `tool_result` | none | none | none | none | `tool.event.outcome` | Built in USG-006 where the local result carries explicit status, error, interruption, narrow refusal, or exit-code evidence; opaque results remain Unknown |
| Server-side tools, web search and fetch | `usage.server_tool_use.web_search_requests` and `web_fetch_requests` on the assistant line | `response_item` of type `web_search_call` with `action` and `status` | no hook fires; they run inside the API | none | none | not a `group_by` dimension of the usage report | none | none | Codex `web_search_call` is built in USG-006 with a derived stable identity and explicit status. Claude aggregate request counters remain unimplemented because they do not expose individual invocation identities |

The supported vault-access evidence on the Windows machine is entirely shell-based: Codex `exec` calls whose recorded arguments name Markdown files under configured vault directories. A session opened inside a vault is context only and does not establish access. Nothing distinguishes a qualifying call from another file read except the path in its arguments, which is why the resource row is derived and the raw argument is never uploaded. Obsidian lists its vaults with stable ids and paths in its own `obsidian.json` under the application data directory, which gives `setup` a discovery path and a key that survives a moved vault. USG-006 now parses the call/result envelope and discards arguments and result content after conservative outcome classification; USG-008 still owns local resource-path classification.

## Processes

### P1. Local transcript scan

The companion's `claude_execution` and `codex_execution` adapters walk the transcript roots (`~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`, or configured roots), resume each file from a checkpoint of size, modification time, file identity, and byte offset, parse only lines that can carry usage, and save one event per provider message keyed by the v1 digest. Hourly buckets are derived from events by session, hour, and model exactly as `collect.py` did, which the parity corpus enforces. At `detail_level` `requests`, every retained event is also emitted as an `activity.request` record. Request, token-composition, and pricing capability states report whether detail is disabled, missing, partial, or complete for the eligible scan.

Nuances:

- `since` pins the backfill start when the state database is created; older files are never read.
- A message that appears in two files, for example a mirrored project directory, is counted once with the larger of each token component.
- Subagent transcripts under `<session>/subagents/` are counted under their recorded parent when `include_subagents` is on, which is the default and matches v1. The local scan generation includes that setting so enabling it later replays retained child and inline evidence. Claude child starts are deduplicated by child identity across resumed files and duplicate results; Codex child thread identities behave the same way.
- Only assistant lines with a `usage` object count; a `<synthetic>` model is skipped.
- Claude request detail maps `message.model` to actual model; the four `usage` counters to exclusive inputs and output; `output_tokens_details.thinking_tokens` to reasoning; top-level `effort`, `usage.service_tier`, and `usage.speed` to pricing evidence; and a positive `cache_creation` 5-minute or 1-hour counter to cache-write TTL. A request with all four explicit zero counters is retained as a request but remains absent from the v1 hourly bucket ledger. `isApiErrorMessage: true` maps to failed; other recognized assistant responses map to completed.
- Codex request detail maps `turn_context.model` to actual model, `turn_context.effort` to effort, `model_context_window` to context size, and the five `last_token_usage` counters to exclusive inputs, output, reasoning, and the reported total. The legacy core cumulative counters make one coherent delta-or-reset decision for the request; nullable fields are differenced only when both cumulative values were recorded, and reasoning cannot change that core decision. A token-count row without any numeric last-request evidence is not treated as a model call.
- Claude records a requested model on the parent `Agent` call when one was chosen, and the child request records the actual model; the join fills `model_requested` for that child. Codex local histories provide the actual child turn model but no separate requested model. Unsupported pricing dimensions remain null, and partial counter objects preserve absent components as null rather than zero.
- Anthropic documents the transcript format as internal and version-unstable. The parity corpus and golden snapshots catch drift in CI; in production, a shape change increments malformed coverage and makes the affected capability partial rather than converting absent fields to zero.
- The state stores legacy bucket counters separately from nullable request evidence. A parser-generation change atomically clears that binding's file checkpoints and replays files still eligible under `since`; interrupted replays resume. Unresolved malformed-file gaps persist outside those checkpoints, including after source deletion, until a successful full replay clears them. Deleted files, unavailable roots, and files older than `since` cannot be reconstructed and remain coverage limits.
- Desktop-app sessions sit in the same store as terminal sessions and are told apart by surface (see P2). The Cowork transcripts of the Claude desktop app are not in this store and are not coding usage.
- A cloud session pulled down with `claude --teleport` becomes a local transcript whose assistant lines carry usage, so the scan counts the cloud work as local from the moment of the teleport. There is no marker, so it is counted, but under the wrong surface and in the hour of the teleport rather than of the work.
- Codex rollouts record `cwd` in `session_meta` and again in each `turn_context`; a rollout without `session_meta` (archived, older versions) has no working directory and stays unattributed.

### P2. Hashed project attribution and surface

Setting: `execution.project_attribution` in Usage → Settings, `off` by default, `hashed` to enable. The companion records the working directory and its hash in its local `projects` table. When enabled, requests upload a structured project block with the hash and attribution basis; no path is uploaded. A local project-attribution deny overrides the server setting for fresh and queued records. Adapter, provider, and execution-mode denies keep queued records from the denied adapter local as well.

- The key is `sha256(["project", cwd])` in the repository's stable JSON form, where `cwd` has trailing separators trimmed and is bounded to 400 characters. The same directory produces the same key from Claude and Codex, so one project groups across providers on one machine. Two machines produce different keys for the same repository because their paths differ; a label on the Observatory is what joins them.
- The hash is unsalted. A guessed path can be confirmed by hashing it, which is acceptable for a private server and is the price of a key that is stable across installs. The path itself is never uploaded.
- `observatory projects` prints, per binding, every hash with its path and first and last sighting. It is the only place hash and path appear together, and it runs on the machine.
- A request records one of four evidence states: working-directory identity, native identity, known No project, or Unknown. Explicit JSON `null` is known No project; missing, blank, or malformed `cwd` evidence remains Unknown. Current Claude and Codex local histories produce working-directory, No project, and Unknown evidence; no inspected local format supplies a verified native project id. The server retains a native identity when another supported producer supplies one and does not substitute a working-directory hash for it.
- Turning the setting on later works retroactively: a parser-generation replay enriches retained request events when their source files remain eligible under `since`. Missing or ineligible source files stay Unknown and coverage reports the gap; hourly buckets are never used to synthesize project detail.
- Events saved before nullable detail state can be enriched when the parser generation changes and the retained file is still eligible under `since`. Missing or ineligible source files keep their older evidence; the collector does not invent fields from hourly buckets.
- `surface` is always uploaded because it was already in the contract. Claude Code's per-line `entrypoint` maps `cli` → `cli`, `claude-desktop` → `desktop`, `claude-vscode` → `ide`, `sdk-*` → `sdk`, anything newer → `unknown`; a line without the field counts as `cli`. Codex's `session_meta.originator` decides first (`codex_cli_rs` and `codex_exec` → `cli`, anything containing `desktop` → `desktop`, a VS Code or JetBrains originator → `ide`), then `source`. On this machine every Claude event so far came from the desktop app and every Codex event from Codex Desktop.
- Server side: `usage_projects` holds stable logical labels. `usage_project_identities` scopes working-directory evidence by companion install and native evidence by account and provider, so matching folder names or hashes on different machines do not imply equality. Several machine paths and worktrees can be mapped to one logical project through append-only `usage_project_mapping_revisions`.
- `GET` and `PUT /api/usage-projects` provide the authenticated naming and mapping interface. The read model reports raw observation count separately from canonical evidence and mapping coverage, and resolves one evidence-aware revision of each logical request as Project, Unassigned, No project, or Unknown. Retained legacy `project_hash` rows resolve as scoped working-directory evidence without rewriting their null structured columns. Mapping writers lock identities in stable order and the read model uses a database-generated revision order, so a rename, map, or unmap changes historical grouping without updating the raw request ledger.
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

USG-005 builds agent attribution for the supported Claude and Codex local histories. Cloud hooks and telemetry remain future source work.

- Today: requests carry stable hashed agent and parent identities, class, privacy-filtered role name, depth, and available requested/actual model evidence. Claude joins parent `Agent` calls and results to child files, sidecars, and inline sidechains; Codex reads child thread-spawn metadata. Independent lifecycle rows retain observed spawns and starts, including failed Claude spawn attempts. `include_subagents` suppresses known child requests and lifecycle rows while preserving genuinely unknown attribution. Hourly buckets retain their v1 session/hour/model shape and are not an additive agent ledger.
- Contract and storage: `activity.request.agent` retains a hashed identity, identity basis, parent identity, `main`/`builtin`/`custom`/`unknown` class, privacy-safe name, and depth. Independent `agent.event` rows retain spawn and lifecycle evidence even without a token request. The v2 extension is optional for legacy producers; missing blocks remain unreported, not main-agent evidence.
- Collection details: Claude reads `agentId` and `attributionAgent` from lines, `agent-<agentId>.meta.json` for structural evidence, and parent `Agent` calls/results for requested models and joins. Codex reads `thread_spawn.agent_role`, parent thread, and depth from `session_meta.source`. Provider identities are hashed before emission, and stronger late evidence repairs retained parent/depth attribution without duplicating lifecycle events.
- Built-in versus custom: a fixed allowlist of built-in names plus a scan of the agent definition directories at collection time. The Observatory shows the class and the built-in name; a custom name appears only when `tool_detail` is `hashed_custom`, matching how custom tool names are handled.
- Cloud sessions: no transcript, so the hook path in P5 is the only local-code route, and `SubagentStart` and `SubagentStop` give `agent_id` and `agent_type` without token counts; the OTel path gives `agent.name` and `query_source` on every `api_request` event, which is enough for the class split but not for per-agent totals without the trace spans.
- Out of reach: whether the user asked for the agent or the model chose it. Report the split as built-in delegation versus custom role, which is what the monthly report's `agent_orchestration` block already calls `generic` and `custom`.

### P12. Tool-call attribution

USG-006 builds local Claude and Codex invocation collection. USG-008 still owns resource-access extraction, and token allocation across results remains later work.

- Today: the companion emits one `tool.event` invocation per stable provider call identity and a separate deduplicated result event where supported. Claude joins `tool_use.id` to `tool_result.tool_use_id`; Codex joins calls and outputs by `call_id`, and associates calls with the following request accounting event when present. `activity.request.tool_calls` and privacy-filtered `tools` summaries are emitted only at `requests_with_tools`. Tool-only turns and missing results are retained. Arguments/results are inspected in memory for conservative outcome evidence and are not stored. Unknown forms and overlong names make Tool capability coverage partial.
- Resource roots stay on the machine. The settings document can turn a mode on or off but can never name a path (`settings.rs`), so roots go in `companion.json` beside the binding roots as a list of `{ key, roots }` entries, where the key is a short label code. `setup` can propose Obsidian vaults from the application's `obsidian.json` (Roaming AppData on Windows, Application Support on macOS), keyed by the id Obsidian assigns so a moved vault keeps its key. `observatory resources` lists key and root together, the way `observatory projects` lists hash and path, and runs on the machine only.
- Contract and storage: each `resource.access` row carries only a configured privacy-safe resource key, configuration version, access kind, evidence basis, outcome, and invocation join. Raw paths, arguments, results, and content are rejected. One invocation may have several resource rows, so source totals can overlap; the initial contract does not allocate tokens to resources.
- USG-008, Claude: take `file_path`, `path`, `pattern`, `notebook_path`, and `url` by name, and quoted or whitespace-delimited tokens that look like paths out of `command`; resolve relative paths against the line's `cwd`; normalize separators and, on Windows, case; match by prefix against configured roots.
- USG-008, Codex: take `command` and `workdir` from `shell_command`, quoted path tokens out of `exec` input, and `*** Update File:` and `*** Add File:` headers out of `apply_patch`; use `turn_context.cwd` only to resolve a relative path from those explicit arguments. Resource access itself receives no invented token allocation.
- Accounting: charge the request that consumed the result, never the one that issued the call. Call counts are exact. Token shares are estimates, shown as such, never summed into allowance; the unattributed remainder is displayed as such. Output tokens are never attributed to a resource.
- Cloud sessions: hooks would give `tool_input` and `cwd` with no token counts, and the VM holds no copy of a local vault unless it sits inside the repository, so the resource row is local-only in practice. The OTel `tool_result` event gives name, success, and result size, and the tool span gives `file_path` and `full_command` behind `OTEL_LOG_TOOL_DETAILS`, which is enough to classify once an OTLP receiver exists (P5). Codex cloud tasks expose nothing.
- Out of reach: whether the model used what it read; a script that opens vault files through code rather than a literal path; files reached through a symlink or junction outside the root. If an Obsidian MCP server is added later, the tool name alone carries the signal under `tool_detail`, but it does not cover the history that already exists.

## Reference points in the market

- `ccusage` groups local Claude Code usage by project with `--instances`, filters with `--project`, and warns on the five-hour block with `--token-limit`; it reads the same transcript store as P1.
- CodeBurn keys projects on the sanitized working-directory folder across about forty tools, classifies thirteen task categories from tool patterns and prompt keywords without model calls, and models a subscription plan so covered usage shows a net cost of zero.
- None of the local tools handle cloud sessions, and the ones that read Cursor's local database report counters that are not billed usage.
- Neither local tool attributes a tool call to the directory it touched. CodeBurn reads tool names as a task-category signal only, and `ccusage` reports no tool dimension.
