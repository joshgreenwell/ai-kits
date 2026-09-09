# agent-surface

Agent Control-Surface Diff. `agent-surface check --base main --head HEAD` tells a
reviewer, deterministically and offline, whether a change to repository-controlled
Claude Code configuration expands the control surface the agent gets once the
repository is trusted: new hooks, new MCP servers, whole-tool allows, additional
directories, mode changes.

Status: parsing (CS-A) and snapshot entries (CS-B). `snapshot` discovers, parses and
extracts every control-surface entry with a stable key; `diff` and `check` resolve both
sides, take both snapshots, and report the scan as incomplete until the keyed diff (CS-C)
lands.

## Entry keys

Every entry in a snapshot carries `kind`, `key`, `value`, `file`, `line`, `json_pointer`
and `source_sha` (the commit SHA the file was read at; `null` for a worktree read).
`breadth`, `direction` and `tier` are `unknown` / `unknown` / `unresolved` until the
interpretations (CS-C) classify them.

| kind | key | value |
| --- | --- | --- |
| `perm` | `perm:<allow\|ask\|deny>:<canonical rule>` | `{raw, rule, tool, spec, wildcard}` |
| `mode` | `mode:defaultMode`, `mode:disableBypassPermissionsMode` | `{raw}` |
| `hook` | `hook:<event>:<matcher>:<sha256(command)>` | `{event, matcher, type, command, prompt, timeout}`; one per hook command, recorded and hashed, never executed |
| `mcp` | `mcp:<server-name>` | `{transport, type_raw, command, args, url, env_keys, header_keys, extra}`; env and header values are never carried |
| `dir` | `dir:<path>` (from `permissions.additionalDirectories`) | `{raw, path}` |
| `sandbox` | `sandbox:<key>` | the value as written |
| `env_key` | `env_key:<NAME>` (from top-level `env`) | always `"<redacted>"` |
| `helper` | `helper:<apiKeyHelper\|awsAuthRefresh\|awsCredentialExport\|otelHeadersHelper>` | `{command}` |
| `plugin_flag` | `plugin_flag:<enabledPlugins\|enableAllProjectMcpServers\|disableAllHooks\|enabledMcpjsonServers\|disabledMcpjsonServers>` | as written; the two server lists carry `{raw, names}` |
| `unknown` | `unknown:<json_pointer>` | the value as written (redacted); any key the extractor does not model, never dropped |
| `credential` | `credential:<json_pointer>` | `"credential-like value present"`; the literal is replaced by `<redacted>` everywhere |

Rule strings are canonicalized so that a reformat never looks like a change
(`Bash(npm run:*)` and `Bash(npm run *)` share one key; `Bash(npm run)` is a different,
exact key); the decisions are in `docs/normalization.md`. The snapshot shape is documented
in `docs/snapshot.schema.json` (JSON Schema 2020-12). A saved snapshot is accepted
wherever a ref is; a file written by another `schema_version` is refused with exit 3.

Credential-like literals (`sk-…`, `AKIA…`, GitHub and Slack tokens, `Bearer …`, PEM
private keys, long opaque values under keys named like token/secret/key/password) are
detected by `src/redact.ts`, which every renderer reuses.

## What it answers

"What does this PR change about what the agent may do or run automatically?"

## What it does not answer

"What can Claude Code do right now on my laptop?" That is `/permissions`, `/doctor`,
and `/status`.

## Inputs (V0)

Read from Git blobs at each ref, or from a directory, or from a saved `snapshot.json`;
never from textual `git diff`:

- `.claude/settings.json`
- `.claude/settings.local.json`, only when tracked by Git (flagged as "local file
  shared via Git (trust-held by Claude Code)"; an untracked local file is ignored as
  not repository-controlled)
- `.mcp.json`
- hooks, read from inside the settings files

User settings (`~/.claude/settings.json`), managed settings, and `~/.claude.json` are
never read.

JSONC is accepted (comments, trailing commas). Duplicate keys at any depth are rejected
visibly as `incomplete` with both line numbers; the parser never picks last-wins.

## Never

- matcher reproduction
- "WITHOUT ASKING" headlines
- attack-chain findings
- MCP tool-description scanning
- skill / CLAUDE.md analysis
- risk scores
- execution of hooks, helpers, or MCP servers
- network access
- environment-variable expansion

Security posture: nothing is executed or expanded; inputs are limited to 1 MiB and a
nesting depth of 32; JSON objects are prototype-less so `__proto__` and `constructor`
keys are plain data; worktree reads are symlink-aware and refuse links that leave the
repository root; permission errors are reported as `incomplete`, never as "clean".
Only `git show`, `git rev-parse`, and `git ls-files` are ever spawned, always as an
argument array and never through a shell.

## Usage

```
agent-surface snapshot [path] [--json]
agent-surface diff  --base <ref> --head <ref|path|snapshot.json> [--json]
agent-surface check --base <ref> --head <ref> [--fail-on <categories>] [--strict] [--json]
agent-surface explain <ID>
```

Exit codes:

| code | meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | no change, or narrowing only                                           |
| 1    | proven expansion in a failing category                                 |
| 2    | unresolved-only or projected-only changes (`--strict` turns this into 1) |
| 3    | scan incomplete (unparseable, duplicate keys, missing ref)             |
| 64   | usage error                                                            |

`incomplete` always wins: a scan that could not read or parse its inputs exits 3 even
when other findings are present.

## Development

```
npm ci
npm run lint   # tsc --noEmit
npm test       # tsc, then node --test on the compiled tests
```

Node 20 or newer. No runtime dependencies.
