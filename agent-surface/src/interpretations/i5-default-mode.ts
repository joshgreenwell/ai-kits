/**
 * I5 — `defaultMode` semantics (proven).
 *
 * Documented values: bypassPermissions, auto, dontAsk, acceptEdits, plan,
 * default. Only the first three widen. `dontAsk` is not allow-everything:
 * it auto-denies whatever would otherwise ask. An unknown value is
 * unresolved and never treated as widening.
 */

import type { Entry } from "../types.js";
import { INTERPRETATION_DATE, stringField } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

/** `defaultMode` values that widen the control surface. */
export const WIDENING_MODES: readonly string[] = ["bypassPermissions", "auto", "dontAsk"];

/** `defaultMode` values that do not widen it. */
export const NON_WIDENING_MODES: readonly string[] = ["acceptEdits", "plan", "default"];

export const META: InterpretationMeta = {
  id: "I5",
  title: "defaultMode: only bypassPermissions, auto and dontAsk widen",
  tier: "proven",
  doc_section: "Permission modes",
  semantics_doc_date: INTERPRETATION_DATE,
  summary: "bypassPermissions, auto and dontAsk widen; acceptEdits, plan and default do not; dontAsk is not allow-everything; an unknown value is unresolved and never widens.",
  explain: [
    "The permission-modes documentation lists default, acceptEdits, plan, dontAsk, auto and bypassPermissions.",
    "bypassPermissions skips every prompt; auto lets the model act without asking; dontAsk auto-denies anything that would have prompted, so the agent can still run everything already allowed without a human in the loop.",
    "agent-surface treats those three as widening. acceptEdits (auto-accepts file edits), plan (read-only) and default are not treated as widening, and a move between them is neutral.",
    "dontAsk is explicitly not allow-everything: it never grants what an allow rule does not; the note on the delta says so.",
    "Any other value is unknown to the documentation of the cited date: direction unknown, tier unresolved, never widening.",
  ].join(" "),
};

export function classify(entry: Entry): Classification | null {
  if (entry.kind !== "mode" || entry.key !== "mode:defaultMode") {
    return null;
  }
  const raw = stringField(entry, "raw");
  if (raw !== null && WIDENING_MODES.includes(raw)) {
    const notes = [`I5: defaultMode "${raw}" is a widening mode`];
    if (raw === "dontAsk") {
      notes.push("I5: dontAsk is not allow-everything; it auto-denies whatever would have asked, and only allow rules grant");
    }
    return { tier: "proven", flags: [], notes };
  }
  if (raw !== null && NON_WIDENING_MODES.includes(raw)) {
    return { tier: "proven", flags: [], notes: [`I5: defaultMode "${raw}" is not a widening mode`] };
  }
  return {
    direction: "unknown",
    tier: "unresolved",
    flags: [],
    notes: [`I5: defaultMode ${raw === null ? "is not a string" : `"${raw}" is not a documented value`}; never treated as widening`],
  };
}
