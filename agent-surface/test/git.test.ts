import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { discover } from "../src/discover.js";
import {
  GIT_SUBCOMMANDS,
  GitInvocationRefused,
  defaultFs,
  isTrackedInWorktree,
  readBlobAtRef,
  readWorktreeFile,
  resolveRef,
  resolveSide,
  runGit,
  type FsAdapter,
} from "../src/git.js";
import { parseJsonc } from "../src/jsonc.js";
import { takeSnapshot } from "../src/snapshot.js";
import { validateSnapshotShape } from "../src/snapshotfile.js";
import { git, makeRepo, recordingFs, recordingSpawner, removeDir, stubSpawner, tempDir } from "./helpers.js";

const METACHAR_REFS = [
  "main; touch pwned-marker",
  "$(touch pwned-marker)",
  "`touch pwned-marker`",
  "main && touch pwned-marker",
  "main | touch pwned-marker",
  "main > pwned-marker",
  "main\ttouch pwned-marker",
];

describe("git: only allow-listed subcommands ever run (JG-148)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("refuses every non-allow-listed subcommand before spawning", () => {
    const { spawner, calls } = stubSpawner({});
    for (const sub of ["log", "status", "diff", "checkout", "fetch", "push", "cat-file", "ls-tree", "-c", ""]) {
      assert.throws(() => runGit([sub, "x"], repo.dir, spawner), GitInvocationRefused);
    }
    assert.throws(() => runGit([], repo.dir, spawner), GitInvocationRefused);
    assert.equal(calls.length, 0);
  });

  it("spawns only git, with an argument array and no shell, across resolution and discovery", () => {
    const { spawner, calls } = recordingSpawner();
    const gitSide = resolveSide("main", { cwd: repo.dir, spawner });
    assert.ok(gitSide.ok);
    discover(gitSide.side, { spawner });
    const worktree = resolveSide(repo.dir, { cwd: repo.dir, spawner });
    assert.ok(worktree.ok);
    discover(worktree.side, { spawner });

    assert.ok(calls.length >= 5, `expected several git calls, got ${calls.length}`);
    for (const call of calls) {
      assert.equal(call.command, "git");
      assert.ok(Array.isArray(call.args));
      assert.ok(call.args.every((arg) => typeof arg === "string"));
      assert.ok(GIT_SUBCOMMANDS.includes(call.args[0] ?? ""), `unexpected subcommand ${call.args[0]}`);
      assert.deepEqual(Object.keys(call.options).sort(), ["cwd", "maxBuffer"]);
      assert.equal(call.options.cwd, repo.dir);
    }
    const subcommands = new Set(calls.map((call) => call.args[0]));
    assert.deepEqual([...subcommands].sort(), ["ls-files", "rev-parse", "show"]);
  });
});

describe("git: ref resolution", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("resolves a branch, HEAD and a full SHA to the commit SHA", () => {
    for (const ref of ["main", "HEAD", repo.sha, repo.sha.slice(0, 8)]) {
      const resolved = resolveRef(ref, repo.dir);
      assert.deepEqual(resolved, { ok: true, sha: repo.sha }, `ref ${ref}`);
    }
  });

  it("reports a missing ref as incomplete: missing ref", () => {
    const resolved = resolveRef("no-such-branch", repo.dir);
    assert.ok(!resolved.ok);
    assert.equal(resolved.incomplete.path, "no-such-branch");
    assert.match(resolved.incomplete.reason, /^missing ref: 'no-such-branch' does not resolve to a commit/);
    assert.equal(resolved.incomplete.lines, null);
  });

  it("rejects option-like and empty refs without spawning git", () => {
    const { spawner, calls } = stubSpawner({});
    for (const ref of ["", "-x", "--output=/tmp/x", "-"]) {
      const resolved = resolveRef(ref, repo.dir, spawner);
      assert.ok(!resolved.ok);
      assert.match(resolved.incomplete.reason, /missing ref: invalid ref spelling/);
    }
    assert.equal(calls.length, 0);
  });

  it("passes refs containing shell metacharacters through safely (negative case)", () => {
    for (const ref of METACHAR_REFS) {
      const { spawner, calls } = recordingSpawner();
      const resolved = resolveRef(ref, repo.dir, spawner);
      assert.ok(!resolved.ok, `ref ${JSON.stringify(ref)} must not resolve`);
      assert.match(resolved.incomplete.reason, /^missing ref/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.args.at(-1), `${ref}^{commit}`);
      assert.ok(!fs.existsSync(path.join(repo.dir, "pwned-marker")), "no side effect may occur");
    }
  });

  it("resolves a branch whose name contains metacharacters", () => {
    git(repo.dir, "branch", "feat;$(x)");
    assert.deepEqual(resolveRef("feat;$(x)", repo.dir), { ok: true, sha: repo.sha });
  });

  it("reports git being unavailable as incomplete", () => {
    const { spawner } = stubSpawner({ status: null, error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }) });
    const resolved = resolveRef("main", repo.dir, spawner);
    assert.ok(!resolved.ok);
    assert.match(resolved.incomplete.reason, /git is not available on PATH/);
  });
});

