/**
 * I3 — Trailing-wildcard Bash breadth (projected).
 *
 * `Bash(x *)` / `Bash(x:*)` matches commands starting with `x` (breadth
 * `prefix`); `Bash(x)` with no wildcard matches exactly `x` (breadth
 * `exact`, proven); a `*` anywhere else (`Bash(git * main)`, `Bash(*.sh)`)
 * is a glob whose matching is not documented: breadth `glob`, flagged
 * `breadth_unresolved`, so the delta is listed as unresolved.
 */

import type { Entry } from "../types.js";
import { INTERPRETATION_DATE, permValue } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

export const META: InterpretationMeta = {
  id: "I3",
  title: "Trailing-wildcard Bash breadth: prefix, exact, or glob",
  tier: "projected",
  doc_section: "Permission rules > Tool-specific permission rules > Bash",
  semantics_doc_date: INTERPRETATION_DATE,
  summary: "Bash(x *) and Bash(x:*) are prefix rules (projected); Bash(x) is exact (proven); any other wildcard placement is a glob with unresolved breadth.",
  explain: [
    "The documentation describes `Bash(npm run test:*)` as matching commands that start with `npm run test`, and a rule without a wildcard as matching the exact command.",
    "agent-surface reads a trailing ` *` or `:*` as a prefix rule (both spellings share one key) and marks the breadth projected: prefix matching is documented, but its token boundaries and the equivalence of the two spellings are inferred.",
    "A rule with no wildcard is breadth exact and proven.",
    "A wildcard anywhere else (`Bash(git * main)`, `Bash(*.sh)`) has no documented matching rule; agent-surface records breadth glob, flags breadth_unresolved, and lists the delta under unresolved so a reviewer decides.",
    "The exit code treats a prefix or exact allow as a decided scoped-allow, and a glob allow as unresolved (exit 2 by default).",
  ].join(" "),
};

export function classify(entry: Entry): Classification | null {
  const value = permValue(entry);
  if (value === null || value.tool !== "Bash" || value.spec === null || value.spec === "*") {
    return null;
  }
  if (value.wildcard === "trailing") {
    return {
      breadth: "prefix",
      tier: "projected",
      flags: [],
      notes: [`I3: trailing wildcard; matches commands starting with "${value.spec.slice(0, -2)}" (prefix, projected)`],
    };
  }
  if (!value.spec.includes("*")) {
    return { breadth: "exact", tier: "proven", flags: [], notes: [`I3: no wildcard; matches exactly "${value.spec}" (exact, proven)`] };
  }
  return {
    breadth: "glob",
    tier: "projected",
    flags: ["breadth_unresolved"],
    notes: [`I3: wildcard placement in "${value.spec}" is neither trailing nor whole; breadth unresolved (glob, projected)`],
  };
}
