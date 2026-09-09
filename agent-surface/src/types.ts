/**
 * Data shapes shared by every agent-surface module (plan §3.4 / §3.7, JG-143).
 *
 * This file declares fields only. Entry extraction (CS-B) and the diff (CS-C)
 * build on these shapes without changing them. Absent information is always
 * `null`, never `0`, `""`, or `{}`.
 */

/** A JSON primitive as produced by the JSONC parser. */
export type JsonPrimitive = string | number | boolean | null;

/** Any JSON value. Objects are prototype-less (`Object.create(null)`). */
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

/** A JSON object. Always created with a `null` prototype by the parser. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Snapshot schema version emitted by this package. */
export const SCHEMA_VERSION = 1;

/** Date of the Claude Code documentation the interpretations derive from (§3.6). */
export const SEMANTICS_DOC_DATE = "2026-09-07";

/**
 * What kind of control-surface entry a value represents.
 *
 * `unknown` is a top-level key (or nested shape) the extractor does not
 * model; it is surfaced, never dropped. `credential` marks a credential-like
 * literal that was redacted (its value is always "credential-like value
 * present").
 */
export type EntryKind =
  | "perm"
  | "mode"
  | "hook"
  | "mcp"
  | "dir"
  | "sandbox"
  | "env_key"
  | "helper"
  | "plugin_flag"
  | "unknown"
  | "credential";

/** Every entry kind, in the order the text renderer groups them. */
export const ENTRY_KINDS: readonly EntryKind[] = [
  "perm",
  "mode",
  "hook",
  "mcp",
  "dir",
  "sandbox",
  "env_key",
  "helper",
  "plugin_flag",
  "unknown",
  "credential",
];

/** Breadth of a permission rule (perm entries only). */
export type Breadth = "exact" | "prefix" | "whole_tool" | "glob" | "unknown";

/** Whether an entry widens or narrows the agent's control surface. */
export type Direction = "widens" | "narrows" | "neutral" | "unknown";

/** Confidence tier of a claim. `incomplete` is a scan state, not a tier. */
export type Tier = "proven" | "projected" | "unresolved";

/**
 * One control-surface entry (§3.4).
 *
 * `key` is the stable identity used for the keyed set difference, e.g.
 * `perm:allow:Bash(curl *)`, `hook:PreToolUse:<matcher>:<sha256(command)>`,
 * `mcp:<server-name>`, `dir:<path>`, `mode:defaultMode`.
 */
export interface Entry {
  kind: EntryKind;
  key: string;
  /**
   * Normalized value; original text is preserved inside it (`raw`), never
   * rewritten. Credential-like literals and every `env` value are replaced
   * by `<redacted>` before they reach this field.
   */
  value: JsonValue;
  /** Only meaningful for `perm` entries; `null` for every other kind. */
  breadth: Breadth | null;
  direction: Direction;
  tier: Tier;
  /** Repository-relative path of the file the entry came from. */
  file: string;
  /** 1-based line of the value in the source file, or `null` if unknown. */
  line: number | null;
  /** RFC 6901 JSON pointer of the value, or `null` if unknown. */
  json_pointer: string | null;
  /** Commit SHA the file was read at, or `null` for worktree/snapshot reads. */
  source_sha: string | null;
}

/** Where the bytes of a source came from. */
export type SourceOrigin = "git" | "worktree" | "snapshot";

/** Outcome of looking for one supported file. */
export type SourceStatus = "read" | "absent" | "ignored" | "incomplete";

/**
 * One candidate input file and what happened to it (§3.4 `sources[]`).
 *
 * `sha` is the resolved commit SHA for git reads, or the literal strings
 * `"worktree"` / `"snapshot"` for the other origins (JG-148).
 */
export interface Source {
  path: string;
  sha: string;
  /** Git blob object id when read from a ref; `null` otherwise. */
  blob: string | null;
  parsed: boolean;
  status: SourceStatus;
  /** Whether git tracks the file; `null` when not determinable (no repository). */
  tracked: boolean | null;
  /** Human-readable flag, e.g. the tracked `settings.local.json` notice. */
  note: string | null;
}

