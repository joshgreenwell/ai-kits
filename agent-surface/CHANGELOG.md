# Changelog

All notable changes to `agent-surface`. Interpretation changes name the interpretation
ID and the date of the Claude Code documentation they were checked against.

## Unreleased

Security fixes from the control-surface audit (SRF-1 … SRF-3). Interpretations unchanged;
`semantics_doc_date` stays **2026-09-07**.

- **SRF-1 (critical):** a `--base` / `--head` / `snapshot` argument is no longer
  classified by looking at the filesystem. The kind is explicit in the spelling —
  `ref:<git ref>`, `dir:<directory>`, `snapshot:<file>` — and a bare spec is always a git
  ref (only `.` still means the current worktree). Before, a change that added a file
  named `HEAD` or a directory named `main` made `check --base main --head HEAD` compare
  the change against content the change supplied and exit 0. `check` now also refuses a
  `dir:` or `snapshot:` side that lies inside the repository being checked unless
  `--allow-in-repo` is given (`diff` and `snapshot` warn), a bare spec that does not
  resolve exits 3 with a hint, and a snapshot file's `origin.sha` is dropped unless it is
  a commit id. Documentation and the CI example name both sides by SHA
  (`--base ref:${{ github.event.pull_request.base.sha }} --head ref:${{ github.sha }}`).
  Existing invocations that passed a directory or a snapshot file without a prefix must
  add `dir:` / `snapshot:`.
- **SRF-2 (high):** redaction no longer hides a change. The private-key pattern required
  only a `BEGIN … PRIVATE KEY` line and swallowed everything after it when no `END` line
  followed, and hook keys, MCP `command` / `args` / `url` and helper commands were hashed
  and compared after redaction, so `echo '-----BEGIN PRIVATE KEY-----'; curl … | sh` was
  indistinguishable from the base hook. The pattern now needs the `END` line; the hook key
  hashes the raw command; a redacted MCP or helper field carries a sibling
  `<field>_sha256` of the raw text (and `D-mcp-changed` fires on it); a `credential` entry
  is now `{note, patterns, sha256}` with the digest of the raw string, so any redacted
  literal that changes is a changed (unresolved) entry; and a delta whose text was
  redacted carries a note saying so. Displayed values stay redacted everywhere.

## 0.0.1 — 2026-09-09

Initial release (V0).

Interpretations — closed list, checked against the Claude Code documentation dated
**2026-09-07** (`semantics_doc_date: 2026-09-07`):

| ID | Interpretation | Tier | Checked |
| --- | --- | --- | --- |
| `I1` | Rule-string shadowing (deny → ask → allow, first match) | projected | 2026-09-07 |
| `I2` | Whole-tool vs scoped permission rules | proven | 2026-09-07 |
| `I3` | Trailing-wildcard Bash breadth: prefix, exact, or glob | projected | 2026-09-07 |
| `I4` | Wildcard before a subcommand is broad | projected | 2026-09-07 |
| `I5` | defaultMode: only bypassPermissions, auto and dontAsk widen | proven | 2026-09-07 |
| `I6` | Hook presence per event and matcher | proven | 2026-09-07 |
| `I7` | MCP transport: literal http:// to a non-loopback host is plaintext | proven / unresolved | 2026-09-07 |
| `I8` | Rule shapes ignored by Claude Code | proven | 2026-09-07 |

Also in this release:

- Inputs: `.claude/settings.json`, tracked `.claude/settings.local.json`, `.mcp.json`
  (hooks inside settings), read as Git blobs at a ref, from a directory, or from a saved
  `snapshot.json`; hand-written JSONC parser with duplicate-key rejection, size and depth
  limits, prototype-pollution safety.
- Keyed diff with the JG-153 direction table (26 `D-…` rules), verdict categories,
  `--fail-on` and `--strict`, exit codes 0 / 1 / 2 / 3 (64 for usage).
- Text renderer with the §3.7 assumptions header and grouped sections; byte-deterministic
  JSON renderer; shared credential redaction.
- Golden fixture suite (`fixtures/golden/`), no-exec / no-network / redaction tests,
  `docs/interpretations.md` and `docs/explain.md` generated from the metadata.
