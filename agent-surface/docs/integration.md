# Integrating `agent-surface`

A task-oriented guide for adding `agent-surface` to an existing repository: run it from a
local checkout today, wire it into CI, choose a failing policy, and read what it prints.

Every command below was executed against a scratch repository built from the golden
fixtures in this package, and the output is pasted as it came back. Conventions used in
that output, once: commit SHAs and hook hashes are shortened, paths under the home
directory are written `~/…`, and elided text — long absolute paths, unchanged lines — is
marked `…`. Nothing else is edited.

## 1. What you get, and what you must not expect

- `agent-surface` reports what a **change** does to **repository-controlled** Claude Code
  configuration: what the agent may do or run automatically once the workspace is trusted.
- The V0 inputs are exactly three files: `.claude/settings.json`, a **tracked**
  `.claude/settings.local.json`, and `.mcp.json` (hooks are read from inside the settings
  files). Nothing else is opened.
- It does **not** report what Claude Code can do on a given laptop right now. That is
  machine state, and Claude Code answers it directly: `/permissions` for the effective
  rules and mode, `/doctor` for installation and configuration health, `/status` for the
  active configuration sources.
- It does not model the sandbox, plugin-provided hooks and servers, CLI flags such as
  `--permission-mode`, or managed/user settings, and it never reproduces Claude Code's
  permission matcher. The assumptions header prints these limits on every run.
- Claims are tiered. Only a `proven` widening in a failing category can fail a build; see
  §4 and §8.

## 2. Run it from a local checkout (before the npm release)

`agent-surface` is not published to npm yet, so the first-class path is a local checkout —
a git submodule, a vendored copy, or a sibling clone. Node 20 or newer and `git` on `PATH`
are the only requirements; the package has **zero runtime dependencies** (its two
dev-dependencies are TypeScript and `@types/node`, needed only to build it).

Build it once. `npm --prefix` keeps you in your own repository while installing and
building in the checkout:

<!-- verify:cli -->
```console
npm --prefix ~/tools/ai-kits/agent-surface ci
npm --prefix ~/tools/ai-kits/agent-surface run build
```

```text
added 3 packages, and audited 4 packages in 541ms

found 0 vulnerabilities

> agent-surface@0.0.1 build
> tsc -p tsconfig.json
```

Then invoke the compiled entry point from inside the repository you want to check. `node`
runs `dist/src/cli.js` directly; there is no install step in your repository and nothing is
added to your `package.json`:

<!-- verify:cli -->
```console
node ~/tools/ai-kits/agent-surface/dist/src/cli.js --version
node ~/tools/ai-kits/agent-surface/dist/src/cli.js check --base origin/main --head HEAD
```

The first prints `0.0.1`. The second is the real check; its output is walked through in §3.

### The packed-tarball route

If you would rather pin a single artifact than a checkout — for an air-gapped runner, or to
hand one file to another team — pack it and run the tarball. This is exactly how the
published package will behave, so it is also the best rehearsal for the npm release:

<!-- verify:cli -->
```console
npm pack ~/tools/ai-kits/agent-surface --pack-destination .
npx --yes ./agent-surface-0.0.1.tgz check --base origin/main --head HEAD
```

```text
npm notice package: agent-surface@0.0.1
…
npm notice filename: agent-surface-0.0.1.tgz
npm notice package size: 78.6 kB
npm notice total files: 71
agent-surface-0.0.1.tgz
```

`npm pack` takes the package **folder** as an argument. `npm --prefix <folder> pack` does
not work: `pack` still reads `package.json` from the current directory and fails with
`ENOENT … /package.json` in a repository that has none.

The `-p` spelling names the package and then the binary, which is what `npx agent-surface`
will do after publication:

<!-- verify:cli -->
```console
npx --yes -p ./agent-surface-0.0.1.tgz agent-surface check --base origin/main --head HEAD
```

### Known gotcha: `npx --yes ./x.tgz agent-surface check` exits 64

Without `-p`, the token after the tarball is passed to the tarball's own binary as its
first argument. `agent-surface` then sees `agent-surface` where it expects a subcommand:

<!-- verify:cli-invalid -->
```console
npx --yes ./agent-surface-0.0.1.tgz agent-surface check --base origin/main --head HEAD
```

```text
unknown subcommand 'agent-surface'
Usage: agent-surface <subcommand> [options]
…
```

