/**
 * Helpers shared by the text and JSON renderers (JG-145, plan §3.7).
 *
 * Output-level redaction: every string that reaches an output sink is
 * passed through `redactString` from `redact.ts` a final time, without a
 * key context, so a credential-like literal that somehow survived entry
 * extraction is still replaced by `<redacted>` in every renderer. This is
 * a safety net over the extraction-time redaction, not a replacement for
 * it; the literal patterns are the same in both places.
 *
 * Never reads files, never touches the environment, never mutates input.
 */

import { redactString } from "../redact.js";
import { SEMANTICS_DOC_DATE, type Delta, type DiffSide, type EntryKind, type Incomplete, type Source } from "../types.js";

/** The §3.7 Assumptions block as `[label, value]` pairs, in print order. */
export const ASSUMPTION_LINES: ReadonlyArray<readonly [string, string]> = [
  ["Semantics doc date", SEMANTICS_DOC_DATE],
  ["Scope", "repository-controlled files only"],
  ["Workspace trust", "assumed accepted (allow rules/dirs are held until then)"],
  ["Runtime mode", "per defaultMode in head; CLI flags not modeled"],
  ["Sandbox", "not modeled"],
  ["Hooks", "presence only; decisions not modeled"],
  ["Managed/user/local", "not read"],
  ["Plugins", "not modeled (flagged if enabledPlugins non-empty)"],
];

/** Number of fixed assumption lines every snapshot stores first (`BASE_ASSUMPTIONS`). */
export const FIXED_ASSUMPTION_COUNT = 8;

/** Text printed when neither side carries any supported file. */
export const NO_CONFIGURATION_LINE =
  "no repository-controlled agent configuration found (no .claude/settings.json, tracked .claude/settings.local.json or .mcp.json on either side)";

/** Groups the text renderer prints deltas under, in order (JG-156). */
export const KIND_GROUPS: ReadonlyArray<{ label: string; kinds: readonly EntryKind[] }> = [
  { label: "hooks", kinds: ["hook"] },
  { label: "MCP", kinds: ["mcp"] },
  { label: "permissions", kinds: ["perm"] },
  { label: "directories", kinds: ["dir"] },
  { label: "mode", kinds: ["mode"] },
  { label: "flags", kinds: ["plugin_flag", "sandbox", "env_key", "helper"] },
  { label: "other", kinds: ["unknown", "credential"] },
];

/** Redact one line of output text (literal patterns only, no key context). */
export function redactOutput(text: string): string {
  return redactString(text, null).text;
}

/**
 * Deep copy of `value` with every string passed through `redactOutput`.
 * Object keys are kept as they are (they are never user-supplied literals
 * in a `Diff` or `Snapshot`; entry keys live in the `key` *value*).
 */
export function redactOutputTree(value: unknown): unknown {
  if (typeof value === "string") {
    return redactOutput(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactOutputTree);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = redactOutputTree((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** `path: reason (lines …)` for an incomplete record. */
export function describeIncomplete(item: Incomplete): string {
  const lines = item.lines === null ? "" : ` (line${item.lines.length > 1 ? "s" : ""} ${item.lines.join(", ")})`;
  return `${item.path}: ${item.reason}${lines}`;
}

/** Render the Assumptions block, then any extra notes the sides carry (deduplicated, in order). */
export function renderAssumptions(extraNotes: ReadonlyArray<readonly [string, string]>): string[] {
  const out = ["Assumptions"];
  for (const [label, value] of ASSUMPTION_LINES) {
    out.push(`  ${label.padEnd(23)}${value}`);
  }
  for (const [label, value] of extraNotes) {
    out.push(`  ${label.padEnd(23)}${value}`);
  }
  return out;
}

/** Notes beyond the fixed assumptions a side stored (tracked local file, enabledPlugins). */
export function extraAssumptionNotes(side: "base" | "head" | null, assumptions: readonly string[]): Array<readonly [string, string]> {
  const label = side === null ? "Flagged" : `Flagged (${side})`;
  return assumptions.slice(FIXED_ASSUMPTION_COUNT).map((note) => [label, note] as const);
}

/** True when every source of the side is absent (or ignored as not repository-controlled). */
export function hasNoConfiguration(sources: readonly Source[]): boolean {
  return sources.every((source) => source.status === "absent" || source.status === "ignored");
}

/** True when neither side carries any supported file. */
export function noConfigurationOnEitherSide(base: DiffSide, head: DiffSide): boolean {
  return hasNoConfiguration(base.sources) && hasNoConfiguration(head.sources);
}

/** `file:line` (or just `file`) of the entry a delta is about. */
export function deltaLocation(delta: Delta): string {
  const entry = delta.head ?? delta.base;
  if (entry === null) {
    return "";
  }
  return entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
}
