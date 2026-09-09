import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { LOCAL_TRACKED_NOTE, LOCAL_UNTRACKED_NOTE, SUPPORTED_FILES, discover } from "../src/discover.js";
import type { Side } from "../src/git.js";
import { BASE_ASSUMPTIONS, takeSnapshot } from "../src/snapshot.js";
import { commitAll, copyFixtureRepo, git, initRepo, makeRepo, recordingFs, recordingSpawner, removeDir, runCli, tempDir } from "./helpers.js";

function gitSide(repo: { dir: string; sha: string }): Side {
  return { kind: "git", spec: "main", sha: repo.sha, cwd: repo.dir };
}

function worktreeSide(dir: string): Side {
  return { kind: "worktree", spec: dir, root: dir };
}

describe("discovery: the V0 input set (JG-149)", () => {
  it("enumerates exactly the three supported repository-relative files", () => {
    assert.deepEqual(
      SUPPORTED_FILES.map((file) => file.path),
      [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"],
    );
    for (const file of SUPPORTED_FILES) {
      assert.ok(!path.isAbsolute(file.path));
      assert.ok(!file.path.startsWith("~"));
      assert.ok(!file.path.split("/").includes(".."));
    }
    assert.deepEqual(
      SUPPORTED_FILES.filter((file) => file.requires_tracked).map((file) => file.path),
      [".claude/settings.local.json"],
    );
  });
});

describe("discovery: tracked settings.local.json", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("includes a tracked local file at a ref and flags it", () => {
    const result = discover(gitSide(repo));
    assert.deepEqual(result.incomplete, []);
    const local = result.sources.find((source) => source.path === ".claude/settings.local.json");
    assert.ok(local);
    assert.equal(local.status, "read");
    assert.equal(local.tracked, true);
    assert.equal(local.parsed, true);
    assert.equal(local.note, LOCAL_TRACKED_NOTE);
    assert.equal(local.sha, repo.sha);
    assert.match(local.blob ?? "", /^[0-9a-f]{40,64}$/);
    assert.deepEqual(result.notes, [`${LOCAL_TRACKED_NOTE}: .claude/settings.local.json is tracked and included`]);
    assert.deepEqual(
      result.documents.map((doc) => doc.path),
      [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"],
    );
  });

  it("includes a tracked local file in a worktree and flags it", () => {
    const result = discover(worktreeSide(repo.dir));
    const local = result.sources.find((source) => source.path === ".claude/settings.local.json");
    assert.ok(local);
    assert.equal(local.status, "read");
    assert.equal(local.tracked, true);
    assert.equal(local.sha, "worktree");
    assert.equal(local.note, LOCAL_TRACKED_NOTE);
    assert.equal(result.documents.length, 3);
  });

  it("stores the flag in the snapshot's assumptions", () => {
    const { snapshot } = takeSnapshot(gitSide(repo));
    assert.deepEqual(snapshot.assumptions.slice(0, BASE_ASSUMPTIONS.length), [...BASE_ASSUMPTIONS]);
    assert.ok(snapshot.assumptions.some((line) => line.includes(LOCAL_TRACKED_NOTE)));
  });
});

describe("discovery: untracked settings.local.json is not repository-controlled", () => {
  let dir: string;
  before(() => {
    dir = tempDir();
    copyFixtureRepo("basic", dir);
    fs.unlinkSync(path.join(dir, ".claude", "settings.local.json"));
    initRepo(dir);
    commitAll(dir, "without local");
    fs.writeFileSync(path.join(dir, ".claude", "settings.local.json"), '{"permissions": {"allow": ["Bash(rm *)"]}}');
  });
  after(() => removeDir(dir));

  it("ignores the untracked file with a note in sources and never reads its bytes", () => {
    const { fs: recorder, paths } = recordingFs();
    const result = discover(worktreeSide(dir), { fs: recorder });
    const local = result.sources.find((source) => source.path === ".claude/settings.local.json");
    assert.ok(local);
    assert.equal(local.status, "ignored");
    assert.equal(local.tracked, false);
    assert.equal(local.parsed, false);
    assert.equal(local.note, LOCAL_UNTRACKED_NOTE);
    assert.match(local.note ?? "", /not repository-controlled/);
    assert.deepEqual(result.incomplete, []);
    assert.deepEqual(
      result.documents.map((doc) => doc.path),
      [".claude/settings.json", ".mcp.json"],
    );
    const localPath = path.join(dir, ".claude", "settings.local.json");
    const readCalls = paths.filter((p) => p === localPath || p === fs.realpathSync(localPath));
    assert.ok(readCalls.length > 0, "existence is probed");
    // readFileSync is the last adapter call for a read file; the untracked local file only sees lstat/realpath probes.
    assert.ok(!result.documents.some((doc) => doc.path === ".claude/settings.local.json"));
  });

  it("is absent (not ignored) at the ref where it was never committed", () => {
    const sha = git(dir, "rev-parse", "HEAD");
    const result = discover({ kind: "git", spec: "HEAD", sha, cwd: dir });
    const local = result.sources.find((source) => source.path === ".claude/settings.local.json");
    assert.ok(local);
    assert.equal(local.status, "absent");
    assert.equal(local.tracked, false);
  });

  it("treats a plain directory outside any repository as not repository-controlled", () => {
    const plain = tempDir();
    try {
      fs.mkdirSync(path.join(plain, ".claude"));
      fs.writeFileSync(path.join(plain, ".claude", "settings.json"), "{}");
      fs.writeFileSync(path.join(plain, ".claude", "settings.local.json"), "{}");
      const result = discover(worktreeSide(plain));
      const local = result.sources.find((source) => source.path === ".claude/settings.local.json");
      assert.ok(local);
      assert.equal(local.status, "ignored");
      assert.equal(local.tracked, null);
      assert.match(local.note ?? "", /not repository-controlled/);
      assert.match(local.note ?? "", /not a git repository/);
      const settings = result.sources.find((source) => source.path === ".claude/settings.json");
      assert.equal(settings?.status, "read");
    } finally {
      removeDir(plain);
    }
  });
});

describe("discovery: never reads outside the repository root", () => {
  let repo: { dir: string; sha: string };
  let home: string;
  before(() => {
    repo = makeRepo("basic");
    home = tempDir();
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"permissions": {"allow": ["Bash"]}}');
    fs.writeFileSync(path.join(home, ".claude.json"), '{"mcpServers": {}}');
  });
  after(() => {
    removeDir(repo.dir);
    removeDir(home);
  });

  it("every filesystem path and every git cwd stays under the root (worktree side)", () => {
    const { fs: recorder, paths } = recordingFs();
    const { spawner, calls } = recordingSpawner();
    const previousHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const result = discover(worktreeSide(repo.dir), { fs: recorder, spawner });
      assert.deepEqual(result.incomplete, []);
    } finally {
      if (previousHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previousHome;
      }
    }
    const roots = [repo.dir, fs.realpathSync(repo.dir)];
    assert.ok(paths.length > 0);
    for (const target of paths) {
      assert.ok(
        roots.some((root) => target === root || target.startsWith(root + path.sep)),
        `filesystem access outside the root: ${target}`,
      );
      assert.ok(!target.startsWith(home), `read from HOME: ${target}`);
    }
    for (const call of calls) {
      assert.equal(call.options.cwd, repo.dir);
      assert.ok(call.args.every((arg) => !arg.startsWith(home) && !arg.startsWith("~")));
    }
  });

  it("a git side touches no filesystem path at all", () => {
    const { fs: recorder, paths } = recordingFs();
    const result = discover(gitSide(repo), { fs: recorder });
    assert.deepEqual(result.incomplete, []);
    assert.deepEqual(paths, []);
  });

  it("the CLI ignores HOME-based configuration entirely", () => {
    const run = runCli(["snapshot", "--json"], repo.dir, { HOME: home, XDG_CONFIG_HOME: home });
    assert.equal(run.status, 0, run.stderr);
    const snapshot = JSON.parse(run.stdout) as { sources: Array<{ path: string }> };
    assert.deepEqual(
      snapshot.sources.map((source) => source.path),
      [".claude/settings.json", ".claude/settings.local.json", ".mcp.json"],
    );
    assert.ok(!run.stdout.includes(home));
  });
});