That exits **64** (usage error), which is deliberately outside the verdict range, so a CI
job cannot mistake it for "clean". The two forms that do work are the two above:

- `npx --yes ./agent-surface-0.0.1.tgz check …` — tarball, then the subcommand.
- `npx --yes -p ./agent-surface-0.0.1.tgz agent-surface check …` — `-p` names the package,
  then the binary, then the subcommand.

## 3. First run on a real repository

The scratch repository used here is an ordinary two-commit repository: `origin/main` holds
a `.claude/settings.json` with one scoped allow and one deny, and the branch under review
adds a `PreToolUse` hook for `Bash` (content taken verbatim from
`fixtures/golden/add-hook/`). From inside that repository:

<!-- verify:cli -->
```console
node ~/tools/ai-kits/agent-surface/dist/src/cli.js check --base origin/main --head HEAD
```

```text
CONTROL-SURFACE DIFF  base=493fc872032c head=b78785dc7bec
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
    added   hook        hook:PreToolUse:Bash:faf748c4921f62d3…  widens proven  .claude/settings.json:19
              I6: command hook on PreToolUse for matcher "Bash"; command recorded, never executed
verdict: expands (exit 1); expands=true; categories=hook
  - expands (hook): hook:PreToolUse:Bash:faf748c4921f62d3… added (proven widens)
```

Reading it, top to bottom:

**The title line** names the two sides by commit SHA, so an output can always be tied back
to what it was produced from. A worktree side prints `worktree:<path>` instead, and a saved
snapshot prints the SHA recorded inside it.

**The assumptions header** is eight fixed lines, printed on every diff and snapshot. Each
states something the verdict depends on and the tool does **not** check — that the
workspace is trusted, that the runtime mode is whatever `defaultMode` says in head, that
managed/user/untracked-local settings were never read, and so on. It is the honest fine
print: a reviewer who disagrees with one of these lines should not trust the verdict.
Extra `Flagged (head)` lines can follow it — a tracked `settings.local.json`, or a
non-empty `enabledPlugins`.

**The `EXPANDED` section** lists the widening changes, grouped by kind (hooks, MCP,
permissions, directories, mode, flags). This delta reads: a `hook` entry was **added**; its
stable key is `hook:<event>:<matcher>:<sha256 of the command>`; the direction is `widens`
and the tier is `proven`; it lives at `.claude/settings.json:19`. The indented line is the
interpretation that fired — `I6`, hook presence. The command itself is hashed into the key
and recorded, never executed and never printed as something the tool ran.

Other sections appear in a fixed order when they are non-empty: `INCOMPLETE` first
(anything unreadable or unparseable), then `EXPANDED`, `NARROWED`, `CHANGED` (neutral
changes and moves), and `UNRESOLVED` (changes the tool could not decide). Empty sections
are omitted.

**The verdict line** is the machine-readable summary: the label, the exit code,
`expands=true|false`, and the categories that any widening delta landed in. The lines under
it are the reasons, one per delta or incomplete record.

**What a reviewer does with it.** `EXPANDED` is the part that needs a human: for each line,
decide whether the repository *should* grant that. A hook runs automatically on an event,
so ask what the command does — `agent-surface` will not tell you, by design. `UNRESOLVED`
means the tool declined to guess; treat those as "read the diff yourself". `NARROWED` and
`CHANGED` are informational. `INCOMPLETE` means the scan did not see everything, so no
section below it is trustworthy.

`diff` prints the same report with the same exit code and no policy flags; use it when you
want the report without thinking about `--fail-on`. `--json` on either prints the whole
structure with sorted keys, byte-identical between runs on identical input.

## 4. Exit codes and choosing a policy

<!-- verify:exit-codes:start -->

| code | meaning | what it means for a build |
| ---- | ------- | ------------------------- |
| 0 | no change, or narrowing / neutral / annotate-only changes | pass |
| 1 | proven expansion in a failing category (also: a projected widening under `--fail-on projected`, or any undecided delta under `--strict`) | fail |
| 2 | undecided deltas only — tier not `proven`, or breadth unresolved | pass with annotation; `--strict` turns this into 1 |
| 3 | scan incomplete: unparseable input, duplicate keys, a missing ref, a permission error, an oversized file | fail, and fix the input |
| 64 | usage error (unknown subcommand, unknown flag, unknown `--fail-on` category) | fail; never a verdict |

