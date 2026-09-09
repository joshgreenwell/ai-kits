/**
 * Git blob reader and side resolution (plan §3.3 / §3.8 / §3.9, JG-148).
 *
 * Reads supported files at a ref with `git show`, resolves refs with
 * `git rev-parse`, and checks tracking with `git ls-files`. Only these three
 * subcommands ever run, always as an argument array via `spawnSync` (never a
 * shell). Also reads a plain directory (worktree) with symlink awareness and
 * loads a saved `snapshot.json`.
 *
 * Never operates on textual `git diff`, never checks anything out, never
 * executes repository content, never expands environment variables, and
 * never reads outside the given root for worktree reads.
 */

import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as path from "node:path";

import { DEFAULT_MAX_BYTES } from "./jsonc.js";
import { loadSnapshotFile } from "./snapshotfile.js";
import type { Incomplete, Snapshot } from "./types.js";

/** The only git subcommands this package is allowed to spawn. */
export const GIT_SUBCOMMANDS: readonly string[] = ["show", "rev-parse", "ls-files"];

/** Upper bound on bytes accepted from a single git invocation. */
export const GIT_MAX_BUFFER = 4 * DEFAULT_MAX_BYTES;

/** Outcome of one git process. */
export interface SpawnResult {
  status: number | null;
  stdout: Uint8Array;
  stderr: string;
  /** Spawn-level failure (e.g. git not installed, output too large). */
  error: Error | null;
}

/** Spawn options passed through to the process runner. Never includes a shell. */
export interface SpawnOptions {
  cwd: string;
  maxBuffer: number;
}

/**
 * Process runner signature. Injected in tests to prove which commands run;
 * the command is always the literal `"git"` and `args` an argument array.
 */
export type Spawner = (command: "git", args: readonly string[], options: SpawnOptions) => SpawnResult;

/** Thrown when code inside this package asks for a non-allow-listed subcommand. */
export class GitInvocationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitInvocationRefused";
  }
}

/** Default runner: `child_process.spawnSync` with `shell: false`. */
export const defaultSpawner: Spawner = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    maxBuffer: options.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? new Uint8Array(0),
    stderr: result.stderr ? Buffer.from(result.stderr).toString("utf8") : "",
    error: result.error ?? null,
  };
};

/**
 * Run `git <args>` in `cwd`. Refuses any subcommand outside
 * {@link GIT_SUBCOMMANDS} before spawning anything.
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  spawner: Spawner = defaultSpawner,
  maxBuffer: number = GIT_MAX_BUFFER,
): SpawnResult {
  const subcommand = args[0];
  if (subcommand === undefined || !GIT_SUBCOMMANDS.includes(subcommand)) {
    throw new GitInvocationRefused(
      `refusing to run "git ${subcommand ?? ""}": only ${GIT_SUBCOMMANDS.join(", ")} are allow-listed`,
    );
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new GitInvocationRefused("git arguments must be strings");
    }
  }
  return spawner("git", args, { cwd, maxBuffer });
}

function incompleteOf(pathValue: string, reason: string): Incomplete {
  return { path: pathValue, reason, lines: null };
}

function stderrHint(result: SpawnResult): string {
  const line = result.stderr.trim().split(/\r?\n/, 1)[0] ?? "";
  return line === "" ? "" : ` (git: ${line})`;
}

function spawnFailure(result: SpawnResult): string {
  const err = result.error as (Error & { code?: string }) | null;
  if (err === null) {
    return "git failed";
  }
  if (err.code === "ENOENT") {
    return "git is not available on PATH";
  }
  if (err.code === "ENOBUFS") {
    return `git output exceeds size limit (${GIT_MAX_BUFFER} bytes)`;
  }
  return `git could not be run (${err.code ?? err.message})`;
}

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** A resolved ref or the reason it could not be resolved. */
export type RefResolution = { ok: true; sha: string } | { ok: false; incomplete: Incomplete };

/**
 * Resolve `ref` to a commit SHA with `git rev-parse --verify`.
 *
 * Refs are passed as a single argv element after `--end-of-options`, so
 * shell metacharacters are never interpreted and option-like spellings
 * (`-x`, `--output=…`) are rejected before git is spawned.
 */
