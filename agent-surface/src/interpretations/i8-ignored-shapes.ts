/**
 * I8 — Rule shapes the documentation says are ignored (proven).
 *
 * `Write(path)`, `NotebookEdit(path)`, `Glob(path)`, `MultiEdit(path)`,
 * `mcp__…(…)` with parentheses, and unanchored allow globs such as
 * `Read(*.env)` are not evaluated by Claude Code. They grant and deny
 * nothing: direction neutral, flag `ignored_by_claude_code`.
 */

import type { Entry } from "../types.js";
import { INTERPRETATION_DATE, permList, permValue } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

/** Tools whose `(path)` form is documented as not evaluated. */
export const IGNORED_SPEC_TOOLS: readonly string[] = ["Write", "NotebookEdit", "Glob", "MultiEdit"];

/** Path tools for which an unanchored allow glob (`Read(*.env)`) is ignored. */
export const PATH_TOOLS: readonly string[] = ["Read", "Edit"];

export const META: InterpretationMeta = {
  id: "I8",
  title: "Rule shapes ignored by Claude Code",
  tier: "proven",
  doc_section: "Permission rules > Tool-specific permission rules (Read & Edit, MCP) and notes on unsupported rule forms",
  semantics_doc_date: INTERPRETATION_DATE,
  summary: "Write(path), NotebookEdit(path), Glob(path), MultiEdit(path), mcp__…(…) with parentheses, and unanchored allow globs like Read(*.env) are ignored: neutral, flagged ignored_by_claude_code.",
  explain: [
    "The documentation defines path-scoped rules for Read and Edit only, and MCP rules as mcp__server or mcp__server__tool without parentheses.",
    "A path in parentheses on Write, NotebookEdit, Glob or MultiEdit, or parentheses on an mcp__ name, therefore matches nothing; an allow glob with no anchoring segment (Read(*.env)) is likewise documented as not matching.",
    "agent-surface reports such entries with direction neutral (they grant nothing and deny nothing) and tier proven, flagged ignored_by_claude_code, so a reviewer sees that the rule is inert instead of trusting it. A deny of an ignored shape blocks nothing.",
  ].join(" "),
};

export function classify(entry: Entry): Classification | null {
  const value = permValue(entry);
  if (value === null || value.spec === null) {
    return null;
  }
  let reason: string | null = null;
  if (IGNORED_SPEC_TOOLS.includes(value.tool)) {
    reason = `${value.tool}(path) is not evaluated; only Read and Edit take path rules`;
  } else if (value.tool.startsWith("mcp__")) {
    reason = "an mcp__ rule with parentheses is not evaluated; use mcp__server or mcp__server__tool";
  } else if (permList(entry) === "allow" && PATH_TOOLS.includes(value.tool) && value.spec.startsWith("*")) {
    reason = `unanchored allow glob ${value.rule} is not evaluated`;
  }
  if (reason === null) {
    return null;
  }
  return {
    direction: "neutral",
    tier: "proven",
    flags: ["ignored_by_claude_code"],
    notes: [`I8: ignored by Claude Code: ${reason}; the rule grants nothing and denies nothing`],
  };
}
