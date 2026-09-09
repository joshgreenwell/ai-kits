# agent-surface

Agent Control-Surface Diff. `agent-surface check --base main --head HEAD` tells a reviewer,
deterministically and offline, whether a change to repository-controlled Claude Code
configuration expands the control surface the agent gets once the repository is trusted:
new hooks, new MCP servers, whole-tool allows, additional directories, mode changes.

It reads Git blobs at two refs (never a textual `git diff`), parses the JSONC, turns every
setting into a keyed entry, diffs the keys, classifies each difference against a closed,
dated list of documented Claude Code semantics, and exits with a code a CI job can act on.
It never executes anything, never touches the network, never expands environment
variables, and never renders an incomplete scan as clean.

## What it answers

"What does this PR change about what the agent may do or run automatically?"

## What it does not answer

"What can Claude Code do right now on my laptop?" That is machine state, and Claude Code
reports it directly: `/permissions` (the effective rules and mode), `/doctor` (installation
and configuration health), and `/status` (the active configuration sources). agent-surface
looks only at what the repository controls, between two points in its history.

## Quick start

```
npx agent-surface check --base origin/main --head HEAD
```

Example GitHub Actions step (plain `npx`; no wrapper action in V0). `fetch-depth: 0` is
required so that `origin/main` exists in the checkout:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx agent-surface check --base origin/main --head HEAD
```

The step fails (exit 1) on a proven expansion in a failing category, passes (exit 0) on
no change or narrowing, and exits 2 on changes the tool cannot decide (add `--strict` to
fail on those too). Exit 3 means the scan is incomplete and must be looked at.

## Output

```
CONTROL-SURFACE DIFF  base=<sha> head=<sha>
Assumptions
  Semantics doc date     2026-09-07
  Scope                  repository-controlled files only
  Workspace trust        assumed accepted (allow rules/dirs are held until then)
  Runtime mode           per defaultMode in head; CLI flags not modeled
  Sandbox                not modeled
  Hooks                  presence only; decisions not modeled
  Managed/user/local     not read
  Plugins                not modeled (flagged if enabledPlugins non-empty)
EXPANDED
  hooks
    added   hook        hook:PreToolUse:Bash:<sha256>  widens proven  .claude/settings.json:19
              I6: command hook on PreToolUse for matcher "Bash"; command recorded, never executed
verdict: expands (exit 1); expands=true; categories=hook
  - expands (hook): hook:PreToolUse:Bash:<sha256> added (proven widens)
