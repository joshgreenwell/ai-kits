# agent-surface

Agent Control-Surface Diff. `agent-surface check --base main --head HEAD` tells a
reviewer, deterministically and offline, whether a change to repository-controlled
Claude Code configuration expands the control surface the agent gets once the
repository is trusted: new hooks, new MCP servers, whole-tool allows, additional
directories, mode changes.

Status: parsing (CS-A), snapshot entries (CS-B), keyed diff, interpretations and verdict
(CS-C). `snapshot` discovers, parses and extracts every control-surface entry with a stable
key; `diff` and `check` resolve both sides, take both snapshots, run the keyed diff with the
direction table and the closed interpretation list, and exit with the verdict. Text output
is provisional (one line per delta) until the renderers (CS-D) land; `--json` already
emits the full `Diff`.

## Entry keys

Every entry in a snapshot carries `kind`, `key`, `value`, `file`, `line`, `json_pointer`
and `source_sha` (the commit SHA the file was read at; `null` for a worktree read).
`breadth`, `direction` and `tier` are `unknown` / `unknown` / `unresolved` until the
interpretations (CS-C) classify them.

| kind | key | value |
| --- | --- | --- |
| `perm` | `perm:<allow\|ask\|deny>:<canonical rule>` | `{raw, rule, tool, spec, wildcard}` |
| `mode` | `mode:defaultMode`, `mode:disableBypassPermissionsMode` | `{raw, mode}` (`mode` repeats the value so a mode change survives the `raw`-free comparison) |
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
| 0    | no change, or narrowing / neutral / annotate-only changes              |
| 1    | proven expansion in a failing category (also: projected widening with `--fail-on projected`; undecided delta with `--strict`) |
| 2    | undecided deltas only: tier not proven (unresolved, or a projected claim such as a shadowed rule) or breadth unresolved (`Bash(git * main)`); pass with annotation, `--strict` turns this into 1 |
| 3    | scan incomplete (unparseable, duplicate keys, missing ref)             |
| 64   | usage error                                                            |

`incomplete` always wins: a scan that could not read or parse its inputs exits 3 even
when a proven expansion is also present; both are printed. `summary.expands` is true
only when at least one `proven` delta with direction `widens` sits in a failing category.
`diff` exits with the same code as `check` (with the default options).

### Default failing categories

`hook` (new hook or changed hook command), `mcp` (new server, changed transport, or
`enableAllProjectMcpServers` → true), `mode` (`defaultMode` → `bypassPermissions` /
`auto` / `dontAsk`), `whole-tool-allow` (`Bash`, `Bash(*)`, `Read`, …), `directory`
(`additionalDirectories` added), `hooks-reenabled` (`disableAllHooks` true → false),
`deny-removed`. `scoped-allow` (`Bash(npm test)`, `Bash(npm run *)`) is annotate-only by
default.

`--fail-on <a,b,…>` replaces that set with the named categories. `projected` may be
added to fail on projected widenings as well (`Bash(npm run *)` widens on a projected
prefix breadth); naming only `projected` keeps the default categories. `--strict` turns
exit 2 into exit 1.

Example GitHub Actions step:

```yaml
- run: npx agent-surface check --base origin/main --head HEAD
```

### Closed interpretation list (`semantics_doc_date: 2026-09-07`)

Generated in full, with direction rules, categories and flags, in
`docs/interpretations.md` (`npm run docs`); every ID is printed by
`agent-surface explain <ID>`.

| ID | Interpretation | Tier |
| --- | --- | --- |
| `I1` | Rule-string shadowing: the same normalized string in `deny` shadows `ask`/`allow`, in `ask` shadows `allow` (deny → ask → allow, first match); a shadowed rule is neutral | projected |
| `I2` | `Bash` / `Bash(*)` (any bare tool name or `Tool(*)`) is whole-tool; `Bash(...)` is scoped | proven |
| `I3` | Trailing wildcard `x *` / `x:*` = prefix (projected); none = exact (proven); other placement = glob with unresolved breadth | projected |
| `I4` | Wildcard before a subcommand (`Bash(git * main)`) flagged `broad` | projected |
| `I5` | `defaultMode`: only `bypassPermissions`, `auto`, `dontAsk` widen; `dontAsk` is not allow-everything; an unknown value never widens | proven |
| `I6` | Hook presence per event and matcher; command recorded, never executed | proven |
| `I7` | MCP transport: literal `http://` to a non-loopback host = plaintext; loopback and `https://` proven; `${VAR}` URLs unresolved | proven / unresolved |
| `I8` | Ignored shapes (`Write(path)`, `NotebookEdit(path)`, `Glob(path)`, `MultiEdit(path)`, `mcp__…(…)`, unanchored allow globs like `Read(*.env)`) flagged `ignored_by_claude_code`, neutral | proven |

Explicitly not interpreted (each yields `unresolved` with a note naming the item):
compound-command splitting (`&&`, `;`, `|`), wrapper stripping (`sudo`, `env`, `time`,
`xargs`), env-assignment stripping (`FOO=bar cmd`), path anchoring (`/`, `//`, `~`),
depth semantics, symlink pairing, redirect checks (`>`), plugin-provided hooks/servers
(`enabledPlugins`), skill `allowed-tools` and subagent frontmatter (the last two are not
V0 inputs and produce no entry at all). Anything outside the list is `unresolved`.

Direction rules (`D-allow-added`, `D-deny-removed`, `D-mode-widened`, `D-moved`, …) are
listed in `docs/interpretations.md`; a delta's `rule` field names the one that fired.

Maintenance: interpretations are re-checked against the Claude Code documentation; each
change is a `META` edit plus a fixture under `fixtures/diff/`, dated in the CHANGELOG.

## Diff shape (`--json`)

`{schema_version, semantics_doc_date, base, head, added[], removed[], changed[],
unresolved[], incomplete[], summary}`. `base` / `head` carry `sha`, `origin`, `sources`,
`assumptions` and `incomplete`. Each delta is
`{key, kind, change, base, head, direction, tier, breadth, breadth_tier, category, rule,
interpretations, flags, notes}` where `change` is `added` / `removed` / `changed` /
`moved` (same key and value, different file), `tier` is the confidence of the direction
claim and `breadth_tier` that of the breadth claim. A delta appears in exactly one list;
`unresolved[]` holds every delta the tool could not decide. `changed[]` never contains a
reformat: values are compared through `semanticEntry` (`docs/normalization.md`).
`summary` is `{expands, categories, verdict, exit_code, fail_on, strict, reasons}`.

## Development

```
npm ci
npm run lint   # tsc --noEmit
npm test       # tsc, then node --test on the compiled tests
npm run docs   # regenerate docs/interpretations.md from the metadata
```

Node 20 or newer. No runtime dependencies.
