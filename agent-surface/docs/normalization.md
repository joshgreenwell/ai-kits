# Entry key normalization (JG-151)

Decisions behind `src/normalize.ts`, dated against the Claude Code documentation of
2026-09-07 (the `semantics_doc_date` every snapshot carries). The goal: a change that only
reformats a file never looks like a semantic change, while the text as written is kept as
evidence in `Entry.value.raw`.

## What never reaches an entry

Key order, indentation, line endings, comments and trailing commas are consumed by the
JSONC parser (`src/jsonc.ts`) and are not part of any value the extractor sees. They cannot
affect a key or a value; only `line` and `json_pointer` (evidence fields) move.

## Permission rule strings

A rule is `Tool` or `Tool(spec)`. The canonical form used in `perm:<list>:<rule>` keys is
built as follows.

| step | rule | reason |
| --- | --- | --- |
| 1 | Trim leading and trailing whitespace of the whole rule string. | The docs show rules without padding; a padded rule is the same rule. |
| 2 | Split at the first `(` when the string ends with `)`. Trim the tool name. Anything else is a bare tool name (the trimmed string). | `Tool(spec)` is the documented shape; `mcp__server__tool` and plain tool names have no parentheses. |
| 3 | Trim leading and trailing whitespace inside the parentheses. | `Bash( npm test )` is not a different command than `Bash(npm test)`. |
| 4 | A trailing wildcard written `<prefix>:*` or `<prefix> *` (any run of whitespace before the `*`) becomes `<prefix> *`, with `<prefix>` trimmed on the right. `Bash(:*)`, `Bash( *)` and `Bash(*)` all become `Bash(*)`. | The docs describe both spellings as "commands starting with `<prefix>`". They are one rule. |
| 5 | Nothing else is rewritten. Internal whitespace inside the prefix, case, quotes and glob characters are preserved. | The docs describe prefix and exact matching on the literal string; they do not say internal whitespace is insignificant, so `Bash(echo  a)` and `Bash(echo a)` stay distinct. |

Consequences:

- `Bash(npm run:*)`, `Bash(npm run *)`, `Bash( npm run  * )` share the key
  `perm:allow:Bash(npm run *)`; each keeps its own `value.raw`.
- `Bash(npm run *)` (prefix) and `Bash(npm run)` (exact) are different keys.
- `Bash` and `Bash(*)` are different keys. Both are whole-tool rules; the interpretations
  (CS-C, interpretation 2) classify their breadth, the key does not merge them.

### Why ` *` is the canonical spelling

Both spellings are documented and equivalent. The space form was chosen because the plan's
key examples (`perm:allow:Bash(curl *)`, §3.4) use it and because it keeps the prefix and
the wildcard visibly separated after trimming. Renderers print the canonical form; the
spelling the author used is always available in `value.raw`.

## Other kinds

- `dir:<path>`: the path is trimmed; nothing else is rewritten (no anchoring, no
  normalization of `..`, `~` or trailing slashes: the plan lists path anchoring as not
  interpreted).
- `hook:<event>:<matcher>:<sha256(command)>`: the event and matcher are used verbatim (a
  matcher is a regular expression; whitespace can be significant). The hash is computed over
  the command text after credential redaction, so no output carries a digest derived from a
  credential literal. A changed command is a changed key.
- `mcp:<server-name>`: the name is used verbatim.
- `env_key:<NAME>`, `sandbox:<key>`, `helper:<key>`, `plugin_flag:<key>`: the key is the
  property name verbatim.
- `enabledMcpjsonServers` / `disabledMcpjsonServers`: the value carries `names` (sorted,
  de-duplicated) next to `raw` (as written), so a reordered list compares equal.
- `unknown:<json_pointer>` / `credential:<json_pointer>`: the pointer is the key; these are
  positional by nature.

## Comparing entries

`semanticEntry()` in `src/entries.ts` projects an entry to `{kind, key, file, value}` with
`value.raw` removed. Two sides whose files differ only in formatting produce identical
`semanticEntry` lists; only `line`, `json_pointer` and `source_sha` (evidence) may differ.
The diff (CS-C) must compare `semanticEntry` projections, never whole entries, or a reformat
would surface as `changed`.