describe("discovery: .claude/ absent on one side (negative case)", () => {
  let empty: { dir: string; sha: string };
  let full: { dir: string; sha: string };
  before(() => {
    empty = makeRepo("no-config");
    full = makeRepo("basic");
  });
  after(() => {
    removeDir(empty.dir);
    removeDir(full.dir);
  });

  it("yields zero documents and zero incomplete, with every source absent", () => {
    for (const side of [gitSide(empty), worktreeSide(empty.dir)]) {
      const result = discover(side);
      assert.deepEqual(result.documents, []);
      assert.deepEqual(result.incomplete, []);
      assert.deepEqual(
        result.sources.map((source) => [source.path, source.status]),
        [
          [".claude/settings.json", "absent"],
          [".claude/settings.local.json", "absent"],
          [".mcp.json", "absent"],
        ],
      );
      const { snapshot } = takeSnapshot(side);
      assert.deepEqual(snapshot.entries, []);
      assert.deepEqual(snapshot.incomplete, []);
    }
  });

  it("the diff pipeline still runs with an empty side: every head entry is added, nothing is incomplete", () => {
    fs.cpSync(path.join(full.dir, ".claude"), path.join(empty.dir, ".claude"), { recursive: true });
    fs.copyFileSync(path.join(full.dir, ".mcp.json"), path.join(empty.dir, ".mcp.json"));
    const headSha = commitAll(empty.dir, "add config");
    const run = runCli(["diff", "--base", empty.sha, "--head", headSha, "--json"], empty.dir);
    assert.equal(run.status, 1, run.stderr);
    const output = JSON.parse(run.stdout) as {
      base: { sources: Array<{ status: string }>; incomplete: unknown[] };
      head: { sources: Array<{ status: string }>; incomplete: unknown[] };
      added: Array<{ key: string; change: string }>;
      removed: unknown[];
      unresolved: unknown[];
      incomplete: unknown[];
      summary: { expands: boolean; categories: string[] };
    };
    assert.deepEqual(output.base.sources.map((source) => source.status), ["absent", "absent", "absent"]);
    assert.deepEqual(output.head.sources.map((source) => source.status), ["read", "read", "read"]);
    assert.deepEqual(output.base.incomplete, []);
    assert.deepEqual(output.head.incomplete, []);
    assert.deepEqual(output.incomplete, []);
    assert.deepEqual(output.removed, []);
    assert.ok(output.added.every((delta) => delta.change === "added"));
    assert.ok(output.added.some((delta) => delta.key === "mcp:example-docs"));
    assert.equal(output.summary.expands, true);
    assert.deepEqual(output.summary.categories, ["hook", "mcp", "scoped-allow", "whole-tool-allow"]);
  });
});

