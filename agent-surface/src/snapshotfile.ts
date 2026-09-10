/**
 * Loading a saved `snapshot.json` as one side of a comparison (JG-148, JG-152).
 *
 * Reads the file, parses it, and validates the top-level shape. A file whose
 * `schema_version` is a number other than `SCHEMA_VERSION` is refused with
 * a dedicated mismatch message (exit 3 at the CLI); every other shape
 * problem is reported as "not a snapshot file". Entries are carried through
 * verbatim; nothing is re-interpreted and nothing inside the file is
 * followed or executed.
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

/**
 * The mismatch message for a snapshot written by another schema version, or
 * `null` when `value` is not an object or carries no numeric `schema_version`
 * (those cases are shape problems, not version mismatches).
 */
export function schemaVersionMismatch(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const version = value["schema_version"];
  if (typeof version !== "number" || version === SCHEMA_VERSION) {
    return null;
  }
  return `snapshot schema_version mismatch: file has schema_version ${version}, this version of agent-surface reads schema_version ${SCHEMA_VERSION}; re-run 'agent-surface snapshot --json' with this version`;
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
  if (
    !Array.isArray(entries) ||
    !entries.every(
      (item) => isRecord(item) && typeof item["kind"] === "string" && typeof item["key"] === "string" && typeof item["file"] === "string",
    )
  ) {
    problems.push("entries must be an array of {kind, key, file, ...}");
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
  const mismatch = schemaVersionMismatch(parsed.value);
  if (mismatch !== null) {
    return { ok: false, incomplete: { path: spec, reason: mismatch, lines: null } };
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
