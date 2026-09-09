/**
 * Permission rule-string canonicalization (JG-151, plan §3.5 step 2).
 *
 * A rule is `Tool` or `Tool(spec)`. The canonical form is what the entry
 * key carries; the text as written is kept in `value.raw`. The decisions
 * are written down in `docs/normalization.md`; in short:
 *
 *  - the whole rule, the tool name and the spec are trimmed of leading and
 *    trailing whitespace;
 *  - a trailing wildcard written as `<prefix>:*` or `<prefix> *` (one or
 *    more whitespace characters before the `*`) becomes `<prefix> *`, with
 *    the prefix trimmed on the right; `Bash(npm run:*)` and
 *    `Bash(npm run *)` therefore share one key, and `Bash(npm run)` (exact)
 *    stays distinct;
 *  - whitespace inside the prefix is preserved (the docs treat the rule as
 *    a literal prefix/exact match, so `echo  a` is not `echo a`);
 *  - nothing else is rewritten: case, quoting and glob characters are kept.
 *
 * This module never evaluates a rule and never touches the filesystem.
 */

/** A rule string parsed into its parts. `spec` is `null` for a bare tool name. */
export interface ParsedRule {
  /** The text exactly as written in the file. */
  raw: string;
  /** Canonical rule string used in the entry key. */
  rule: string;
  /** Tool name (trimmed), e.g. `Bash`, `Read`, `mcp__server__tool`. */
  tool: string;
  /** Canonical spec inside the parentheses, or `null` when there are none. */
  spec: string | null;
  /** Wildcard shape of the canonical spec; `null` when there is no spec. */
  wildcard: "whole" | "trailing" | "none" | null;
}

const TRAILING_COLON_STAR = /:\*$/;
const TRAILING_SPACE_STAR = /\s+\*$/;

/**
 * Canonicalize the inside of the parentheses. Exported so interpretations
 * can reuse the exact same rule for breadth classification.
 */
export function normalizeSpec(spec: string): { spec: string; wildcard: "whole" | "trailing" | "none" } {
  const trimmed = spec.trim();
  if (trimmed === "*") {
    return { spec: "*", wildcard: "whole" };
  }
  let prefix: string | null = null;
  if (TRAILING_COLON_STAR.test(trimmed)) {
    prefix = trimmed.replace(TRAILING_COLON_STAR, "").trimEnd();
  } else if (TRAILING_SPACE_STAR.test(trimmed)) {
    prefix = trimmed.replace(TRAILING_SPACE_STAR, "").trimEnd();
  }
  if (prefix === null) {
    return { spec: trimmed, wildcard: "none" };
  }
  if (prefix === "") {
    return { spec: "*", wildcard: "whole" };
  }
  return { spec: `${prefix} *`, wildcard: "trailing" };
}

/**
 * Parse and canonicalize one permission rule string.
 *
 * A rule that ends with `)` and contains `(` is split at the first `(`;
 * everything up to the final `)` is the spec. Any other string is a bare
 * tool name (the string, trimmed). An empty string yields an empty tool
 * name; callers treat that as `incomplete`.
 */
export function normalizeRule(raw: string): ParsedRule {
  const trimmed = raw.trim();
  const open = trimmed.indexOf("(");
  if (open > 0 && trimmed.endsWith(")")) {
    const tool = trimmed.slice(0, open).trim();
    const inner = trimmed.slice(open + 1, -1);
    const normalized = normalizeSpec(inner);
    return { raw, rule: `${tool}(${normalized.spec})`, tool, spec: normalized.spec, wildcard: normalized.wildcard };
  }
  return { raw, rule: trimmed, tool: trimmed, spec: null, wildcard: null };
}