describe("git: reading blobs at a ref without checkout", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("reads a present file and records its blob id", () => {
    const read = readBlobAtRef(repo.sha, ".claude/settings.json", repo.dir);
    assert.equal(read.status, "present");
    if (read.status !== "present") {
      return;
    }
    assert.match(read.blob ?? "", /^[0-9a-f]{40,64}$/);
    assert.equal(read.blob, git(repo.dir, "rev-parse", "HEAD:.claude/settings.json"));
    const parsed = parseJsonc(read.bytes);
    assert.deepEqual(parsed.incomplete, []);
    assert.equal(read.note, null);
  });

  it("treats a missing file at a ref as absent, not an error", () => {
    assert.deepEqual(readBlobAtRef(repo.sha, ".claude/missing.json", repo.dir), { status: "absent" });
    assert.deepEqual(readBlobAtRef(repo.sha, "nested/.mcp.json", repo.dir), { status: "absent" });
  });

  it("reports a path that names a directory as incomplete", () => {
    const read = readBlobAtRef(repo.sha, ".claude", repo.dir);
    assert.equal(read.status, "incomplete");
    if (read.status === "incomplete") {
      assert.match(read.incomplete.reason, /is not a file \(tree object\)/);
    }
  });

  it("reports output larger than the buffer limit as incomplete", () => {
    const { spawner } = stubSpawner({ status: null, error: Object.assign(new Error("ENOBUFS"), { code: "ENOBUFS" }) });
    const read = readBlobAtRef(repo.sha, ".claude/settings.json", repo.dir, spawner);
    assert.equal(read.status, "incomplete");
    if (read.status === "incomplete") {
      assert.match(read.incomplete.reason, /exceeds size limit/);
    }
  });

  it("does not follow a symlink committed at a ref (the link target text is unparseable)", () => {
    const linked = tempDir();
    try {
      fs.mkdirSync(path.join(linked, ".claude"));
      fs.symlinkSync("../../outside.json", path.join(linked, ".claude", "settings.json"));
      git(linked, "init", "-q", "-b", "main");
      git(linked, "add", "-A");
      git(linked, "commit", "-q", "-m", "symlink");
      const sha = git(linked, "rev-parse", "HEAD");
      const read = readBlobAtRef(sha, ".claude/settings.json", linked);
      assert.equal(read.status, "present");
      if (read.status === "present") {
        assert.equal(Buffer.from(read.bytes).toString("utf8"), "../../outside.json");
        assert.ok(parseJsonc(read.bytes).incomplete.length > 0);
      }
    } finally {
      removeDir(linked);
    }
  });
});