<!-- verify:exit-codes:end -->

`incomplete` always wins. A scan that could not read or parse its inputs exits 3 even when
a proven expansion is also present; both are printed, and the text output never says "no
changes". Never treat 3 as a flake to retry.

### The default failing categories

A widening delta carries exactly one category. These fail by default: `hook`, `mcp`,
`mode`, `whole-tool-allow`, `directory`, `hooks-reenabled`, `deny-removed`. The eighth
category, `scoped-allow`, is annotate-only: it is printed under `EXPANDED` but does not
change the exit code.

The split is deliberate. The seven default categories each hand the agent a capability it
did not have — a command that runs automatically, a server it may talk to, a mode that
stops asking, a whole tool, a new directory, every hook back on, or one fewer block. A
scoped allow (`Bash(npm test *)`) grants one narrow thing and is the ordinary traffic of a
healthy repository, so failing on it by default would train people to ignore the job.

Here is the same scoped allow with and without the category named. Either side of `check`
may be a ref, a directory, or a saved snapshot, so these two runs point straight at the
golden fixtures in the checkout and need no repository at all. Default:

<!-- verify:cli -->
```console
node ~/tools/ai-kits/agent-surface/dist/src/cli.js check \
  --base ~/tools/ai-kits/agent-surface/fixtures/golden/add-allow-scoped/base \
  --head ~/tools/ai-kits/agent-surface/fixtures/golden/add-allow-scoped/head
```

```text
CONTROL-SURFACE DIFF  base=worktree:…/add-allow-scoped/base head=worktree:…/add-allow-scoped/head
…
EXPANDED
  permissions
    added   perm        perm:allow:Bash(npm test *)  widens proven prefix  .claude/settings.json:9
              I2: Bash(npm test *) is scoped to its spec, not the whole tool
              I3: trailing wildcard; matches commands starting with "npm test" (prefix, projected)
verdict: pass (exit 0); expands=false; categories=scoped-allow
  - widening changes are annotate-only under the effective --fail-on set
```

With `--fail-on scoped-allow` the same input fails:

<!-- verify:cli -->
```console
node ~/tools/ai-kits/agent-surface/dist/src/cli.js check \
  --base ~/tools/ai-kits/agent-surface/fixtures/golden/add-allow-scoped/base \
  --head ~/tools/ai-kits/agent-surface/fixtures/golden/add-allow-scoped/head \
  --fail-on scoped-allow
```

```text
verdict: expands (exit 1); expands=true; categories=scoped-allow
  - expands (scoped-allow): perm:allow:Bash(npm test *) added (proven widens, breadth prefix)
```

**When to add `--fail-on scoped-allow`.** When the repository's `allow` list is the security
boundary you actually care about — a repository where agents run against production
credentials, or one whose `allow` list is reviewed by a different team than the code. Note
that `--fail-on` **replaces** the default set, so name the whole policy:
`--fail-on hook,mcp,mode,whole-tool-allow,directory,hooks-reenabled,deny-removed,scoped-allow`.
The one exception is `projected`, which is a pseudo-category: naming only `projected` keeps
the default categories and additionally fails on projected widenings such as a prefix rule.

**When `--strict` is right.** `--strict` turns exit 2 into exit 1, so every undecided delta
— an unresolved tier, a projected claim, or an unresolved breadth like `Bash(git * main)` —
fails the build:

<!-- verify:cli -->
```console
node ~/tools/ai-kits/agent-surface/dist/src/cli.js check \
  --base ~/tools/ai-kits/agent-surface/fixtures/golden/enabled-plugins/base \
  --head ~/tools/ai-kits/agent-surface/fixtures/golden/enabled-plugins/head \
  --strict
```

```text
no verdict derived: every change (1) is unresolved; nothing is proven either way
verdict: undecided (exit 1); expands=false; categories=none
  - undecided: plugin_flag:enabledPlugins changed (unresolved unknown)
  - strict: undecided deltas fail
```

That is the right setting when a human must sign off on anything the tool cannot decide —
a repository where the configuration is meant to be frozen, or a release branch. It is the
wrong setting for a busy repository that has not yet cleaned up its glob rules, because
undecided is common and the failure carries no verdict to argue with.

