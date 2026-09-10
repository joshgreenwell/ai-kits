# Security policy

`agent-surface` reads repository-controlled Claude Code configuration and reports how a
change moves the agent's control surface. Its own security posture is deliberately
narrow: the tool is an offline, deterministic reader that never runs, fetches, or
expands anything it reads.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

1. Preferred: use GitHub private vulnerability reporting on the repository
   (`https://github.com/joshgreenwell/ai-kits` → Security → Report a vulnerability).
2. Alternatively, email the maintainer: `<maintainer-email>` (placeholder; the
   maintainer replaces it with a monitored address before the first release).

Include the version (`npx agent-surface --version`), the input that triggers the
problem (synthetic if possible; never a real credential), and the observed and expected
behaviour. You will get an acknowledgement within seven days. Fixes are released as a
new patch version and noted in `CHANGELOG.md`; credit is given if wanted.

## What the tool never does

- **Execute.** Hook commands, helper commands (`apiKeyHelper`, …), MCP server commands
  and `statusLine` commands are recorded as text and hashed; they are never run. The only
  processes ever spawned are `git show`, `git rev-parse` and `git ls-files`, always with an
  argument array and never through a shell; every other subcommand is refused before
  anything is spawned.
- **Touch the network.** No fetch, no HTTP, no DNS, no telemetry, no update check. An MCP
  URL is classified from its text alone.
- **Expand environment variables.** `${VAR}` and `$VAR` in commands, arguments, URLs and
  `env` values are rendered literally and reported as variable references; the process
  environment is never consulted for output.
- **Read outside the repository.** Only `.claude/settings.json`, a tracked
  `.claude/settings.local.json` and `.mcp.json` at the requested side are read. User,
  managed and `~/.claude.json` settings are never opened. Worktree reads are symlink-aware:
  a link that resolves outside the repository root is refused and reported as
  `incomplete`.
- **Carry secrets.** Credential-like literals (`sk-…`, `AKIA…`, GitHub, Slack and Bearer
  tokens, PEM private-key blocks, long opaque values under keys named like token / secret /
  key / password) are replaced by `<redacted>` before any value is copied, and reported as
  "credential-like value present" at their JSON pointer. `env` values are never carried at
  all. Hook hashes are computed over the redacted command so no key derives from a secret.
  Every renderer passes its output through the same redaction a final time.
- **Render an incomplete scan as clean.** Unparseable input, duplicate keys, a missing
  ref, a permission error or an oversized file yields `incomplete` and exit 3, with the
  reason and, where known, the line numbers; expansions found alongside are still
  reported.

## Scope of the guarantees

- Inputs are limited to 1 MiB per file and a nesting depth of 32; parsed objects have a
  `null` prototype so `__proto__` / `constructor` keys are plain data.
- The guarantees above are enforced by the test suite (`test/security.test.ts`): the
  whole golden fixture suite runs with `node:child_process` monkeypatched so that any
  spawn other than the three allow-listed `git` subcommands fails the test, and again
  with `net`, `http`, `https`, `dns` and `fetch` monkeypatched to throw; fixtures carry a
  canary hook command whose side effect must never appear, `${HOME}` / `$SECRET`
  references that must stay literal, and credential-shaped synthetic literals that must
  never reach text or JSON output.
- Redaction is heuristic and pattern-based (patterns dated 2026-09-07 in
  `src/redact.ts`). A credential in an unrecognised shape is not detected; treat the
  output as sensitive when the input is.
- The tool describes repository-controlled configuration only. It does not know the
  machine's effective permissions (`/permissions`, `/doctor`, `/status` do), does not
  model the sandbox, plugin-provided hooks and servers, or CLI flags, and does not
  reproduce Claude Code's permission matcher. Claims are tiered (`proven`, `projected`,
  `unresolved`) and the verdict counts only `proven` widenings.
- Supported runtime: Node 20 and newer, with `git` on `PATH`. There are no runtime
  dependencies, so the supply-chain surface is the package itself plus Node and git.