export function resolveRef(ref: string, cwd: string, spawner: Spawner = defaultSpawner): RefResolution {
  if (ref === "" || ref.startsWith("-") || /[\0\r\n]/.test(ref)) {
    return { ok: false, incomplete: incompleteOf(ref, "missing ref: invalid ref spelling") };
  }
  const result = runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd, spawner);
  if (result.error !== null) {
    return { ok: false, incomplete: incompleteOf(ref, `missing ref: ${spawnFailure(result)}`) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      incomplete: incompleteOf(ref, `missing ref: '${ref}' does not resolve to a commit${stderrHint(result)}`),
    };
  }
  const sha = Buffer.from(result.stdout).toString("utf8").trim();
  if (!SHA_PATTERN.test(sha)) {
    return { ok: false, incomplete: incompleteOf(ref, `missing ref: git returned an unexpected object id`) };
  }
  return { ok: true, sha };
}

/** Result of reading one file from a side. Absent is a valid input, not an error. */
export type FileRead =
  | { status: "present"; bytes: Uint8Array; blob: string | null; note: string | null }
  | { status: "absent" }
  | { status: "incomplete"; incomplete: Incomplete };

/**
 * Read `rel` (repository-relative, `/`-separated) at commit `sha`.
 *
 * Missing path → `absent`. A path that names a tree (directory) → `incomplete`.
 * Note: at a ref a symlink is a blob holding the link target, which is
 * reported by the parser as unparseable (`incomplete`), never followed.
 */
export function readBlobAtRef(sha: string, rel: string, cwd: string, spawner: Spawner = defaultSpawner): FileRead {
  const lookup = runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}:${rel}`], cwd, spawner);
  if (lookup.error !== null) {
    return { status: "incomplete", incomplete: incompleteOf(rel, spawnFailure(lookup)) };
  }
  if (lookup.status !== 0) {
    return { status: "absent" };
  }
  const objectId = Buffer.from(lookup.stdout).toString("utf8").trim();
  if (!SHA_PATTERN.test(objectId)) {
    return { status: "incomplete", incomplete: incompleteOf(rel, "git returned an unexpected object id") };
  }
  const peel = runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${objectId}^{blob}`], cwd, spawner);
  if (peel.error !== null) {
    return { status: "incomplete", incomplete: incompleteOf(rel, spawnFailure(peel)) };
  }
  if (peel.status !== 0) {
    return {
      status: "incomplete",
      incomplete: incompleteOf(rel, `'${rel}' at ${sha.slice(0, 12)} is not a file (tree object)`),
    };
  }
  const show = runGit(["show", "--end-of-options", objectId], cwd, spawner);
  if (show.error !== null) {
    return { status: "incomplete", incomplete: incompleteOf(rel, spawnFailure(show)) };
  }
  if (show.status !== 0) {
    return { status: "incomplete", incomplete: incompleteOf(rel, `git show failed${stderrHint(show)}`) };
  }
  return { status: "present", bytes: show.stdout, blob: objectId, note: null };
}

/** Minimal filesystem surface used for worktree reads; injectable for tests. */
export interface FsAdapter {
  lstatSync(target: string): nodeFs.Stats;
  statSync(target: string): nodeFs.Stats;
  realpathSync(target: string): string;
  readFileSync(target: string): Uint8Array;
}

/** Real `node:fs` bindings. */
export const defaultFs: FsAdapter = {
  lstatSync: (target) => nodeFs.lstatSync(target),
  statSync: (target) => nodeFs.statSync(target),
  realpathSync: (target) => nodeFs.realpathSync(target),
  readFileSync: (target) => nodeFs.readFileSync(target),
};

function errorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return null;
}