describe("git: symlink-aware worktree reads", () => {
  let root: string;
  let outside: string;
  before(() => {
    root = tempDir();
    outside = tempDir();
    fs.mkdirSync(path.join(root, ".claude"));
    fs.mkdirSync(path.join(root, "shared"));
    fs.writeFileSync(path.join(root, "shared", "settings.json"), '{"defaultMode": "plan"}');
    fs.writeFileSync(path.join(outside, "settings.json"), '{"defaultMode": "bypassPermissions"}');
    fs.mkdirSync(path.join(outside, "claude-dir"));
    fs.writeFileSync(path.join(outside, "claude-dir", "settings.json"), "{}");
  });
  after(() => {
    removeDir(root);
    removeDir(outside);
  });

  it("reads a regular file and reports a missing one as absent", () => {
    fs.writeFileSync(path.join(root, ".mcp.json"), "{}");
    const read = readWorktreeFile(root, ".mcp.json");
    assert.equal(read.status, "present");
    assert.deepEqual(readWorktreeFile(root, ".claude/settings.local.json"), { status: "absent" });
    assert.deepEqual(readWorktreeFile(root, "not-a-dir/.mcp.json"), { status: "absent" });
  });

  it("follows a symlink that stays inside the root and notes it", () => {
    const link = path.join(root, ".claude", "settings.json");
    fs.symlinkSync(path.join("..", "shared", "settings.json"), link);
    try {
      const read = readWorktreeFile(root, ".claude/settings.json");
      assert.equal(read.status, "present");
      if (read.status === "present") {
        assert.equal(read.note, "symlink: .claude/settings.json -> shared/settings.json");
        assert.equal(Buffer.from(read.bytes).toString("utf8"), '{"defaultMode": "plan"}');
      }
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("refuses a symlink that resolves outside the root", () => {
    const link = path.join(root, ".claude", "settings.json");
    fs.symlinkSync(path.join(outside, "settings.json"), link);
    try {
      const read = readWorktreeFile(root, ".claude/settings.json");
      assert.equal(read.status, "incomplete");
      if (read.status === "incomplete") {
        assert.equal(read.incomplete.path, ".claude/settings.json");
        assert.match(read.incomplete.reason, /symlink resolves outside the repository root/);
        assert.ok(!read.incomplete.reason.includes(outside), "must not leak the absolute target");
      }
    } finally {
      fs.unlinkSync(link);
    }
  });

  it("refuses a symlinked parent directory that leaves the root", () => {
    const linkedRoot = tempDir();
    try {
      fs.symlinkSync(path.join(outside, "claude-dir"), path.join(linkedRoot, ".claude"));
      const read = readWorktreeFile(linkedRoot, ".claude/settings.json");
      assert.equal(read.status, "incomplete");
      if (read.status === "incomplete") {
        assert.match(read.incomplete.reason, /outside the repository root/);
      }
    } finally {
      removeDir(linkedRoot);
    }
  });

  it("reports a dangling symlink and a directory in place of a file", () => {
    const link = path.join(root, ".claude", "settings.json");
    fs.symlinkSync("does-not-exist.json", link);
    try {
      const read = readWorktreeFile(root, ".claude/settings.json");
      assert.equal(read.status, "incomplete");
      if (read.status === "incomplete") {
        assert.match(read.incomplete.reason, /dangling symlink/);
      }
    } finally {
      fs.unlinkSync(link);
    }
    fs.mkdirSync(link);
    try {
      const read = readWorktreeFile(root, ".claude/settings.json");
      assert.equal(read.status, "incomplete");
      if (read.status === "incomplete") {
        assert.match(read.incomplete.reason, /not a regular file/);
      }
    } finally {
      fs.rmdirSync(link);
    }
  });

  it("reports permission errors as incomplete", () => {
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{}");
    const denying: FsAdapter = {
      ...defaultFs,
      readFileSync: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };
    try {
      const read = readWorktreeFile(root, ".claude/settings.json", denying);
      assert.equal(read.status, "incomplete");
      if (read.status === "incomplete") {
        assert.match(read.incomplete.reason, /permission denied \(EACCES\)/);
      }
    } finally {
      fs.unlinkSync(path.join(root, ".claude", "settings.json"));
    }
  });

  it("enforces the size limit without reading the file", () => {
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), `{"a": "${"x".repeat(64)}"}`);
    const { fs: recorder, paths } = recordingFs();
    try {
      const read = readWorktreeFile(root, ".claude/settings.json", recorder, 32);
      assert.equal(read.status, "incomplete");
      if (read.status === "incomplete") {
        assert.match(read.incomplete.reason, /exceeds size limit/);
      }
      assert.ok(paths.length > 0);
    } finally {
      fs.unlinkSync(path.join(root, ".claude", "settings.json"));
    }
  });
});

describe("git: tracking detection in a worktree", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("reports tracked and untracked paths without reading them", () => {
    assert.deepEqual(isTrackedInWorktree(repo.dir, ".claude/settings.local.json"), { tracked: true, note: null });
    fs.writeFileSync(path.join(repo.dir, ".claude", "extra.json"), "{}");
    assert.deepEqual(isTrackedInWorktree(repo.dir, ".claude/extra.json"), { tracked: false, note: null });
  });

  it("reports null when the directory is not a repository", () => {
    const plain = tempDir();
    try {
      const result = isTrackedInWorktree(plain, ".claude/settings.local.json");
      assert.equal(result.tracked, null);
      assert.match(result.note ?? "", /not a git repository/);
    } finally {
      removeDir(plain);
    }
  });
});

