/**
 * Keyed diff of two snapshots (JG-153, plan §3.5 steps 3–6).
 *
 * 1. Group each side's entries by `Entry.key`.
 * 2. Keys on one side only → `added` / `removed`.
 * 3. Keys on both sides: compare the sorted `semanticEntry` projections
 *    (never whole entries, so a reformat-only change never appears);
 *    equal → no delta; equal once `file` is ignored → `moved`;
 *    otherwise → `changed`.
 * 4. A removed hook key and an added hook key with the same
 *    `hook:<event>:<matcher>:` prefix in the same file are paired into one
 *    `changed` delta (command changed).
 * 5. Direction table (`direction.ts`), then interpretations
 *    (`interpretations/`), then the verdict category.
 * 6. Partition into `added` / `removed` / `changed` / `unresolved`, sort
 *    by key, compute the summary (`verdict.ts`).
 *
 * The result is byte-deterministic through `canonical.ts`: the same two
 * snapshots always yield the same JSON. Pure; never mutates a snapshot.
 */

import { canonicalJson } from "./canonical.js";
import type { Category } from "./categories.js";
import { classifyDirection, changedFields } from "./direction.js";
import { semanticEntry, sortEntries } from "./entries.js";
import { applyInterpretations } from "./interpretations/index.js";
import { where } from "./interpretations/shared.js";
import { SCHEMA_VERSION, SEMANTICS_DOC_DATE, type ChangeKind, type Delta, type Diff, type DiffSide, type Entry, type Snapshot } from "./types.js";
import { computeVerdict, DEFAULT_VERDICT_OPTIONS, isUndecided, type VerdictOptions } from "./verdict.js";

interface RawDelta {
  key: string;
  kind: Entry["kind"];
  change: ChangeKind;
  base: Entry | null;
  head: Entry | null;
  notes: string[];
}

function groupByKey(entries: readonly Entry[]): Map<string, Entry[]> {
  const groups = new Map<string, Entry[]>();
  for (const entry of sortEntries(entries)) {
    const group = groups.get(entry.key);
    if (group === undefined) {
      groups.set(entry.key, [entry]);
    } else {
      group.push(entry);
    }
  }
  return groups;
}

/** Canonical text of a group's semantic projections (with file). */
function signature(group: readonly Entry[]): string {
  return canonicalJson(group.map(semanticEntry));
}

/** Canonical text of a group's values ignoring where they live. */
function valueSignature(group: readonly Entry[]): string {
  const projected = group.map((entry) => {
    const { file: _file, ...rest } = semanticEntry(entry);
    return canonicalJson(rest);
  });
  return projected.sort().join("");
}

function locations(group: readonly Entry[]): string {
  return group.map(where).join(", ");
}

function multiplicityNotes(side: "base" | "head", group: readonly Entry[]): string[] {
  return group.length > 1 ? [`key appears ${group.length} times on ${side}: ${locations(group)}`] : [];
}

function rawDeltas(base: Snapshot, head: Snapshot): RawDelta[] {
  const baseGroups = groupByKey(base.entries);
  const headGroups = groupByKey(head.entries);
  const keys = [...new Set([...baseGroups.keys(), ...headGroups.keys()])].sort();
  const deltas: RawDelta[] = [];
  for (const key of keys) {
    const baseGroup = baseGroups.get(key) ?? [];
    const headGroup = headGroups.get(key) ?? [];
    const baseEntry = baseGroup[0] ?? null;
    const headEntry = headGroup[0] ?? null;
    const notes = [...multiplicityNotes("base", baseGroup), ...multiplicityNotes("head", headGroup)];
    if (headEntry === null && baseEntry !== null) {
      deltas.push({ key, kind: baseEntry.kind, change: "removed", base: baseEntry, head: null, notes });
    } else if (baseEntry === null && headEntry !== null) {
      deltas.push({ key, kind: headEntry.kind, change: "added", base: null, head: headEntry, notes });
    } else if (baseEntry !== null && headEntry !== null && signature(baseGroup) !== signature(headGroup)) {
      if (valueSignature(baseGroup) === valueSignature(headGroup)) {
        notes.push(`identical value; location changed from ${locations(baseGroup)} to ${locations(headGroup)}`);
        deltas.push({ key, kind: headEntry.kind, change: "moved", base: baseEntry, head: headEntry, notes });
      } else {
        const fields = changedFields(baseEntry, headEntry);
        if (fields.length > 0 && baseGroup.length === 1 && headGroup.length === 1) {
          notes.push(`changed fields: ${fields.join(", ")}`);
        }
        deltas.push({ key, kind: headEntry.kind, change: "changed", base: baseEntry, head: headEntry, notes });
      }
    }
  }
  return pairHookCommandChanges(deltas);
}

