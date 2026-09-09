/**
 * Machine-readable output (JG-157, plan §3.4 / §3.5).
 *
 * `--json` for `snapshot`, `diff` and `check`. The value is the full
 * `Snapshot` or `Diff` (added / removed / changed / unresolved / summary,
 * plus both sides' `assumptions`, `sources` and `incomplete`), serialized
 * through `canonical.ts` (keys sorted recursively, entries already sorted
 * by key) after the shared output redaction (`render/shared.ts`, backed
 * by `redact.ts`). Two runs on identical input are byte-identical.
 *
 * An incomplete scan is still valid JSON with `incomplete[]` populated;
 * the exit code (3) is the caller's responsibility.
 */

import { canonicalJson } from "../canonical.js";
import type { Diff, Incomplete, Snapshot } from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import { redactOutputTree } from "./shared.js";

/** Canonical JSON text of any value, redacted. Ends with a newline. */
export function renderJson(value: unknown): string {
  return canonicalJson(redactOutputTree(value));
}

/** `snapshot --json`. */
export function renderSnapshotJson(snapshot: Snapshot): string {
  return renderJson(snapshot);
}

/** `diff --json` / `check --json`: the full `Diff` plus the command name. */
export function renderDiffJson(command: "diff" | "check", diff: Diff): string {
  return renderJson({ command, ...diff });
}

/** JSON emitted when a side could not be resolved at all (missing ref, unreadable snapshot file). */
export function renderIncompleteJson(incomplete: readonly Incomplete[]): string {
  return renderJson({ schema_version: SCHEMA_VERSION, incomplete });
}
