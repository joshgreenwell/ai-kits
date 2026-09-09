# agent-surface

Agent Control-Surface Diff. `agent-surface check --base main --head HEAD` tells a
reviewer, deterministically and offline, whether a change to repository-controlled
Claude Code configuration expands the control surface the agent gets once the
repository is trusted: new hooks, new MCP servers, whole-tool allows, additional
directories, mode changes.

Status: skeleton and parsing (CS-A). `snapshot` discovers and parses the supported
files; `diff` and `check` resolve both sides and report the scan as incomplete until
entry extraction (CS-B) and the diff (CS-C) land.

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