describe("git: side resolution (ref | path | snapshot.json)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("resolves a ref to a git side with the SHA", () => {
    const side = resolveSide("main", { cwd: repo.dir });
    assert.deepEqual(side, { ok: true, side: { kind: "git", spec: "main", sha: repo.sha, cwd: repo.dir } });
  });

  it("resolves a directory to a worktree side", () => {
    const side = resolveSide(".", { cwd: repo.dir });
    assert.deepEqual(side, { ok: true, side: { kind: "worktree", spec: ".", root: repo.dir } });
  });

  it("round-trips a saved snapshot.json as a side", () => {
    const original = takeSnapshot({ kind: "git", spec: "main", sha: repo.sha, cwd: repo.dir }).snapshot;
    const file = path.join(repo.dir, "snapshot.json");
    fs.writeFileSync(file, canonicalJson(original));
    const side = resolveSide("snapshot.json", { cwd: repo.dir });
    assert.ok(side.ok);
    assert.equal(side.side.kind, "snapshot");
    if (side.side.kind === "snapshot") {
      assert.equal(canonicalJson(side.side.snapshot), canonicalJson(original), "loaded verbatim");
      const reloaded = takeSnapshot(side.side);
      assert.deepEqual(reloaded.snapshot.origin, { kind: "snapshot", spec: "snapshot.json", sha: repo.sha });
      assert.equal(
        canonicalJson({ ...reloaded.snapshot, origin: null }),
        canonicalJson({ ...original, origin: null }),
        "everything but origin is carried through",
      );
      assert.deepEqual(reloaded.snapshot.sources.map((source) => source.sha), [repo.sha, repo.sha, repo.sha]);
      assert.deepEqual(original.origin, { kind: "git", spec: "main", sha: repo.sha }, "the loaded snapshot is not mutated");
    }
  });

  it("rejects a file that is not a snapshot", () => {
    const file = path.join(repo.dir, "not-a-snapshot.json");
    fs.writeFileSync(file, '{"hello": "world"}');
    const side = resolveSide("not-a-snapshot.json", { cwd: repo.dir });
    assert.ok(!side.ok);
    assert.match(side.incomplete.reason, /not a snapshot file: schema_version must be 1/);
    fs.writeFileSync(file, "{ broken");
    const broken = resolveSide("not-a-snapshot.json", { cwd: repo.dir });
    assert.ok(!broken.ok);
    assert.match(broken.incomplete.reason, /snapshot file is not valid JSON/);
  });

  it("validates the top-level snapshot shape field by field", () => {
    assert.deepEqual(validateSnapshotShape(null), ["top level is not an object"]);
    assert.deepEqual(validateSnapshotShape({ schema_version: 1, semantics_doc_date: "d", origin: { kind: "git" }, assumptions: [], sources: [], entries: [], incomplete: [] }), []);
    assert.deepEqual(validateSnapshotShape({ schema_version: 1, semantics_doc_date: "d", origin: { kind: "git" }, assumptions: [], sources: [{}], entries: [], incomplete: [{ path: "x" }] }), [
      "sources must be an array of {path, ...}",
      "incomplete must be an array of {path, reason}",
    ]);
  });

  it("reports an unknown spec as a missing ref", () => {
    const side = resolveSide("definitely-not-here", { cwd: repo.dir });
    assert.ok(!side.ok);
    assert.match(side.incomplete.reason, /^missing ref/);
  });
});