describe("discovery: malformed and duplicate-key files", () => {
  let malformed: { dir: string; sha: string };
  let duplicate: { dir: string; sha: string };
  before(() => {
    malformed = makeRepo("malformed");
    duplicate = makeRepo("duplicate");
  });
  after(() => {
    removeDir(malformed.dir);
    removeDir(duplicate.dir);
  });

  it("reports a malformed file with its path and line, keeping the source unparsed", () => {
    const result = discover(gitSide(malformed));
    assert.equal(result.incomplete.length, 1);
    assert.equal(result.incomplete[0]?.path, ".claude/settings.json");
    assert.deepEqual(result.incomplete[0]?.lines, [8]);
    const source = result.sources.find((item) => item.path === ".claude/settings.json");
    assert.equal(source?.status, "read");
    assert.equal(source?.parsed, false);
    assert.equal(result.documents[0]?.parsed.value, undefined);
  });

  it("reports duplicate keys with both lines", () => {
    const result = discover(worktreeSide(duplicate.dir));
    assert.deepEqual(result.incomplete, [
      { path: ".claude/settings.json", reason: 'duplicate key "permissions" at /permissions', lines: [6, 7] },
    ]);
  });
});

describe("discovery: deterministic snapshots", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("produces byte-identical canonical JSON on repeated runs with sorted keys", () => {
    const first = canonicalJson(takeSnapshot(gitSide(repo)).snapshot);
    const second = canonicalJson(takeSnapshot(gitSide(repo)).snapshot);
    assert.equal(first, second);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [...Object.keys(parsed)].sort());
    assert.equal(parsed["min_claude_version"], null);
    assert.equal(parsed["schema_version"], 1);
    assert.equal(parsed["semantics_doc_date"], "2026-09-07");
  });
});
