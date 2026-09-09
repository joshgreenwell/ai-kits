/**
 * Human-readable output for PR reviewers (JG-156, plan §3.7 / §3.8).
 *
 * Diff layout:
 *
 *   CONTROL-SURFACE DIFF  base=<sha> head=<sha>
 *   Assumptions            (the §3.7 block, printed exactly once)
 *   INCOMPLETE             (first, whenever non-empty; never omitted)
 *   EXPANDED               (widening deltas, grouped by kind: hooks, MCP,
 *                           permissions, directories, mode, flags, other)
 *   NARROWED               (narrowing deltas)
 *   CHANGED                (neutral deltas, moves)
 *   UNRESOLVED             (deltas the tool could not decide)
 *   verdict line + reasons
 *
 * Empty sections are omitted, except INCOMPLETE which is always printed
 * when non-empty. A scan with a non-empty `incomplete[]` never prints
 * "no changes". A diff with only unresolved deltas prints the UNRESOLVED
 * section and one line saying no verdict was derived. When neither side
 * carries any supported file, the "no repository-controlled agent
 * configuration found" line is printed instead of "no changes".
 *
 * Every line goes through the shared redaction (`redact.ts`) before it is
 * returned. Pure: never reads files, never executes or expands anything.
 */

import { CREDENTIAL_PRESENT } from "../redact.js";
import type { Delta, Diff, DiffSide, Snapshot } from "../types.js";
import {
  KIND_GROUPS,
  NO_CONFIGURATION_LINE,
  deltaLocation,
  describeIncomplete,
  extraAssumptionNotes,
  noConfigurationOnEitherSide,
  redactOutput,
  renderAssumptions,
} from "./shared.js";

type Section = "EXPANDED" | "NARROWED" | "CHANGED" | "UNRESOLVED";

/** Section order after INCOMPLETE. */
const SECTIONS: readonly Section[] = ["EXPANDED", "NARROWED", "CHANGED", "UNRESOLVED"];

function sideLabel(side: DiffSide): string {
  return side.sha ?? `${side.origin.kind}:${side.origin.spec}`;
}

/** Which section a delta belongs to. Undecided deltas (`Diff.unresolved`) are UNRESOLVED regardless of direction. */
function sectionOf(delta: Delta, undecided: boolean): Section {
  if (undecided) {
    return "UNRESOLVED";
  }
  switch (delta.direction) {
    case "widens":
      return "EXPANDED";
    case "narrows":
      return "NARROWED";
    default:
      return "CHANGED";
  }
}

/** One delta line: change, kind, key, direction, tier, breadth (perm only), flags, `file:line`. */
export function renderDeltaLine(delta: Delta): string {
  const claim: string[] = [delta.direction, delta.tier];
  if (delta.kind === "perm" && delta.breadth !== null) {
    claim.push(delta.breadth);
  }
  const flags = delta.flags.length === 0 ? "" : ` [${delta.flags.join(",")}]`;
  return `    ${delta.change.padEnd(7)} ${delta.kind.padEnd(11)} ${delta.key}  ${claim.join(" ")}${flags}  ${deltaLocation(delta)}`;
}

function renderDelta(delta: Delta): string[] {
  const out = [renderDeltaLine(delta)];
  if (delta.kind === "credential") {
    out.push(`              ${CREDENTIAL_PRESENT} (value redacted)`);
  }
  for (const note of delta.notes) {
    out.push(`              ${note}`);
  }
  return out;
}

/** Render one section, grouped by kind in `KIND_GROUPS` order; empty groups are skipped. */
function renderSection(name: Section, deltas: readonly Delta[]): string[] {
  if (deltas.length === 0) {
    return [];
  }
  const out: string[] = [name];
  for (const group of KIND_GROUPS) {
    const members = deltas.filter((delta) => group.kinds.includes(delta.kind));
    if (members.length === 0) {
      continue;
    }
    out.push(`  ${group.label}`);
    for (const delta of members) {
      out.push(...renderDelta(delta));
    }
  }
  return out;
}