```

Sections appear in the order `INCOMPLETE` (first, whenever anything could not be read or
parsed) → `EXPANDED` (widening changes, grouped by kind: hooks, MCP, permissions,
directories, mode, flags) → `NARROWED` → `CHANGED` (neutral changes and moves) →
`UNRESOLVED` (changes the tool could not decide). Empty sections are omitted. Each line
shows the change, the kind, the stable key, the direction, the confidence tier, the
breadth (permission rules only), any flags, and `file:line`. Credential-like values are
reported as "credential-like value present" with the literal replaced by `<redacted>` in
every renderer. `--json` prints the full `Diff` (see below) with sorted keys; two runs on
identical input are byte-identical.

## The assumptions header

The eight lines are printed exactly once, on every diff and snapshot, and stored in the
JSON as `assumptions[]`. Each states something the verdict depends on and the tool does
not check:

| Line | Meaning |
| --- | --- |
| `Semantics doc date` | `2026-09-07`: the date of the Claude Code documentation every interpretation was checked against. It is the `semantics_doc_date` in every snapshot and diff; when the docs change, the list is re-checked and the date moves (see Maintenance). |
| `Scope` | repository-controlled files only: `.claude/settings.json`, a tracked `.claude/settings.local.json`, and `.mcp.json`. Nothing else is read. |
| `Workspace trust` | assumed accepted (allow rules/dirs are held until then): Claude Code holds repository allow rules and additional directories until the user trusts the workspace. The diff describes what applies *after* that step. |
| `Runtime mode` | per defaultMode in head; CLI flags not modeled: the effective permission mode is taken from `permissions.defaultMode` as written in head. `--permission-mode`, `--dangerously-skip-permissions` and similar flags are not visible to the tool. |
| `Sandbox` | not modeled: sandbox settings are recorded as entries (`sandbox:` keys) so a change is visible, but no claim is made about what a sandbox does or does not block. |
| `Hooks` | presence only; decisions not modeled: a hook is reported when it exists for an event and matcher, and its command is recorded and hashed. What the command does, and what a hook decides at run time, is never evaluated. |
| `Managed/user/local` | not read: managed (enterprise) settings, user settings (`~/.claude/settings.json`), `~/.claude.json`, and an *untracked* `settings.local.json` are never read, so the real effective configuration on a machine may be wider or narrower than the repository's. |
| `Plugins` | not modeled (flagged if enabledPlugins non-empty): hooks and servers a plugin provides are invisible. A non-empty `enabledPlugins` adds a `Flagged` line to the header and an unresolved delta when it changes. |

Two further `Flagged` lines can follow: a tracked `settings.local.json` ("local file shared
via Git (trust-held by Claude Code)") and a non-empty `enabledPlugins`.

## Exit codes

| code | meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | no change, or narrowing / neutral / annotate-only changes              |
| 1    | proven expansion in a failing category (also: projected widening with `--fail-on projected`; undecided delta with `--strict`) |
| 2    | undecided deltas only: tier not proven (unresolved, or a projected claim such as a shadowed rule) or breadth unresolved (`Bash(git * main)`); pass with annotation, `--strict` turns this into 1 |
| 3    | scan incomplete (unparseable, duplicate keys, missing ref, unreadable file); always wins, expansions are still printed |
| 64   | usage error                                                            |

`incomplete` always wins: a scan that could not read or parse its inputs exits 3 even
when a proven expansion is also present; both are printed, and the text output never says
"no changes". `summary.expands` is true only when at least one `proven` delta with
direction `widens` sits in a failing category. `diff` exits with the same code as `check`
(with the default options).

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

## Usage

```
agent-surface snapshot [path] [--json]
agent-surface diff  --base <ref> --head <ref|path|snapshot.json> [--json]
agent-surface check --base <ref> --head <ref> [--fail-on <categories>] [--strict] [--json]
agent-surface explain <ID>
```

Either side may be a ref, a directory (worktree), or a saved `snapshot.json`. When neither
side carries any supported file the tool prints the header and
"no repository-controlled agent configuration found" and exits 0.

## Inputs (V0)

Read from Git blobs at each ref, or from a directory, or from a saved `snapshot.json`;
never from textual `git diff`:

- `.claude/settings.json`
- `.claude/settings.local.json`, only when tracked by Git (flagged as "local file
  shared via Git (trust-held by Claude Code)"; an untracked local file is ignored as
  not repository-controlled)
- `.mcp.json`
- hooks, read from inside the settings files

JSONC is accepted (comments, trailing commas). Duplicate keys at any depth are rejected
visibly as `incomplete` with both line numbers; the parser never picks last-wins.

## Closed interpretation list (`semantics_doc_date: 2026-09-07`)

Generated in full, with direction rules, categories and flags, in
`docs/interpretations.md`; every ID, with the facts `agent-surface explain <ID>` prints,
is in `docs/explain.md` (both from `npm run docs`).

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

## Never

- matcher reproduction (the tool does not re-implement Claude Code's permission matcher)
- "WITHOUT ASKING" headlines
- attack-chain findings
- MCP tool-description scanning
- skill / CLAUDE.md analysis
- risk scores
- execution of hooks, helpers, or MCP servers
- network access
- environment-variable expansion

Security posture (details and the disclosure process in `SECURITY.md`): nothing is
executed or expanded; inputs are limited to 1 MiB and a nesting depth of 32; JSON objects
are prototype-less so `__proto__` and `constructor` keys are plain data; worktree reads
are symlink-aware and refuse links that leave the repository root; permission errors are
reported as `incomplete`, never as "clean". Only `git show`, `git rev-parse`, and
`git ls-files` are ever spawned, always as an argument array and never through a shell.
The test suite runs the whole golden fixture set with `child_process` and every network
entry point monkeypatched to fail.

## Maintenance

Interpretations are re-checked against the Claude Code documentation with each change to
the list. Every change is a table entry (the interpretation's `META`, from which
`docs/interpretations.md` and `docs/explain.md` are generated) plus a fixture under
`fixtures/diff/` or `fixtures/golden/`, and a dated entry in `CHANGELOG.md` that names the
interpretation and the documentation date it was checked against. The `semantics_doc_date`
carried by every snapshot and diff is that date, so an old output can always be matched
to the semantics it was produced under.

## Entry keys

Every entry in a snapshot carries `kind`, `key`, `value`, `file`, `line`, `json_pointer`
and `source_sha` (the commit SHA the file was read at; `null` for a worktree read).
`breadth`, `direction` and `tier` are `unknown` / `unknown` / `unresolved` in a snapshot;
the diff classifies the deltas.

| kind | key | value |
| --- | --- | --- |
| `perm` | `perm:<allow\|ask\|deny>:<canonical rule>` | `{raw, rule, tool, spec, wildcard}` |
| `mode` | `mode:defaultMode`, `mode:disableBypassPermissionsMode` | `{raw, mode}` |
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

## Diff shape (`--json`)

`{command, schema_version, semantics_doc_date, base, head, added[], removed[], changed[],
unresolved[], incomplete[], summary}`. `base` / `head` carry `sha`, `origin`, `sources`,
`assumptions` and `incomplete`. Each delta is
`{key, kind, change, base, head, direction, tier, breadth, breadth_tier, category, rule,
interpretations, flags, notes}` where `change` is `added` / `removed` / `changed` /
`moved` (same key and value, different file), `tier` is the confidence of the direction
claim and `breadth_tier` that of the breadth claim. A delta appears in exactly one list;
`unresolved[]` holds every delta the tool could not decide. `changed[]` never contains a
reformat: values are compared through `semanticEntry` (`docs/normalization.md`).
`summary` is `{expands, categories, verdict, exit_code, fail_on, strict, reasons}`.
Keys are sorted recursively and every list is sorted by key, so output is
byte-deterministic. The golden suite under `fixtures/golden/` pins the exact output of
every required case (`fixtures/golden/README.md` documents the placeholder rule for
commit SHAs).

## Development

```
npm ci
npm run lint    # tsc --noEmit
npm test        # tsc, then node --test on the compiled tests
npm run docs    # regenerate docs/interpretations.md and docs/explain.md from the metadata
npm run golden  # regenerate fixtures/golden/**/expected.* (review the diff; it is the spec)
```

Node 20 or newer. No runtime dependencies. Releases are tagged `agent-surface-v<version>`
and published by CI with npm provenance (`.github/workflows/agent-surface.yml`).