function describeFsError(err: unknown): string {
  const code = errorCode(err);
  if (code === "EACCES" || code === "EPERM") {
    return `permission denied (${code})`;
  }
  return code ?? (err instanceof Error ? err.message : "unknown filesystem error");
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Read `rel` from directory `root` with symlink awareness.
 *
 * The real path of the file must stay inside the real path of `root`;
 * a symlink (at any path component) that escapes the root is `incomplete`,
 * a symlink that stays inside is read and noted. Permission errors and
 * oversized files are `incomplete`. Nothing outside `root` is ever opened.
 */
export function readWorktreeFile(
  root: string,
  rel: string,
  fs: FsAdapter = defaultFs,
  maxBytes: number = DEFAULT_MAX_BYTES,
): FileRead {
  const abs = path.join(root, ...rel.split("/"));
  const fail = (reason: string): FileRead => ({ status: "incomplete", incomplete: incompleteOf(rel, reason) });

  try {
    fs.lstatSync(abs);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "absent" };
    }
    return fail(describeFsError(err));
  }

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(root);
  } catch (err) {
    return fail(`repository root cannot be resolved: ${describeFsError(err)}`);
  }

  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return fail("symlink target does not exist (dangling symlink)");
    }
    return fail(describeFsError(err));
  }

  const expected = path.join(rootReal, ...rel.split("/"));
  const symlinked = real !== expected;
  if (symlinked && !isInside(rootReal, real)) {
    return fail(`symlink resolves outside the repository root (${rel} -> ${path.relative(rootReal, real)})`);
  }

  let stats: nodeFs.Stats;
  try {
    stats = fs.statSync(real);
  } catch (err) {
    return fail(describeFsError(err));
  }
  if (!stats.isFile()) {
    return fail("not a regular file");
  }
  if (stats.size > maxBytes) {
    return fail(`input exceeds size limit (${stats.size} bytes > ${maxBytes} bytes)`);
  }

  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(real);
  } catch (err) {
    return fail(`read failed: ${describeFsError(err)}`);
  }
  const note = symlinked ? `symlink: ${rel} -> ${path.relative(rootReal, real).split(path.sep).join("/")}` : null;
  return { status: "present", bytes, blob: null, note };
}

/** Whether git tracks `rel` in the worktree at `root`; `null` if there is no repository. */
export interface TrackedResult {
  tracked: boolean | null;
  note: string | null;
}

/** Check tracking with `git ls-files` run inside `root`. Never reads the file. */
export function isTrackedInWorktree(root: string, rel: string, spawner: Spawner = defaultSpawner): TrackedResult {
  const result = runGit(["ls-files", "-z", "--", rel], root, spawner);
  if (result.error !== null) {
    return { tracked: null, note: `tracking unknown: ${spawnFailure(result)}` };
  }
  if (result.status !== 0) {
    return { tracked: null, note: "tracking unknown: not a git repository" };
  }
  const names = Buffer.from(result.stdout).toString("utf8").split("\0").filter((name) => name !== "");
  return { tracked: names.includes(rel), note: null };
}

/** One side of a comparison after resolution. */
export type Side =
  | { kind: "git"; spec: string; sha: string; cwd: string }
  | { kind: "worktree"; spec: string; root: string }
  | { kind: "snapshot"; spec: string; path: string; snapshot: Snapshot };

export type SideResolution = { ok: true; side: Side } | { ok: false; incomplete: Incomplete };

export interface ResolveDeps {
  /** Directory git commands run in and relative paths resolve against. */
  cwd: string;
  spawner?: Spawner;
  fs?: FsAdapter;
}

/**
 * Resolve a `--base` / `--head` argument.
 *
 * An existing directory is a worktree, an existing file is a saved
 * `snapshot.json`, anything else is treated as a git ref. A ref that does
 * not resolve yields `incomplete: missing ref`.
 */
export function resolveSide(spec: string, deps: ResolveDeps): SideResolution {
  const fs = deps.fs ?? defaultFs;
  const spawner = deps.spawner ?? defaultSpawner;
  const abs = path.resolve(deps.cwd, spec);
  let stats: nodeFs.Stats | null = null;
  try {
    stats = fs.statSync(abs);
  } catch {
    stats = null;
  }
  if (stats !== null && stats.isDirectory()) {
    return { ok: true, side: { kind: "worktree", spec, root: abs } };
  }
  if (stats !== null && stats.isFile()) {
    const loaded = loadSnapshotFile(abs, spec, fs);
    if (!loaded.ok) {
      return loaded;
    }
    return { ok: true, side: { kind: "snapshot", spec, path: abs, snapshot: loaded.snapshot } };
  }
  const resolved = resolveRef(spec, deps.cwd, spawner);
  if (!resolved.ok) {
    return resolved;
  }
  return { ok: true, side: { kind: "git", spec, sha: resolved.sha, cwd: deps.cwd } };
}
