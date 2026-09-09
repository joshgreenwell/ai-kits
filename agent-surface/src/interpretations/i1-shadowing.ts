/**
 * I1 — Rule-string shadowing (projected).
 *
 * Claude Code evaluates permission rules deny → ask → allow, first match.
 * The same normalized rule string present in an earlier list therefore
 * makes the later one inert: a deny shadows ask and allow, an ask shadows
 * allow. Only exact string equality (after `normalize.ts`) is considered;
 * prefix overlap between different strings is not interpreted.
 */

import type { Entry, Snapshot } from "../types.js";
import { INTERPRETATION_DATE, permList, permValue, where } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

export const META: InterpretationMeta = {
  id: "I1",
  title: "Rule-string shadowing (deny → ask → allow, first match)",
  tier: "projected",
  doc_section: "Permission rules > How permission rules are evaluated",
  semantics_doc_date: INTERPRETATION_DATE,
  summary:
    "The same normalized rule string in deny shadows the string in ask and allow; in ask it shadows allow. A shadowed rule grants nothing and is reported as neutral.",
  explain: [
    "Claude Code checks deny rules first, then ask rules, then allow rules, and stops at the first match.",
    "When the identical normalized rule string appears in an earlier list, the later rule can never be the first match, so adding or removing it changes nothing about what the agent may do while the earlier rule stands.",
    "agent-surface reports such a delta with direction neutral and flag shadowed. The claim is projected: it relies on string identity after normalization (`docs/normalization.md`) and on the documented list order; overlapping but different strings (a prefix rule that covers an exact rule) are not interpreted.",
    "A deny added together with an allow for the same string therefore counts as a narrowing plus a neutral, never as a proven expansion (JG-155).",
  ].join(" "),
};

export function classify(entry: Entry, snapshot: Snapshot): Classification | null {
  const value = permValue(entry);
  const list = permList(entry);
  if (value === null || list === null || list === "deny") {
    return null;
  }
  const earlier = list === "allow" ? (["deny", "ask"] as const) : (["deny"] as const);
  for (const other of earlier) {
    const shadow = snapshot.entries.find((candidate) => candidate.key === `perm:${other}:${value.rule}`);
    if (shadow !== undefined) {
      return {
        direction: "neutral",
        tier: "projected",
        flags: ["shadowed"],
        notes: [`I1: shadowed by ${shadow.key} at ${where(shadow)} (deny → ask → allow, first match); this ${list} rule grants nothing while it stands`],
      };
    }
  }
  return null;
}
