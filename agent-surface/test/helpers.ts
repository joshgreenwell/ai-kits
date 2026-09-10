/** Shared helpers for the compiled tests (run from `dist/test/`). */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { FsAdapter, SpawnOptions, SpawnResult, Spawner } from "../src/git.js";
import { defaultFs, defaultSpawner } from "../src/git.js";

export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));
export const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
export const PACKAGE_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-surface-"));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function readFixture(relative: string): Uint8Array {
  return fs.readFileSync(path.join(FIXTURES, relative));
}

/** Run git for fixture setup only (the package under test never uses this). */
export function git(dir: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(dir, ".no-global-gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
}

export function commitAll(dir: string, message: string): string {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export function copyFixtureRepo(name: string, dest: string): void {
  fs.cpSync(path.join(FIXTURES, "repos", name), dest, { recursive: true });
}

/** Create a temp git repository with one commit containing the named fixture. */
export function makeRepo(fixture: string): { dir: string; sha: string } {
  const dir = tempDir();
  copyFixtureRepo(fixture, dir);
  initRepo(dir);
  const sha = commitAll(dir, `add ${fixture}`);
  return { dir, sha };
}

export interface RecordedCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** A spawner that records every call and delegates to the real one. */
export function recordingSpawner(delegate: Spawner = defaultSpawner): { spawner: Spawner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawner: Spawner = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    return delegate(command, args, options);
  };
  return { spawner, calls };
}

/** A spawner that never runs anything and returns a fixed result. */
export function stubSpawner(result: Partial<SpawnResult>): { spawner: Spawner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spawner: Spawner = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    return { status: 0, stdout: new Uint8Array(0), stderr: "", error: null, ...result };
  };
  return { spawner, calls };
}

/** An fs adapter that records every path it is asked about. */
export function recordingFs(delegate: FsAdapter = defaultFs): { fs: FsAdapter; paths: string[] } {
  const paths: string[] = [];
  const adapter: FsAdapter = {
    lstatSync: (target) => {
      paths.push(target);
      return delegate.lstatSync(target);
    },
    statSync: (target) => {
      paths.push(target);
      return delegate.statSync(target);
    },
    realpathSync: (target) => {
      paths.push(target);
      return delegate.realpathSync(target);
    },
    readFileSync: (target) => {
      paths.push(target);
      return delegate.readFileSync(target);
    },
  };
  return { fs: adapter, paths };
}

export interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the compiled CLI as a child process. */
export function runCli(args: string[], cwd: string, env: Record<string, string> = {}): CliRun {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
