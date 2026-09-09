/**
 * I2 — Whole-tool vs scoped rules (proven).
 *
 * A bare tool name (`Bash`, `Read`, `mcp__docs__search`) or `Tool(*)`
 * matches every use of that tool: breadth `whole_tool`. `Bash(...)` with a
 * spec is scoped to that spec; its breadth is decided by I3/I4. A non-Bash
 * `Tool(spec)` is left to I8 (ignored shapes) or reported as not
 * interpreted (path anchoring, depth semantics).
 */

import type { Entry } from "../types.js";
import { INTERPRETATION_DATE, permValue } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

export const META: InterpretationMeta = {
  id: "I2",
  title: "Whole-tool vs scoped permission rules",
  tier: "proven",
  doc_section: "Permission rules > Tool-specific permission rules",
  semantics_doc_date: INTERPRETATION_DATE,
  summary: "Bash / Bash(*) (and any bare tool name or Tool(*)) is a whole-tool rule; Bash(...) with a spec is scoped.",
  explain: [
    "The documentation states that a rule consisting of a tool name alone matches any use of that tool, and that `Bash(*)` is equivalent to `Bash`.",
    "agent-surface assigns breadth whole_tool to both spellings (they remain distinct keys; see docs/normalization.md) and to every other bare tool name, including `mcp__server` and `mcp__server__tool`.",
    "`Bash(<spec>)` is scoped: it matches only what the spec describes, and I3/I4 decide whether that is an exact command, a prefix, or an interior-wildcard glob.",
    "The claim is proven because the documentation states it directly.",
  ].join(" "),
};

export function classify(entry: Entry): Classification | null {
  const value = permValue(entry);
  if (value === null) {
    return null;
  }
  if (value.spec === null || value.spec === "*") {
    return {
      breadth: "whole_tool",
      tier: "proven",
      flags: [],
      notes: [`I2: ${value.rule} is a whole-tool rule (${value.spec === null ? "bare tool name" : "Tool(*)"}); it matches every use of ${value.tool}`],
    };
  }
  if (value.tool === "Bash") {
    return { tier: "proven", flags: [], notes: [`I2: ${value.rule} is scoped to its spec, not the whole tool`] };
  }
  return null;
}
