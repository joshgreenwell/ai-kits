/** Helpers for the CS-C tests: build git repositories from `fixtures/diff/<case>/{base,head}`. */

import * as fs from "node:fs";
import * as path from "node:path";

import { diffSnapshots } from "../src/diff.js";
import { takeSnapshot } from "../src/snapshot.js";
import type { Delta, Diff, Snapshot } from "../src/types.js";
import type { VerdictOptions } from "../src/verdict.js";
import { commitAll, FIXTURES, initRepo, removeDir, tempDir } from "./helpers.js";

export const DIFF_FIXTURES = path.join(FIXTURES, "diff");

export interface DiffRepo {
  dir: string;
  baseSha: string;
  headSha: string;
}

/** Every case directory under `fixtures/diff`, sorted. */
export function diffCases(): string[] {
  return fs
    .readdirSync(DIFF_FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function clearWorktree(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    if (name !== ".git") {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

/**
 * A temp repository with two commits: `base/` then `head/` of the named
 * case. Files are tracked, so a `settings.local.json` counts as tracked.
 */
export function makeDiffRepo(name: string): DiffRepo {
  return makePairRepo(path.join(DIFF_FIXTURES, name));
}

/** The same two-commit repository for any directory holding `base/` and `head/` (also used by the golden suite). */
export function makePairRepo(caseDir: string): DiffRepo {
  const name = path.basename(caseDir);
  const dir = tempDir();
  initRepo(dir);
  fs.cpSync(path.join(caseDir, "base"), dir, { recursive: true });
  const baseSha = commitAll(dir, `${name}: base`);
  clearWorktree(dir);
  fs.cpSync(path.join(caseDir, "head"), dir, { recursive: true });
  const headSha = commitAll(dir, `${name}: head`);
  return { dir, baseSha, headSha };
}

export function snapshotAt(repo: DiffRepo, sha: string): Snapshot {
  return takeSnapshot({ kind: "git", spec: sha, sha, cwd: repo.dir }).snapshot;
}

/** Cache of repositories per case so a suite builds each case once. */
export class DiffCases {
  private readonly repos = new Map<string, DiffRepo>();

  repo(name: string): DiffRepo {
    let repo = this.repos.get(name);
    if (repo === undefined) {
      repo = makeDiffRepo(name);
      this.repos.set(name, repo);
    }
    return repo;
  }

  snapshots(name: string): { base: Snapshot; head: Snapshot } {
    const repo = this.repo(name);
    return { base: snapshotAt(repo, repo.baseSha), head: snapshotAt(repo, repo.headSha) };
  }

  diff(name: string, options?: VerdictOptions): Diff {
    const { base, head } = this.snapshots(name);
    return options === undefined ? diffSnapshots(base, head) : diffSnapshots(base, head, options);
  }

  cleanup(): void {
    for (const repo of this.repos.values()) {
      removeDir(repo.dir);
    }
    this.repos.clear();
  }
}

/** Every delta of a diff, sorted by key. */
export function deltasOf(diff: Diff): Delta[] {
  return [...diff.added, ...diff.removed, ...diff.changed, ...diff.unresolved].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The single delta whose key matches (string or regex); throws when absent or ambiguous. */
export function deltaFor(diff: Diff, key: string | RegExp): Delta {
  const matches = deltasOf(diff).filter((delta) => (typeof key === "string" ? delta.key === key : key.test(delta.key)));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one delta for ${String(key)}, found ${matches.length}: ${deltasOf(diff).map((delta) => delta.key).join(", ")}`);
  }
  return matches[0] as Delta;
}

/** Which list a delta with this key sits in. */
export function listOf(diff: Diff, key: string | RegExp): "added" | "removed" | "changed" | "unresolved" | null {
  for (const list of ["added", "removed", "changed", "unresolved"] as const) {
    if (diff[list].some((delta) => (typeof key === "string" ? delta.key === key : key.test(delta.key)))) {
      return list;
    }
  }
  return null;
}
