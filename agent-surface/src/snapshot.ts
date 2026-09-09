/**
 * Snapshot construction (plan §3.4 / §3.7).
 *
 * Runs discovery for one side and wraps the result in a `Snapshot` with the
 * assumptions header. Entry extraction is CS-B: `entries` is empty here and
 * `documents` carries the parsed files for that step.
 */

import { discover, type DiscoverDeps, type Document } from "./discover.js";
import type { Side } from "./git.js";
import { SCHEMA_VERSION, SEMANTICS_DOC_DATE, type Snapshot } from "./types.js";

/** Assumptions header (§3.7), printed once and stored in `Snapshot.assumptions`. */
export const BASE_ASSUMPTIONS: readonly string[] = [
  `semantics: interpretations derive from the Claude Code documentation dated ${SEMANTICS_DOC_DATE}`,
  "scope: repository-controlled files only (.claude/settings.json, tracked .claude/settings.local.json, .mcp.json)",
  "trust: workspace trust is assumed accepted",
  "mode: runtime mode is defaultMode as written in head; CLI flags are not modeled",
  "sandbox: not modeled",
  "hooks: presence only; commands are recorded, never executed",
  "not read: managed settings, user settings (~/.claude), ~/.claude.json, untracked settings.local.json",
  "plugins: not modeled (flagged when enabledPlugins is non-empty)",
];

export interface SnapshotResult {
  snapshot: Snapshot;
  /** Parsed documents for entry extraction; empty for snapshot-file sides. */
  documents: Document[];
}

/**
 * Take a snapshot of `side`. Deterministic: the same side content yields the
 * same object. Never mutates a snapshot loaded from a file.
 *
 * For a `snapshot.json` side the saved sources, entries and incomplete
 * records are carried through verbatim (they are the evidence of the
 * original scan); only `origin` is rewritten to kind `snapshot` so the
 * output says where this side came from.
 */
export function takeSnapshot(side: Side, deps: DiscoverDeps = {}): SnapshotResult {
  if (side.kind === "snapshot") {
    const originalSha = side.snapshot.origin.sha;
    return {
      snapshot: {
        ...side.snapshot,
        origin: { kind: "snapshot", spec: side.spec, sha: typeof originalSha === "string" ? originalSha : null },
      },
      documents: [],
    };
  }
  const discovery = discover(side, deps);
  const snapshot: Snapshot = {
    schema_version: SCHEMA_VERSION,
    semantics_doc_date: SEMANTICS_DOC_DATE,
    min_claude_version: null,
    origin: { kind: side.kind, spec: side.spec, sha: side.kind === "git" ? side.sha : null },
    assumptions: [...BASE_ASSUMPTIONS, ...discovery.notes],
    sources: discovery.sources,
    entries: [],
    incomplete: discovery.incomplete,
  };
  return { snapshot, documents: discovery.documents };
}