**Recommended starting policy for a team adopting it:** the defaults — no `--fail-on`, no
`--strict` — with the text output published into the job summary (§5). The build then fails
only on a `proven` widening in a category that hands the agent a new capability, which is
the smallest claim the tool makes and the hardest to argue with; exit 2 keeps everything
undecided visible on the PR without blocking it; and exit 3 forces the input to be fixed
rather than silently skipped. Tighten later, once the job has a track record: add
`scoped-allow` when the allow list matters, add `--strict` when the undecided lines have
stopped being routine.

## 5. Wire it into CI

The job below assumes the checkout lives at `tools/ai-kits` (a git submodule or a vendored
copy). `fetch-depth: 0` is the load-bearing line: the default checkout is shallow and
single-branch, so `origin/<base branch>` is simply not present, and `agent-surface` reports
a missing ref as `incomplete` and exits 3 rather than guessing. `--base origin/${{ github.base_ref }}`
compares the PR against the branch it targets.

<!-- verify:cli -->
```yaml
name: agent-surface
on: pull_request

jobs:
  control-surface:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          submodules: true
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Build agent-surface from the local checkout
        run: |
          npm --prefix tools/ai-kits/agent-surface ci
          npm --prefix tools/ai-kits/agent-surface run build
      - name: Check the control surface
        shell: bash
        run: |
          node tools/ai-kits/agent-surface/dist/src/cli.js check \
            --base "origin/${{ github.base_ref }}" --head HEAD | tee surface.txt
      - name: Publish the report
        if: always()
        shell: bash
        run: |
          {
            echo '## Control-surface diff'
            echo '```text'
            cat surface.txt
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
```

`shell: bash` matters on the check step: it turns on `pipefail`, so `| tee` does not swallow
the tool's exit code. The publish step runs under `if: always()` so the report reaches the
job summary on exit 1 and exit 3 as well as on a pass. (Both steps were rehearsed locally
against the scratch repository: with `set -o pipefail` the pipeline still exits 1, and the
heredoc-free block appends a fenced report to `$GITHUB_STEP_SUMMARY`.)

Once the package is published to npm, the build step disappears. This is the only block on
this page that could not be executed while writing it — the package is unpublished, so
`npx agent-surface` has nothing to resolve; the `-p ./agent-surface-0.0.1.tgz` form in §2 is
the rehearsal for it.

<!-- verify:cli -->
```yaml
      - name: Check the control surface   # once published
        shell: bash
        run: |
          npx agent-surface check \
            --base "origin/${{ github.base_ref }}" --head HEAD | tee surface.txt
```

## 6. Use it locally, and in a pre-commit hook

The one-liner to run before pushing — the same comparison CI will make:

<!-- verify:cli -->
```console
node ~/tools/ai-kits/agent-surface/dist/src/cli.js check --base origin/main --head HEAD
```

A pre-commit hook is worth it only if it costs nothing on an ordinary commit, so gate it on
the three supported files. `.git/hooks/pre-commit`:

<!-- verify:cli -->
```sh
#!/bin/sh
# Refuse a commit that expands the control surface. Exits early unless one of
# the three supported files is staged, so an ordinary commit costs nothing.
set -e
git diff --cached --name-only --diff-filter=ACMR |
  grep -qE '^(\.claude/settings(\.local)?\.json|\.mcp\.json)$' || exit 0
exec node "$HOME/tools/ai-kits/agent-surface/dist/src/cli.js" check --base HEAD --head .
```

`--head .` is the working tree, not the index, so the hook sees unstaged edits to those
files too — the safer direction for a hook whose job is to stop a surprise. A commit that
touches only source files passes straight through; one that adds an
`additionalDirectories` entry is refused:

```text
EXPANDED
  directories
    added   dir         dir:../shared-libs  widens proven  .claude/settings.json:14
verdict: expands (exit 1); expands=true; categories=directory
  - expands (directory): dir:../shared-libs added (proven widens)