/** Pair one removed and one added hook key sharing `hook:<event>:<matcher>:` and file into a `changed` delta. */
function pairHookCommandChanges(deltas: RawDelta[]): RawDelta[] {
  const prefixOf = (key: string): string => key.slice(0, key.lastIndexOf(":") + 1);
  const groups = new Map<string, { removed: RawDelta[]; added: RawDelta[] }>();
  for (const delta of deltas) {
    if (delta.kind !== "hook" || (delta.change !== "added" && delta.change !== "removed")) {
      continue;
    }
    const entry = delta.head ?? delta.base;
    if (entry === null) {
      continue;
    }
    const id = `${prefixOf(delta.key)}|${entry.file}`;
    const group = groups.get(id) ?? { removed: [], added: [] };
    group[delta.change].push(delta);
    groups.set(id, group);
  }
  const paired = new Set<RawDelta>();
  const replacements: RawDelta[] = [];
  for (const group of groups.values()) {
    const removed = group.removed[0];
    const added = group.added[0];
    if (group.removed.length === 1 && group.added.length === 1 && removed !== undefined && added !== undefined) {
      paired.add(removed);
      paired.add(added);
      replacements.push({
        key: added.key,
        kind: "hook",
        change: "changed",
        base: removed.base,
        head: added.head,
        notes: [...removed.notes, ...added.notes],
      });
    }
  }
  return [...deltas.filter((delta) => !paired.has(delta)), ...replacements];
}

/** The verdict category of a widening delta, by the rule that fired. */
export function categorize(delta: Delta): Category | null {
  if (delta.direction !== "widens") {
    return null;
  }
  switch (delta.rule) {
    case "D-allow-added":
      return delta.breadth === "whole_tool" ? "whole-tool-allow" : "scoped-allow";
    case "D-deny-removed":
      return "deny-removed";
    case "D-hook-added":
    case "D-hook-changed":
      return "hook";
    case "D-mcp-added":
    case "D-mcp-changed":
    case "D-enable-all-mcp":
      return "mcp";
    case "D-mode-widened":
      return "mode";
    case "D-dir-added":
      return "directory";
    case "D-hooks-reenabled":
      return "hooks-reenabled";
    default:
      return null;
  }
}

function withClassification(entry: Entry | null, delta: Delta): Entry | null {
  return entry === null ? null : { ...entry, breadth: delta.breadth, direction: delta.direction, tier: delta.tier };
}

function classify(raw: RawDelta, base: Snapshot, head: Snapshot): Delta {
  const direction = classifyDirection(raw.change, raw.kind, raw.key, raw.base, raw.head);
  const initial: Delta = {
    key: raw.key,
    kind: raw.kind,
    change: raw.change,
    base: raw.base,
    head: raw.head,
    direction: direction.direction,
    tier: direction.tier,
    breadth: raw.kind === "perm" ? "unknown" : null,
    breadth_tier: null,
    category: null,
    rule: direction.rule,
    interpretations: [],
    flags: [],
    notes: [...raw.notes, ...direction.notes],
  };
  const interpreted = applyInterpretations(initial, base, head);
  const categorized: Delta = { ...interpreted, category: categorize(interpreted) };
  return { ...categorized, base: withClassification(categorized.base, categorized), head: withClassification(categorized.head, categorized) };
}

function side(snapshot: Snapshot): DiffSide {
  return {
    sha: snapshot.origin.sha,
    origin: snapshot.origin,
    sources: snapshot.sources,
    assumptions: snapshot.assumptions,
    incomplete: snapshot.incomplete,
  };
}

function byKey(a: Delta, b: Delta): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Diff `base` against `head`. `options` drive the summary (`--fail-on`,
 * `--strict`); the deltas themselves do not depend on them. Never mutates
 * either snapshot; never reads files.
 */
export function diffSnapshots(base: Snapshot, head: Snapshot, options: VerdictOptions = DEFAULT_VERDICT_OPTIONS): Diff {
  const deltas = rawDeltas(base, head).map((raw) => classify(raw, base, head));
  const unresolved = deltas.filter(isUndecided).sort(byKey);
  const decided = deltas.filter((delta) => !isUndecided(delta));
  const lists = {
    added: decided.filter((delta) => delta.change === "added").sort(byKey),
    removed: decided.filter((delta) => delta.change === "removed").sort(byKey),
    changed: decided.filter((delta) => delta.change === "changed" || delta.change === "moved").sort(byKey),
    unresolved,
    incomplete: [...base.incomplete, ...head.incomplete],
  };
  const verdict = computeVerdict(lists, options);
  return {
    schema_version: SCHEMA_VERSION,
    semantics_doc_date: SEMANTICS_DOC_DATE,
    base: side(base),
    head: side(head),
    ...lists,
    summary: {
      expands: verdict.expands,
      categories: verdict.categories,
      verdict: verdict.verdict,
      exit_code: verdict.exit_code,
      fail_on: verdict.fail_on,
      strict: verdict.strict,
      reasons: verdict.reasons,
    },
  };
}

/** Every delta of a diff in one sorted list (for renderers and tests). */
export function allDeltas(diff: Diff): Delta[] {
  return [...diff.added, ...diff.removed, ...diff.changed, ...diff.unresolved].sort(byKey);
}
