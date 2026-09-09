/**
 * The closed, ordered interpretation list (plan §3.6, JG-154), dated
 * `SEMANTICS_DOC_DATE`. Anything outside it is `unresolved`.
 *
 * `applyInterpretations` runs the not-interpreted detectors and then every
 * interpretation over a delta's subject entry (head for added / changed /
 * moved, base for removed) and merges the claims:
 *
 *  - a claim carrying `breadth` sets the delta's breadth and weakens
 *    `breadth_tier` to the claim's tier;
 *  - a claim carrying `direction` overrides the direction and weakens
 *    `tier`; a claim with tier `unresolved` weakens `tier` even without a
 *    direction;
 *  - notes and flags accumulate (flags de-duplicated).
 *
 * When a not-interpreted item is detected on a permission rule, the
 * breadth interpretations (I2–I4) are skipped: the tool does not claim a
 * breadth for a rule it does not interpret. Pure; never mutates its input.
 */

import type { Delta, Entry, Snapshot, Tier } from "../types.js";
import { SEMANTICS_DOC_DATE } from "../types.js";
import * as i1 from "./i1-shadowing.js";
import * as i2 from "./i2-whole-tool.js";
import * as i3 from "./i3-bash-breadth.js";
import * as i4 from "./i4-wildcard-before-subcommand.js";
import * as i5 from "./i5-default-mode.js";
import * as i6 from "./i6-hooks.js";
import * as i7 from "./i7-mcp-transport.js";
import * as i8 from "./i8-ignored-shapes.js";
import { detectNotInterpreted, NOT_INTERPRETED } from "./not-interpreted.js";
import type { Classification, Flag, Interpretation } from "./types.js";
import { weakerTier } from "./types.js";

export { NOT_INTERPRETED, findNotInterpreted, detectNotInterpreted, type NotInterpreted } from "./not-interpreted.js";
export { FLAGS, FLAG_META, TIER_ORDER, weakerTier, type Classification, type Flag, type Interpretation, type InterpretationMeta } from "./types.js";

/** The closed list, in order. Dated `INTERPRETATIONS_DATE`. */
export const INTERPRETATIONS: readonly Interpretation[] = [i1, i2, i3, i4, i5, i6, i7, i8];

/** Date of the Claude Code documentation the list was checked against. */
export const INTERPRETATIONS_DATE = SEMANTICS_DOC_DATE;

/** Interpretations that claim a breadth; skipped for rules a not-interpreted item applies to. */
const BREADTH_INTERPRETATIONS: readonly string[] = ["I2", "I3", "I4"];

/** Note attached when nothing in the list applies and the direction table gave no answer. */
export const OUTSIDE_LIST_NOTE = `outside the closed interpretation list (dated ${INTERPRETATIONS_DATE}); unresolved`;

/** Look up an interpretation by id (`I1` … `I8`). */
export function findInterpretation(id: string): Interpretation | null {
  return INTERPRETATIONS.find((item) => item.META.id === id) ?? null;
}

/**
 * Apply every interpretation to `delta` and return a new delta. The
 * subject entry is `delta.head` when present, else `delta.base`; the
 * snapshot searched (for shadowing) is the matching side.
 */
export function applyInterpretations(delta: Delta, base: Snapshot, head: Snapshot): Delta {
  const entry: Entry | null = delta.head ?? delta.base;
  if (entry === null) {
    return delta;
  }
  const snapshot = delta.head !== null ? head : base;
  let direction = delta.direction;
  let tier: Tier = delta.tier;
  let breadth = delta.breadth;
  let breadthTier: Tier | null = delta.breadth_tier;
  const ids = [...delta.interpretations];
  const flags: Flag[] = [...delta.flags];
  const notes = [...delta.notes];

  const merge = (id: string | string[], claim: Classification): void => {
    for (const one of Array.isArray(id) ? id : [id]) {
      if (!ids.includes(one)) {
        ids.push(one);
      }
    }
    if (claim.breadth !== undefined) {
      breadth = claim.breadth;
      breadthTier = weakerTier(breadthTier ?? "proven", claim.tier);
    }
    if (claim.direction !== undefined) {
      direction = claim.direction;
      tier = weakerTier(tier, claim.tier);
    } else if (claim.tier === "unresolved") {
      tier = "unresolved";
    }
    for (const flag of claim.flags) {
      if (!flags.includes(flag)) {
        flags.push(flag);
      }
    }
    notes.push(...claim.notes);
  };

  const detected = detectNotInterpreted(entry);
  if (detected !== null) {
    merge(detected.ids, detected.classification);
  }
  for (const interpretation of INTERPRETATIONS) {
    if (detected !== null && BREADTH_INTERPRETATIONS.includes(interpretation.META.id)) {
      continue;
    }
    const claim = interpretation.classify(entry, snapshot);
    if (claim !== null) {
      merge(interpretation.META.id, claim);
    }
  }
  if (ids.length === 0 && delta.rule === "D-unknown") {
    notes.push(OUTSIDE_LIST_NOTE);
  }
  if (entry.file === ".claude/settings.local.json" && !flags.includes("tracked_local")) {
    flags.push("tracked_local");
  }
  return { ...delta, direction, tier, breadth, breadth_tier: breadthTier, interpretations: ids, flags, notes };
}
