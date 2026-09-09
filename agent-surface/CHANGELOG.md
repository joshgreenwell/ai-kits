# Changelog

All notable changes to `agent-surface`. Interpretation changes name the interpretation
ID and the date of the Claude Code documentation they were checked against.

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
