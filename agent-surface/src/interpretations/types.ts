/**
 * Shapes shared by the interpretation modules (JG-154, plan §3.6).
 *
 * An interpretation is a pure classifier: `classify(entry, snapshot)` looks
 * at one entry (and, for shadowing, at the other entries of the same
 * snapshot) and returns the claim it makes about that entry, or `null`
 * when it does not apply. It never reads files, never executes anything,
 * never expands variables, and never mutates its inputs.
 */

import type { Breadth, Direction, Entry, Snapshot, Tier } from "../types.js";

/** Flags an interpretation can attach to a delta. Closed list. */
export const FLAGS = [
  "shadowed",
  "broad",
  "breadth_unresolved",
  "plaintext",
  "variable_reference",
  "ignored_by_claude_code",
  "tracked_local",
] as const;

export type Flag = (typeof FLAGS)[number];

/** Documentation for each flag, rendered into `docs/interpretations.md`. */
export const FLAG_META: ReadonlyArray<{ id: Flag; explain: string }> = [
  {
    id: "shadowed",
    explain:
      "the rule string also appears in an earlier-matching list (deny before ask before allow), so this rule grants nothing while the other stands (I1)",
  },
  {
    id: "broad",
    explain: "a wildcard appears before a subcommand, e.g. Bash(git * main); the rule may match far more than its literal parts suggest (I4)",
  },
  {
    id: "breadth_unresolved",
    explain: "the wildcard placement is not documented as prefix or exact matching; the delta is listed under unresolved (I3)",
  },
  { id: "plaintext", explain: "an MCP URL uses literal http:// to a non-loopback host (I7)" },
  {
    id: "variable_reference",
    explain: "an MCP URL or command contains ${VAR} / $VAR; agent-surface never expands variables, so the target is unresolved (I7)",
  },
  {
    id: "ignored_by_claude_code",
    explain: "the rule has a shape the Claude Code documentation says is ignored; it grants and denies nothing (I8)",
  },
  {
    id: "tracked_local",
    explain: "the entry lives in a tracked .claude/settings.local.json (local file shared via Git, trust-held by Claude Code)",
  },
];

/**
 * The claim one interpretation makes about one entry.
 *
 * `tier` is the confidence of *this* claim. A claim that carries `breadth`
 * sets the delta's breadth confidence; a claim that carries `direction`, or
 * whose tier is `unresolved`, sets the delta's direction confidence.
 */
export interface Classification {
  breadth?: Breadth;
  direction?: Direction;
  tier: Tier;
  notes: string[];
  flags: Flag[];
}

/** Metadata every interpretation exports as `META`; `docs/interpretations.md` is rendered from it. */
export interface InterpretationMeta {
  /** `I1` … `I8`. */
  id: string;
  title: string;
  /** Tier of the claims the interpretation makes; `proven / unresolved` for I7. */
  tier: string;
  /** Claude Code documentation section the interpretation derives from. */
  doc_section: string;
  /** Date of the documentation the interpretation was checked against. */
  semantics_doc_date: string;
  summary: string;
  explain: string;
}

export interface Interpretation {
  META: InterpretationMeta;
  /** Pure. Returns `null` when the interpretation does not apply to `entry`. */
  classify(entry: Entry, snapshot: Snapshot): Classification | null;
}

/** Tiers from strongest to weakest. */
export const TIER_ORDER: readonly Tier[] = ["proven", "projected", "unresolved"];

/** The weaker of two tiers. */
export function weakerTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}
