/**
 * Discovery of the V0 input set at a side (plan §3.2 / §3.3 / §4.4, JG-149).
 *
 * Enumerates exactly `.claude/settings.json`, `.claude/settings.local.json`
 * (only when tracked by git) and `.mcp.json`, relative to the side's root.
 * Hooks are read from inside settings, so they need no file of their own.
 *
 * Never reads user (`~/.claude/settings.json`), managed, or `~/.claude.json`
 * files; never constructs a path outside the repository root; never follows
 * a symlink that leaves it.
 */

import {
  defaultFs,
  defaultSpawner,
  isTrackedInWorktree,
  readBlobAtRef,
  readWorktreeFile,
  type FileRead,
  type FsAdapter,
  type Side,
  type Spawner,
} from "./git.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_DEPTH, parseJsonc, type JsoncResult } from "./jsonc.js";
import type { Incomplete, Source } from "./types.js";

/** Role of a supported file. */
export type FileRole = "settings" | "settings_local" | "mcp";

export interface SupportedFile {
  /** Repository-relative, `/`-separated. Never absolute, never `..`. */
  path: string;
  role: FileRole;
  /** Included only when git tracks the file at the scanned side. */
  requires_tracked: boolean;
}

/** The complete V0 input set, in path order. */
export const SUPPORTED_FILES: readonly SupportedFile[] = [
  { path: ".claude/settings.json", role: "settings", requires_tracked: false },
  { path: ".claude/settings.local.json", role: "settings_local", requires_tracked: true },
  { path: ".mcp.json", role: "mcp", requires_tracked: false },
];

/** Flag recorded when a tracked `settings.local.json` is included. */
export const LOCAL_TRACKED_NOTE = "local file shared via Git (trust-held by Claude Code)";

/** Reason recorded when an untracked `settings.local.json` is skipped. */
export const LOCAL_UNTRACKED_NOTE = "ignored: not repository-controlled (untracked settings.local.json)";

/** One successfully read and parsed file, ready for entry extraction (CS-B). */
export interface Document {
  path: string;
  role: FileRole;
  text: string;
  parsed: JsoncResult;
  source: Source;
}

export interface Discovery {
  /** One record per supported file, sorted by path. */
  sources: Source[];
  /** Files whose bytes were read (parsed or not), sorted by path. */
  documents: Document[];
  incomplete: Incomplete[];
  /** Extra assumption lines produced by discovery (e.g. the tracked-local flag). */
  notes: string[];
}

export interface DiscoverDeps {
  spawner?: Spawner;
  fs?: FsAdapter;
  maxBytes?: number;
  maxDepth?: number;
}

function sourceOf(file: SupportedFile, sha: string, partial: Partial<Source>): Source {
  return {
    path: file.path,
    sha,
    blob: null,
    parsed: false,
    status: "absent",
    tracked: null,
    note: null,
    ...partial,
  };
}

interface ReadOutcome {
  source: Source;
  document: Document | null;
  incomplete: Incomplete[];
}

function parseRead(file: SupportedFile, sha: string, read: FileRead, tracked: boolean | null, deps: DiscoverDeps): ReadOutcome {
  if (read.status === "absent") {
    return { source: sourceOf(file, sha, { status: "absent", tracked: tracked === null ? null : false }), document: null, incomplete: [] };
  }
  if (read.status === "incomplete") {
    return {
      source: sourceOf(file, sha, { status: "incomplete", tracked, note: read.incomplete.reason }),
      document: null,
      incomplete: [read.incomplete],
    };
  }
  const parsed = parseJsonc(read.bytes, {
    path: file.path,
    maxBytes: deps.maxBytes ?? DEFAULT_MAX_BYTES,
    maxDepth: deps.maxDepth ?? DEFAULT_MAX_DEPTH,
  });
  const notes = [file.role === "settings_local" ? LOCAL_TRACKED_NOTE : null, read.note].filter(
    (note): note is string => note !== null,
  );
  const source = sourceOf(file, sha, {
    blob: read.blob,
    parsed: parsed.value !== undefined,
    status: "read",
    tracked,
    note: notes.length === 0 ? null : notes.join("; "),
  });
  const text = parsed.value === undefined ? "" : new TextDecoder("utf-8", { ignoreBOM: false }).decode(read.bytes);
  return {
    source,
    document: { path: file.path, role: file.role, text, parsed, source },
    incomplete: parsed.incomplete,
  };
}

function discoverGit(side: Extract<Side, { kind: "git" }>, deps: DiscoverDeps): Discovery {
  const spawner = deps.spawner ?? defaultSpawner;
  const outcomes = SUPPORTED_FILES.map((file) => {
    const read = readBlobAtRef(side.sha, file.path, side.cwd, spawner);
    const tracked = read.status === "present" ? true : read.status === "absent" ? false : null;
    return parseRead(file, side.sha, read, tracked, deps);
  });
  return collect(outcomes);
}

function discoverWorktree(side: Extract<Side, { kind: "worktree" }>, deps: DiscoverDeps): Discovery {
  const spawner = deps.spawner ?? defaultSpawner;
  const fs = deps.fs ?? defaultFs;
  const outcomes = SUPPORTED_FILES.map((file): ReadOutcome => {
    let tracked: boolean | null = null;
    let trackingNote: string | null = null;
    if (file.requires_tracked) {
      const probe = readWorktreeFile(side.root, file.path, fs, deps.maxBytes ?? DEFAULT_MAX_BYTES);
      if (probe.status === "absent") {
        return parseRead(file, "worktree", probe, null, deps);
      }
      const tracking = isTrackedInWorktree(side.root, file.path, spawner);
      tracked = tracking.tracked;
      trackingNote = tracking.note;
      if (tracked !== true) {
        const note = [LOCAL_UNTRACKED_NOTE, trackingNote].filter((item): item is string => item !== null).join("; ");
        return {
          source: sourceOf(file, "worktree", { status: "ignored", tracked, note }),
          document: null,
          incomplete: [],
        };
      }
      return parseRead(file, "worktree", probe, tracked, deps);
    }
    const read = readWorktreeFile(side.root, file.path, fs, deps.maxBytes ?? DEFAULT_MAX_BYTES);
    return parseRead(file, "worktree", read, null, deps);
  });
  return collect(outcomes);
}

function collect(outcomes: ReadOutcome[]): Discovery {
  const sorted = [...outcomes].sort((a, b) => (a.source.path < b.source.path ? -1 : a.source.path > b.source.path ? 1 : 0));
  const notes = sorted
    .filter((outcome) => outcome.source.status === "read" && outcome.source.path === ".claude/settings.local.json")
    .map(() => `${LOCAL_TRACKED_NOTE}: .claude/settings.local.json is tracked and included`);
  return {
    sources: sorted.map((outcome) => outcome.source),
    documents: sorted.flatMap((outcome) => (outcome.document === null ? [] : [outcome.document])),
    incomplete: sorted.flatMap((outcome) => outcome.incomplete),
    notes,
  };
}

/**
 * Discover and parse the supported files of `side`.
 *
 * For a snapshot side the saved `sources[]` / `incomplete[]` are returned as
 * recorded; no file is re-read. Never spawns anything but the allow-listed
 * git subcommands, and only inside the side's root.
 */
export function discover(side: Side, deps: DiscoverDeps = {}): Discovery {
  switch (side.kind) {
    case "git":
      return discoverGit(side, deps);
    case "worktree":
      return discoverWorktree(side, deps);
    case "snapshot":
      return { sources: side.snapshot.sources, documents: [], incomplete: side.snapshot.incomplete, notes: [] };
  }
}
