/**
 * Verdict and exit code (JG-155, plan §3.8).
 *
 * Exit codes:
 *   0  no change, or narrowing / neutral / annotate-only changes
 *   1  proven expansion in a failing category (or a projected widening
 *      with `--fail-on projected`; or an undecided delta with `--strict`)
 *   2  undecided deltas only (tier not proven, or breadth unresolved):
 *      pass with annotation
 *   3  scan incomplete — always wins, even when an expansion is also
 *      present; both are reported
 *
 * `summary.expands` is true only when at least one `proven` delta with
 * direction `widens` sits in a failing category. `--fail-on` names the
 * failing categories (overriding the default set) and may include the
 * pseudo-category `projected`; naming only `projected` keeps the default
 * categories. Pure; never mutates the diff.
 */

import { CATEGORIES, DEFAULT_FAILING_CATEGORIES, PROJECTED_PSEUDO_CATEGORY, type Category } from "./categories.js";
import type { Delta, Diff, FailOn, Incomplete, VerdictLabel } from "./types.js";

export const EXIT_OK = 0;
export const EXIT_EXPANDS = 1;
export const EXIT_ANNOTATE = 2;
export const EXIT_INCOMPLETE = 3;

export interface VerdictOptions {
  /** Category names (and/or `projected`); empty means the default set. */
  failOn: readonly string[];
  strict: boolean;
}

export const DEFAULT_VERDICT_OPTIONS: VerdictOptions = { failOn: [], strict: false };

export interface Verdict {
  expands: boolean;
  categories: Category[];
  verdict: VerdictLabel;
  exit_code: number;
  fail_on: FailOn;
  strict: boolean;
  reasons: string[];
}

/** Split a `--fail-on` comma list into names (trimmed, empties dropped). */
export function parseFailOnList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Every name `--fail-on` accepts. */
export const FAIL_ON_NAMES: readonly string[] = [...CATEGORIES, PROJECTED_PSEUDO_CATEGORY];

/**
 * Resolve `--fail-on` names into the effective set. Unknown names are an
 * error (the CLI reports usage, exit 64). Duplicates are collapsed; the
 * result is sorted.
 */
export function resolveFailOn(names: readonly string[]): { ok: true; failOn: FailOn } | { ok: false; error: string } {
  const unknown = names.filter((name) => !FAIL_ON_NAMES.includes(name));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown --fail-on categor${unknown.length > 1 ? "ies" : "y"} ${unknown.join(", ")}; valid: ${FAIL_ON_NAMES.join(", ")}` };
  }
  const projected = names.includes(PROJECTED_PSEUDO_CATEGORY);
  const named = names.filter((name): name is Category => name !== PROJECTED_PSEUDO_CATEGORY);
  const categories = named.length === 0 ? [...DEFAULT_FAILING_CATEGORIES] : [...new Set(named)];
  return { ok: true, failOn: { categories: categories.sort(), projected } };
}

/**
 * True when the tool could not decide the delta: its direction claim is
 * not proven, or its breadth is unresolved (`breadth_unresolved`). Such
 * deltas live in `Diff.unresolved` and drive exit code 2.
 */
export function isUndecided(delta: Delta): boolean {
  return delta.tier !== "proven" || delta.flags.includes("breadth_unresolved");
}

/** True when the delta widens on a projected claim (direction or breadth). */
export function isProjectedWidening(delta: Delta): boolean {
  return delta.direction === "widens" && (delta.tier === "projected" || delta.breadth_tier === "projected");
}

function describe(delta: Delta): string {
  const flags = delta.flags.length === 0 ? "" : ` [${delta.flags.join(", ")}]`;
  return `${delta.key} ${delta.change} (${delta.tier} ${delta.direction}${delta.breadth === null ? "" : `, breadth ${delta.breadth}`})${flags}`;
}

function describeIncomplete(item: Incomplete): string {
  const lines = item.lines === null ? "" : ` (line${item.lines.length > 1 ? "s" : ""} ${item.lines.join(", ")})`;
  return `incomplete: ${item.path}: ${item.reason}${lines}`;
}

type DiffInput = Pick<Diff, "added" | "removed" | "changed" | "unresolved" | "incomplete">;

/**
 * Compute the verdict for a diff. Throws only on an unknown `--fail-on`
 * name (callers validate with `resolveFailOn` first).
 */
export function computeVerdict(diff: DiffInput, options: VerdictOptions = DEFAULT_VERDICT_OPTIONS): Verdict {
  const resolved = resolveFailOn(options.failOn);
  if (!resolved.ok) {
    throw new Error(resolved.error);
  }
  const failOn = resolved.failOn;
  const all = [...diff.added, ...diff.removed, ...diff.changed, ...diff.unresolved].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const widening = all.filter((delta) => delta.direction === "widens");
  const categories = [...new Set(widening.map((delta) => delta.category).filter((category): category is Category => category !== null))].sort();
  const provenFailing = widening.filter((delta) => delta.tier === "proven" && delta.category !== null && failOn.categories.includes(delta.category));
  const projectedFailing = failOn.projected ? widening.filter((delta) => isProjectedWidening(delta) && !provenFailing.includes(delta)) : [];
  const undecided = all.filter(isUndecided);
  const expands = provenFailing.length > 0;

  const reasons: string[] = [];
  for (const item of diff.incomplete) {
    reasons.push(describeIncomplete(item));
  }
  for (const delta of provenFailing) {
    reasons.push(`expands (${delta.category ?? "?"}): ${describe(delta)}`);
  }
  for (const delta of projectedFailing) {
    reasons.push(`expands (projected, ${delta.category ?? "?"}): ${describe(delta)}`);
  }
  for (const delta of undecided) {
    reasons.push(`undecided: ${describe(delta)}`);
  }

  let verdict: VerdictLabel;
  let exit: number;
  if (diff.incomplete.length > 0) {
    verdict = "incomplete";
    exit = EXIT_INCOMPLETE;
  } else if (expands || projectedFailing.length > 0) {
    verdict = "expands";
    exit = EXIT_EXPANDS;
  } else if (undecided.length > 0) {
    verdict = "undecided";
    exit = options.strict ? EXIT_EXPANDS : EXIT_ANNOTATE;
    if (options.strict) {
      reasons.push("strict: undecided deltas fail");
    }
  } else if (all.length === 0) {
    verdict = "no-change";
    exit = EXIT_OK;
    reasons.push("no change");
  } else {
    verdict = "pass";
    exit = EXIT_OK;
    reasons.push(widening.length === 0 ? "narrowing or neutral changes only" : "widening changes are annotate-only under the effective --fail-on set");
  }
  return { expands, categories, verdict, exit_code: exit, fail_on: failOn, strict: options.strict, reasons };
}