```

Use `git commit --no-verify` to override deliberately; the CI job is the backstop.

## 7. Snapshots as a baseline

`snapshot --json` writes the parsed control surface of one side as a file. It is the
answer to "what did we agree to?": commit the snapshot once, and every later run can be
compared against that agreed baseline instead of against a moving branch. A saved snapshot
is accepted **anywhere a ref is accepted**, on either side.

<!-- verify:cli -->
```console
mkdir -p .agent-surface
node ~/tools/ai-kits/agent-surface/dist/src/cli.js snapshot origin/main
node ~/tools/ai-kits/agent-surface/dist/src/cli.js snapshot origin/main --json > .agent-surface/baseline.json
node ~/tools/ai-kits/agent-surface/dist/src/cli.js check --base .agent-surface/baseline.json --head HEAD
```

The text form is a readable inventory — sources, then every entry with its key and
location:

```text
CONTROL-SURFACE SNAPSHOT  origin=git spec=origin/main sha=493fc872032c
Assumptions
  Semantics doc date     2026-09-07
  …
SOURCES
  .claude/settings.json          read; blob 27fe77cca0d8
  .claude/settings.local.json    absent
  .mcp.json                      absent
ENTRIES (2)
  perm        perm:allow:Bash(npm test)  .claude/settings.json:8
  perm        perm:deny:Bash(curl *)  .claude/settings.json:11
```

Checking `HEAD` against the saved baseline gives exactly the verdict the ref-to-ref run
gave, and the title line carries the SHA recorded inside the snapshot:

```text
CONTROL-SURFACE DIFF  base=493fc872032c head=b78785dc7bec
…
verdict: expands (exit 1); expands=true; categories=hook
  - expands (hook): hook:PreToolUse:Bash:faf748c4921f62d3… added (proven widens)
```

**The schema-version guard.** A snapshot carries `schema_version`. A file written by a
different one is refused outright rather than half-read — it exits 3 with a message that
tells you how to regenerate it (one line on stderr, wrapped here):

```text
incomplete: …/schema-mismatch.json: snapshot schema_version mismatch: file has
schema_version 99, this version of agent-surface reads schema_version 1; re-run
'agent-surface snapshot --json' with this version
```

Every snapshot also carries `semantics_doc_date`, so an old baseline can always be matched
to the interpretation list it was produced under.

## 8. Reading the interpretations

Every classified delta names the interpretation that fired (`I6:` in §3). `explain <ID>`
prints the documented facts behind it, offline:

<!-- verify:cli -->
```console
node ~/tools/ai-kits/agent-surface/dist/src/cli.js explain I6
```

```text
I6  Hook presence per event and matcher
  kind: interpretation
  tier: proven
  doc section: Hooks reference > Configuration
  semantics doc date: 2026-09-07
  summary: A hook under hooks.<event>[].hooks[] runs automatically for that event and matcher; the command is recorded and hashed, never executed.

  Hooks are configured per event (PreToolUse, PostToolUse, Stop, …) with an optional matcher regular expression over tool names; …
