/**
 * I4 — Wildcard before a subcommand (projected).
 *
 * `Bash(git * main)` places `*` before further text. Whatever Claude Code
 * matches it against, the rule is broader than its literal parts suggest
 * (`git push --force main`, `git * main` …). Flagged `broad`.
 */

import type { Entry } from "../types.js";
import { INTERPRETATION_DATE, permValue } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

export const META: InterpretationMeta = {
  id: "I4",
  title: "Wildcard before a subcommand is broad",
  tier: "projected",
  doc_section: "Permission rules > Tool-specific permission rules > Bash",
  semantics_doc_date: INTERPRETATION_DATE,
  summary: "A `*` followed by more text in a Bash spec (Bash(git * main)) is flagged broad: it can match many unrelated commands.",
  explain: [
    "The documentation only describes a trailing wildcard. When a `*` is followed by further text, the part after it does not constrain what the wildcard absorbed: `Bash(git * main)` covers `git push --force main` as well as `git checkout main`.",
    "agent-surface flags such rules broad and keeps breadth glob (from I3). The claim is projected because the exact matching behaviour is not documented; the flag exists so a reviewer looks at the rule rather than trusting its readable parts.",
  ].join(" "),
};

export function classify(entry: Entry): Classification | null {
  const value = permValue(entry);
  if (value === null || value.tool !== "Bash" || value.spec === null || value.spec === "*") {
    return null;
  }
  const star = value.spec.indexOf("*");
  if (star === -1 || star === value.spec.length - 1) {
    return null;
  }
  return {
    breadth: "glob",
    tier: "projected",
    flags: ["broad"],
    notes: [`I4: wildcard before a subcommand in "${value.spec}"; the text after "*" does not limit what it matches (broad, projected)`],
  };
}
