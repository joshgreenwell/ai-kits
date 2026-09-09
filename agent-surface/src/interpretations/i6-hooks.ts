/**
 * I6 — Hook presence per event and matcher (proven).
 *
 * A hook entry proves that Claude Code will run the recorded command (or
 * prompt) when the event fires for a matching tool. The command is
 * recorded as text and never executed; what it does is not interpreted.
 */

import type { Entry } from "../types.js";
import { INTERPRETATION_DATE, stringField } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

export const META: InterpretationMeta = {
  id: "I6",
  title: "Hook presence per event and matcher",
  tier: "proven",
  doc_section: "Hooks reference > Configuration",
  semantics_doc_date: INTERPRETATION_DATE,
  summary: "A hook under hooks.<event>[].hooks[] runs automatically for that event and matcher; the command is recorded and hashed, never executed.",
  explain: [
    "Hooks are configured per event (PreToolUse, PostToolUse, Stop, …) with an optional matcher regular expression over tool names; an absent or empty matcher matches every tool.",
    "agent-surface proves presence only: which event, which matcher, and the sha256 of the command text (which is part of the entry key, so a changed command is a changed entry).",
    "It never executes the command, never models the hook's decision output, and does not model plugin-provided hooks (see the not-interpreted list).",
  ].join(" "),
};

export function classify(entry: Entry): Classification | null {
  if (entry.kind !== "hook") {
    return null;
  }
  const event = stringField(entry, "event") ?? "?";
  const matcher = stringField(entry, "matcher");
  const type = stringField(entry, "type") ?? "command";
  return {
    tier: "proven",
    flags: [],
    notes: [
      `I6: ${type} hook on ${event} for ${matcher === null || matcher === "" ? "every tool (no matcher)" : `matcher "${matcher}"`}; command recorded, never executed`,
    ],
  };
}
