/**
 * Loading a saved `snapshot.json` as one side of a comparison (JG-148).
 *
 * V0 stub: reads the file, parses it, and validates the top-level shape.
 * Entries are carried through verbatim; nothing is re-interpreted.
 */

import { parseJsonc } from "./jsonc.js";
import { SCHEMA_VERSION, type Incomplete, type Snapshot } from "./types.js";

/** Filesystem surface needed here (a subset of `git.ts`' `FsAdapter`). */
export interface SnapshotFs {
  readFileSync(target: string): Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the list of shape problems; empty when `value` is a usable Snapshot. */
export function validateSnapshotShape(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) {
    return ["top level is not an object"];
  }
  if (value["schema_version"] !== SCHEMA_VERSION) {
    problems.push(`schema_version must be ${SCHEMA_VERSION}`);
  }
  if (typeof value["semantics_doc_date"] !== "string") {
    problems.push("semantics_doc_date must be a string");
  }
  if (!isRecord(value["origin"]) || typeof value["origin"]["kind"] !== "string") {
    problems.push("origin must be an object with a kind");
  }
  if (!Array.isArray(value["assumptions"]) || !value["assumptions"].every((item) => typeof item === "string")) {
    problems.push("assumptions must be an array of strings");
  }
  const sources = value["sources"];
  if (!Array.isArray(sources) || !sources.every((item) => isRecord(item) && typeof item["path"] === "string")) {
    problems.push("sources must be an array of {path, ...}");
  }
  const entries = value["entries"];
  if (!Array.isArray(entries) || !entries.every((item) => isRecord(item) && typeof item["key"] === "string")) {
    problems.push("entries must be an array of {key, ...}");
  }
  const incomplete = value["incomplete"];
  if (
    !Array.isArray(incomplete) ||
    !incomplete.every((item) => isRecord(item) && typeof item["path"] === "string" && typeof item["reason"] === "string")
  ) {
    problems.push("incomplete must be an array of {path, reason}");
  }
  return problems;
}

export type SnapshotLoad = { ok: true; snapshot: Snapshot } | { ok: false; incomplete: Incomplete };

/**
 * Read and validate a snapshot file. `spec` is the user-facing name used in
 * `incomplete[].path`. Never follows anything inside the file.
 */
export function loadSnapshotFile(abs: string, spec: string, fs: SnapshotFs): SnapshotLoad {
  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(abs);
  } catch (err) {
    const message = err instanceof Error ? err.message : "read failed";
    return { ok: false, incomplete: { path: spec, reason: `snapshot file could not be read: ${message}`, lines: null } };
  }
  const parsed = parseJsonc(bytes, { path: spec });
  if (parsed.value === undefined) {
    const first = parsed.incomplete[0];
    return {
      ok: false,
      incomplete: {
        path: spec,
        reason: `snapshot file is not valid JSON: ${first?.reason ?? "unknown"}`,
        lines: first?.lines ?? null,
      },
    };
  }
  const problems = validateSnapshotShape(parsed.value);
  if (problems.length > 0) {
    return {
      ok: false,
      incomplete: { path: spec, reason: `not a snapshot file: ${problems.join("; ")}`, lines: null },
    };
  }
  return { ok: true, snapshot: parsed.value as unknown as Snapshot };
}