```

The same command accepts more than the eight interpretations. Running `explain` with no ID
lists everything it knows:

- `I1`–`I8` — the closed interpretation list (shadowing, whole-tool vs scoped, Bash
  breadth, wildcard-before-subcommand, `defaultMode`, hooks, MCP transport, ignored shapes).
- `N-…` — the explicitly **not interpreted** items (compound commands, wrapper stripping,
  env assignments, redirects, path anchoring, depth semantics, symlink pairing,
  plugin-provided hooks and servers, skill `allowed-tools`, subagent frontmatter).
- `D-…` — the direction rules; a delta's `rule` field names the one that fired, e.g.
  `explain D-deny-removed`.
- The eight categories (`hook`, `mcp`, … `scoped-allow`) and `projected`.
- The flags (`shadowed`, `broad`, `breadth_unresolved`, `plaintext`, `variable_reference`,
  `ignored_by_claude_code`, `tracked_local`).

`docs/interpretations.md` is the same content in one generated page; `docs/explain.md`
lists every ID with the text `explain` prints.

**What the tiers mean for your decision:**

| tier | the tool is saying | what to do |
| ---- | ------------------ | ---------- |
| `proven` | the documentation states this directly | trust the direction; decide whether you want the capability |
| `projected` | inferred from documented behaviour, one step beyond what is written (prefix matching, rule shadowing) | check the reasoning holds for this rule before relying on it |
| `unresolved` | the tool declined to decide | read the change yourself; nothing here is a claim |

Only `proven` widenings set `summary.expands`, and only they fail a build unless you opt
into more with `--fail-on projected` or `--strict`. The interpretation list is
**closed and dated** (`semantics_doc_date: 2026-09-07`): anything outside it is
`unresolved` by design, not by oversight, and the date moves only when the list is
re-checked against the Claude Code documentation. That is what makes an old output still
readable — you can always tell which semantics produced it.

## 9. Security posture

`agent-surface` is an offline, deterministic reader:

- **Never executes anything.** A hook command is recorded and hashed into the entry key;
  helper commands (`apiKeyHelper`, …) and MCP server commands are recorded as text. None of
  them is ever run.
- **Never expands environment variables.** `${VAR}` and `$VAR` stay literal in commands,
  arguments, URLs and `env` values; the process environment is never consulted for output.
- **Never touches the network.** No fetch, no DNS, no telemetry, no update check. An MCP
  URL is classified from its text alone.
- **Only ever spawns three git subcommands** — `git show`, `git rev-parse`, `git ls-files` —
  always as an argument array, never through a shell. Any other subcommand is refused
  before anything is spawned.
- **Refuses symlinks that leave the repository.** Worktree reads are symlink-aware; a link
  resolving outside the root is reported as `incomplete`, never followed.
- Credential-shaped literals are replaced with `<redacted>` in every renderer, and `env`
  values are never carried at all.

Details, the limits (1 MiB per file, depth 32, prototype-less parsing) and the disclosure
process are in [`../SECURITY.md`](../SECURITY.md).

## 10. Troubleshooting

| symptom | cause | fix |
| ------- | ----- | --- |
| `incomplete: origin/main: missing ref: 'origin/main' does not resolve to a commit`, exit 3 | shallow or single-branch clone: the base branch was never fetched | `fetch-depth: 0` on `actions/checkout` (or `git fetch origin <branch>` locally). Same message for a typo'd or deleted ref |
| `.mcp.json: duplicate key "mcpServers" at /mcpServers (lines 6, 7)`, exit 3 | duplicate keys in a settings file | Fix the file. The parser never picks last-wins: it refuses visibly with both line numbers, because which one Claude Code honours is not something the tool will guess |
| `.claude/settings.local.json  ignored; ignored: not repository-controlled (untracked settings.local.json)` | the local file is untracked | Working as intended — an untracked file is not repository-controlled, so it is out of scope. A **tracked** `settings.local.json` *is* read, and adds a `Flagged (head)` line saying it is shared via Git |
| an MCP server lands in `UNRESOLVED` with `[variable_reference]`, exit 2 | the URL contains `${VAR}` | Also intended: the tool never expands variables, so the target is unknown and it says so instead of guessing. Review the value yourself, or use `--strict` to make it block |
| a settings reformat produces `no changes`, exit 0 | rule strings are canonicalized and values compared semantically | Nothing to fix. `Bash(npm run:*)` and `Bash(npm run *)` share one key; `docs/normalization.md` has the decisions |
| a non-empty `enabledPlugins` forces exit 2 | plugin-provided hooks and servers are not modeled | Intended: a plugin can bring hooks and servers the tool cannot see, so a change to `enabledPlugins` is `unresolved` and adds a `Flagged (head)` line. Review the plugin, or pin the policy with `--fail-on`/`--strict` |
| `check: unknown --fail-on category hooks`, exit 64 | the category is `hook`, not `hooks` | Use a name from `Categories:` in `--help`. 64 is a usage error, never a verdict |
| `no repository-controlled agent configuration found`, exit 0 | neither side has any of the three files | Expected for a repository that does not configure Claude Code |
| `ENOENT … /package.json` from `npm --prefix <folder> pack` | `pack` reads `package.json` from the current directory | Pass the folder as an argument instead: `npm pack <folder> --pack-destination .` |
| `unknown subcommand 'agent-surface'`, exit 64 | `npx --yes ./x.tgz agent-surface check …` | Drop the binary name, or add `-p` (see §2) |

## See also

- [`../README.md`](../README.md) — what each entry kind and exit code means, in reference form.
- [`interpretations.md`](interpretations.md) — the closed list, direction rules, categories and flags.
- [`explain.md`](explain.md) — every ID `explain` accepts.
- [`normalization.md`](normalization.md) — why a reformat is not a change.
- [`snapshot.schema.json`](snapshot.schema.json) — the snapshot shape.
- [`../SECURITY.md`](../SECURITY.md) — the security posture and disclosure process.