function renderIncompleteSection(diff: Pick<Diff, "incomplete">): string[] {
  if (diff.incomplete.length === 0) {
    return [];
  }
  return ["INCOMPLETE", ...diff.incomplete.map((item) => `  ${describeIncomplete(item)}`)];
}

function renderVerdict(diff: Diff): string[] {
  const summary = diff.summary;
  const categories = summary.categories.length === 0 ? "none" : summary.categories.join(",");
  return [
    `verdict: ${summary.verdict} (exit ${summary.exit_code}); expands=${summary.expands}; categories=${categories}`,
    ...summary.reasons.map((reason) => `  - ${reason}`),
  ];
}

/** Text of `diff` / `check` without `--json`. Ends with a newline. */
export function renderDiffText(diff: Diff): string {
  const out: string[] = [`CONTROL-SURFACE DIFF  base=${sideLabel(diff.base)} head=${sideLabel(diff.head)}`];
  const notes = [...extraAssumptionNotes("base", diff.base.assumptions), ...extraAssumptionNotes("head", diff.head.assumptions)];
  out.push(...renderAssumptions(notes));
  out.push(...renderIncompleteSection(diff));

  const decided = [...diff.added, ...diff.removed, ...diff.changed];
  const bySection = new Map<Section, Delta[]>(SECTIONS.map((name) => [name, []]));
  for (const delta of decided) {
    bySection.get(sectionOf(delta, false))?.push(delta);
  }
  for (const delta of diff.unresolved) {
    bySection.get("UNRESOLVED")?.push(delta);
  }
  const byKey = (a: Delta, b: Delta): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const name of SECTIONS) {
    out.push(...renderSection(name, (bySection.get(name) ?? []).sort(byKey)));
  }

  const total = decided.length + diff.unresolved.length;
  if (total === 0) {
    if (diff.incomplete.length > 0) {
      out.push("no deltas derived; the scan is incomplete and this is not a clean result");
    } else if (noConfigurationOnEitherSide(diff.base, diff.head)) {
      out.push(NO_CONFIGURATION_LINE);
    } else {
      out.push("no changes");
    }
  } else if (decided.length === 0 && diff.incomplete.length === 0) {
    out.push(`no verdict derived: every change (${total}) is unresolved; nothing is proven either way`);
  }
  out.push(...renderVerdict(diff));
  return `${out.map(redactOutput).join("\n")}\n`;
}

/** Text of `snapshot` without `--json`: the same header and Assumptions block, then sources, entries, incomplete. */
export function renderSnapshotText(snapshot: Snapshot): string {
  const sha = snapshot.origin.sha ?? "none";
  const out: string[] = [`CONTROL-SURFACE SNAPSHOT  origin=${snapshot.origin.kind} spec=${snapshot.origin.spec} sha=${sha}`];
  out.push(...renderAssumptions(extraAssumptionNotes(null, snapshot.assumptions)));
  out.push(...renderIncompleteSection(snapshot));
  out.push("SOURCES");
  for (const source of snapshot.sources) {
    const detail = [source.status, source.blob === null ? null : `blob ${source.blob.slice(0, 12)}`, source.note]
      .filter((item): item is string => item !== null)
      .join("; ");
    out.push(`  ${source.path.padEnd(30)} ${detail}`);
  }
  if (snapshot.entries.length === 0) {
    out.push("ENTRIES (0)");
    out.push(snapshot.incomplete.length > 0 ? "  none derived; the scan is incomplete and this is not a clean result" : "  none");
  } else {
    out.push(`ENTRIES (${snapshot.entries.length})`);
    for (const entry of snapshot.entries) {
      const where = entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
      const suffix = entry.kind === "credential" ? `  ${CREDENTIAL_PRESENT}` : "";
      out.push(`  ${entry.kind.padEnd(11)} ${entry.key}  ${where}${suffix}`);
    }
  }
  return `${out.map(redactOutput).join("\n")}\n`;
}