/**
 * A reason the scan cannot be rendered as "clean" (§3.4 `incomplete[]`).
 *
 * `lines` carries the 1-based line numbers involved (both lines for a
 * duplicate key), or `null` when the reason is not tied to a line.
 */
export interface Incomplete {
  path: string;
  reason: string;
  lines: number[] | null;
}

/** Identifies which side was scanned to produce a snapshot. */
export interface SnapshotOrigin {
  kind: SourceOrigin;
  /** The `--base` / `--head` / positional argument as given. */
  spec: string;
  /** Resolved commit SHA for git origins; `null` otherwise. */
  sha: string | null;
}

/** A parsed view of one side (§3.4 `Snapshot`). */
export interface Snapshot {
  schema_version: number;
  semantics_doc_date: string;
  min_claude_version: string | null;
  origin: SnapshotOrigin;
  /** Assumptions header (§3.7), printed once and stored verbatim. */
  assumptions: string[];
  sources: Source[];
  /** Sorted by `key`, then `file`, then `json_pointer` (see `sortEntries`). */
  entries: Entry[];
  incomplete: Incomplete[];
}

// ---- Diff shapes (plan §3.5, JG-153 / JG-155) ------------------------------

import type { Category } from "./categories.js";
import type { Flag } from "./interpretations/types.js";

/** How a key differs between base and head. `moved`: same key and value, different file. */
export type ChangeKind = "added" | "removed" | "changed" | "moved";

/**
 * One keyed difference between base and head (§3.5).
 *
 * `tier` is the confidence of the `direction` claim; `breadth_tier` the
 * confidence of the `breadth` claim (perm entries only, `null` otherwise).
 * The `Entry` copies in `base` / `head` carry the delta's classification.
 * `rule` names the direction rule (`D-…`) and `interpretations` the
 * interpretation / not-interpreted IDs that contributed (`I…`, `N-…`).
 */
export interface Delta {
  key: string;
  kind: EntryKind;
  change: ChangeKind;
  base: Entry | null;
  head: Entry | null;
  direction: Direction;
  tier: Tier;
  breadth: Breadth | null;
  breadth_tier: Tier | null;
  /** Verdict category; set only when `direction` is `widens`. */
  category: Category | null;
  rule: string;
  interpretations: string[];
  flags: Flag[];
  notes: string[];
}

/** The parts of a side's snapshot the diff carries (entries live inside the deltas). */
export interface DiffSide {
  /** Resolved commit SHA, or `null` for a worktree / snapshot-file side. */
  sha: string | null;
  origin: SnapshotOrigin;
  sources: Source[];
  assumptions: string[];
  incomplete: Incomplete[];
}

export type VerdictLabel = "no-change" | "pass" | "expands" | "undecided" | "incomplete";

/** Effective `--fail-on` set. */
export interface FailOn {
  categories: Category[];
  /** Whether projected widenings also fail (`--fail-on projected`). */
  projected: boolean;
}

export interface DiffSummary {
  /** True only when a `proven` `widens` delta sits in a failing category. */
  expands: boolean;
  /** Sorted unique categories of every widening delta, any tier. */
  categories: Category[];
  verdict: VerdictLabel;
  exit_code: number;
  fail_on: FailOn;
  strict: boolean;
  reasons: string[];
}

/**
 * Result of `diffSnapshots` (§3.5). Each delta appears in exactly one of
 * `added`, `removed`, `changed` (which also holds `moved`) or `unresolved`
 * (a delta the tool could not decide: tier not `proven`, or breadth
 * unresolved). Lists are sorted by key. `incomplete` is both sides'
 * `incomplete[]`, base first.
 */
export interface Diff {
  schema_version: number;
  semantics_doc_date: string;
  base: DiffSide;
  head: DiffSide;
  added: Delta[];
  removed: Delta[];
  changed: Delta[];
  unresolved: Delta[];
  incomplete: Incomplete[];
  summary: DiffSummary;
}
