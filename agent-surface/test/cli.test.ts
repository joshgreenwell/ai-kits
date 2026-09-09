import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import { EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE, SUBCOMMANDS, run } from "../src/cli.js";
import { VERSION } from "../src/version.js";
import { PACKAGE_JSON, git, makeRepo, removeDir, runCli, stubSpawner, tempDir } from "./helpers.js";

const SIGNATURES = [
  "snapshot [path] [--json]",
  "diff --base <ref> --head <ref|path|snapshot.json> [--json]",
  "check --base <ref> --head <ref> [--fail-on <categories>] [--strict] [--json]",
  "explain <ID>",
];

describe("CLI: help and usage (JG-147)", () => {
  it("--help lists the four subcommands with the §3.8 signatures", () => {
    const run = runCli(["--help"], process.cwd());
    assert.equal(run.status, EXIT_OK);
    for (const signature of SIGNATURES) {
      assert.ok(run.stdout.includes(signature), `missing signature: ${signature}`);
    }
    assert.deepEqual(
      SUBCOMMANDS.map((cmd) => cmd.signature),
      SIGNATURES,
    );
    assert.match(run.stdout, /3 {2}scan incomplete/);
  });

  it("-h and 'snapshot --help' also print usage", () => {
    assert.equal(runCli(["-h"], process.cwd()).status, EXIT_OK);
    assert.equal(runCli(["snapshot", "--help"], process.cwd()).status, EXIT_OK);
  });

  it("no arguments, an unknown subcommand, or an unknown option is a usage error (64)", () => {
    assert.equal(runCli([], process.cwd()).status, EXIT_USAGE);
    assert.equal(runCli(["frobnicate"], process.cwd()).status, EXIT_USAGE);
    assert.equal(runCli(["snapshot", "--bogus"], process.cwd()).status, EXIT_USAGE);
    assert.equal(runCli(["diff", "--base", "main"], process.cwd()).status, EXIT_USAGE);
    assert.equal(runCli(["check", "--head", "main"], process.cwd()).status, EXIT_USAGE);
    assert.equal(runCli(["explain"], process.cwd()).status, EXIT_USAGE);
  });

  it("--version matches package.json", () => {
    const run = runCli(["--version"], process.cwd());
    assert.equal(run.status, EXIT_OK);
    assert.equal(run.stdout.trim(), VERSION);
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")) as { version: string; bin: Record<string, string> };
    assert.equal(pkg.version, VERSION);
    assert.equal(pkg.bin["agent-surface"], "./dist/src/cli.js");
  });

  it("explain reports unknown IDs with the list of valid ones", () => {
    const run = runCli(["explain", "INT-1"], process.cwd());
    assert.equal(run.status, EXIT_USAGE);
    assert.match(run.stderr, /unknown ID 'INT-1'\nvalid IDs: I1, I2/);
  });
});

describe("CLI: snapshot", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("snapshot . --json prints a worktree snapshot with sorted keys and exits 0", () => {
    const run = runCli(["snapshot", ".", "--json"], repo.dir);
    assert.equal(run.status, EXIT_OK, run.stderr);
    assert.equal(run.stderr, "");
    const snapshot = JSON.parse(run.stdout) as Record<string, unknown> & {
      origin: { kind: string; spec: string; sha: null };
      sources: Array<{ path: string; sha: string; status: string; parsed: boolean }>;
      entries: unknown[];
      incomplete: unknown[];
    };
    assert.deepEqual(Object.keys(snapshot), [...Object.keys(snapshot)].sort());
    assert.deepEqual(snapshot.origin, { kind: "worktree", spec: ".", sha: null });
    assert.deepEqual(
      snapshot.sources.map((source) => [source.path, source.sha, source.status, source.parsed]),
      [
        [".claude/settings.json", "worktree", "read", true],
        [".claude/settings.local.json", "worktree", "read", true],
        [".mcp.json", "worktree", "read", true],
      ],
    );
    const entries = snapshot.entries as Array<{ key: string; file: string; source_sha: null }>;
    assert.deepEqual(
      entries.filter((entry) => !entry.key.startsWith("hook:")).map((entry) => [entry.key, entry.file]),
      [
        ["mcp:example-docs", ".mcp.json"],
        ["mode:defaultMode", ".claude/settings.json"],
        ["perm:allow:Bash(ls *)", ".claude/settings.local.json"],
        ["perm:allow:Bash(npm test)", ".claude/settings.json"],
        ["perm:allow:Read", ".claude/settings.json"],
        ["perm:deny:Bash(curl *)", ".claude/settings.json"],
      ],
    );
    assert.equal(entries.filter((entry) => /^hook:PreToolUse:Bash:[0-9a-f]{64}$/.test(entry.key)).length, 1);
    assert.ok(entries.every((entry) => entry.source_sha === null), "worktree reads have no source sha");
    assert.deepEqual(snapshot.incomplete, []);
    assert.equal(runCli(["snapshot", ".", "--json"], repo.dir).stdout, run.stdout, "byte-identical on rerun");
  });

  it("snapshot <ref> --json records the resolved SHA in origin and sources", () => {
    const run = runCli(["snapshot", "HEAD", "--json"], repo.dir);
    assert.equal(run.status, EXIT_OK, run.stderr);
    const snapshot = JSON.parse(run.stdout) as { origin: { kind: string; sha: string }; sources: Array<{ sha: string; blob: string }> };
    assert.deepEqual(snapshot.origin, { kind: "git", spec: "HEAD", sha: repo.sha });
    assert.ok(snapshot.sources.every((source) => source.sha === repo.sha));
    assert.ok(snapshot.sources.every((source) => /^[0-9a-f]{40,64}$/.test(source.blob)));
  });

  it("snapshot without --json prints the assumptions header and sources", () => {
    const run = runCli(["snapshot"], repo.dir);
    assert.equal(run.status, EXIT_OK, run.stderr);
    assert.match(run.stdout, /^agent-surface snapshot: worktree \./);
    assert.match(run.stdout, /assumptions:\n {2}- semantics:/);
    assert.match(run.stdout, /\.claude\/settings\.local\.json +read; local file shared via Git \(trust-held by Claude Code\)/);
    assert.match(run.stdout, /incomplete: none/);
  });

  it("snapshot of a saved snapshot.json reproduces it, with origin marked as snapshot", () => {
    const first = runCli(["snapshot", "HEAD", "--json"], repo.dir);
    fs.writeFileSync(path.join(repo.dir, "saved.json"), first.stdout);
    const second = runCli(["snapshot", "saved.json", "--json"], repo.dir);
    assert.equal(second.status, EXIT_OK, second.stderr);
    const { origin: firstOrigin, ...firstRest } = JSON.parse(first.stdout) as { origin: unknown };
    const { origin: secondOrigin, ...secondRest } = JSON.parse(second.stdout) as { origin: unknown };
    assert.deepEqual(firstOrigin, { kind: "git", spec: "HEAD", sha: repo.sha });
    assert.deepEqual(secondOrigin, { kind: "snapshot", spec: "saved.json", sha: repo.sha });
    assert.deepEqual(secondRest, firstRest);
  });
});

describe("CLI: malformed input exits 3 with the reason printed", () => {
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

  it("a malformed settings file", () => {
    const run = runCli(["snapshot", "HEAD"], malformed.dir);
    assert.equal(run.status, EXIT_INCOMPLETE);
    assert.match(run.stderr, /^incomplete: \.claude\/settings\.json: expected ',' or '\]' after array element.*\(line 8\)\n$/);
    assert.match(run.stdout, /incomplete:\n {2}- \.claude\/settings\.json:/);
  });

  it("a duplicate key, with both lines, in JSON mode", () => {
    const run = runCli(["snapshot", ".", "--json"], duplicate.dir);
    assert.equal(run.status, EXIT_INCOMPLETE);
    assert.match(run.stderr, /duplicate key "permissions" at \/permissions \(lines 6, 7\)/);
    const snapshot = JSON.parse(run.stdout) as { incomplete: Array<{ path: string; lines: number[] }> };
    assert.deepEqual(snapshot.incomplete, [
      { lines: [6, 7], path: ".claude/settings.json", reason: 'duplicate key "permissions" at /permissions' },
    ]);
  });

  it("a snapshot file with the wrong shape, and one with another schema version", () => {
    fs.writeFileSync(path.join(malformed.dir, "bad.json"), '{"schema_version": 1, "hello": "world"}');
    const run = runCli(["snapshot", "bad.json", "--json"], malformed.dir);
    assert.equal(run.status, EXIT_INCOMPLETE);
    assert.match(run.stderr, /not a snapshot file/);
    const output = JSON.parse(run.stdout) as { incomplete: Array<{ path: string }> };
    assert.deepEqual(output.incomplete.map((item) => item.path), ["bad.json"]);
    fs.writeFileSync(path.join(malformed.dir, "old.json"), '{"schema_version": 99}');
    const mismatch = runCli(["snapshot", "old.json", "--json"], malformed.dir);
    assert.equal(mismatch.status, EXIT_INCOMPLETE);
    assert.match(mismatch.stderr, /snapshot schema_version mismatch: file has schema_version 99, this version of agent-surface reads schema_version 1/);
  });
});

describe("CLI: diff and check resolve refs and report missing ones (JG-148)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("basic");
  });
  after(() => removeDir(repo.dir));

  it("a missing ref exits 3 with incomplete: missing ref", () => {
    for (const command of ["diff", "check"]) {
      const run = runCli([command, "--base", "no-such-ref", "--head", "HEAD", "--json"], repo.dir);
      assert.equal(run.status, EXIT_INCOMPLETE, command);
      assert.match(run.stderr, /^incomplete: no-such-ref: missing ref: 'no-such-ref' does not resolve to a commit/);
      const output = JSON.parse(run.stdout) as { incomplete: Array<{ path: string; reason: string }> };
      assert.equal(output.incomplete.length, 1);
      assert.equal(output.incomplete[0]?.path, "no-such-ref");
    }
  });

  it("a ref with shell metacharacters fails cleanly with no side effects (negative case)", () => {
    const run = runCli(["check", "--base", "main; touch pwned-marker", "--head", "$(touch pwned-marker)"], repo.dir);
    assert.equal(run.status, EXIT_INCOMPLETE);
    assert.match(run.stderr, /incomplete: main; touch pwned-marker: missing ref/);
    assert.match(run.stderr, /incomplete: \$\(touch pwned-marker\): missing ref/);
    assert.ok(!fs.existsSync(path.join(repo.dir, "pwned-marker")));
  });

  it("valid refs, a directory and a snapshot.json all resolve and diff against main as no change", () => {
    git(repo.dir, "branch", "feature");
    fs.writeFileSync(path.join(repo.dir, "snap.json"), runCli(["snapshot", "HEAD", "--json"], repo.dir).stdout);
    for (const head of ["feature", ".", "snap.json", repo.sha]) {
      const run = runCli(["diff", "--base", "main", "--head", head, "--json"], repo.dir);
      assert.equal(run.status, EXIT_OK, `head ${head}: ${run.stderr}`);
      assert.equal(run.stderr, "");
      const output = JSON.parse(run.stdout) as {
        base: { origin: { kind: string; sha: string }; sha: string };
        head: { origin: { kind: string }; sha: string | null };
        added: unknown[];
        removed: unknown[];
        changed: unknown[];
        unresolved: unknown[];
        summary: { verdict: string; exit_code: number };
        incomplete: unknown[];
      };
      assert.deepEqual(output.base.origin, { kind: "git", spec: "main", sha: repo.sha });
      assert.equal(output.base.sha, repo.sha);
      assert.equal(output.head.origin.kind, head === "." ? "worktree" : head === "snap.json" ? "snapshot" : "git");
      assert.equal(output.head.sha, head === "." ? null : repo.sha);
      assert.deepEqual([output.added, output.removed, output.changed, output.unresolved, output.incomplete], [[], [], [], [], []]);
      assert.deepEqual(output.summary.verdict, "no-change");
      assert.equal(output.summary.exit_code, 0);
    }
  });

  it("check accepts --fail-on and --strict and prints the diff header with the verdict", () => {
    const run = runCli(["check", "--base", "main", "--head", "HEAD", "--fail-on", "projected,scoped-allow", "--strict"], repo.dir);
    assert.equal(run.status, EXIT_OK, run.stderr);
    assert.match(run.stdout, new RegExp(`^CONTROL-SURFACE DIFF {2}base=${repo.sha} head=${repo.sha}\nno changes\nverdict: no-change \\(exit 0\\)`));
  });
});

describe("CLI: run() in-process with injected dependencies", () => {
  it("never calls process.exit and routes output through the io sinks", () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
    const { spawner, calls } = stubSpawner({ status: 128, stderr: "fatal: not a git repository" });
    const dir = tempDir();
    try {
      const code = run(["snapshot", "nope", "--json"], io, { cwd: dir, spawner });
      assert.equal(code, EXIT_INCOMPLETE);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.args, ["rev-parse", "--verify", "--quiet", "--end-of-options", "nope^{commit}"]);
      assert.match(err.join(""), /missing ref: 'nope' does not resolve to a commit \(git: fatal: not a git repository\)/);
      assert.deepEqual(JSON.parse(out.join("")), {
        incomplete: [
          {
            lines: null,
            path: "nope",
            reason: "missing ref: 'nope' does not resolve to a commit (git: fatal: not a git repository)",
          },
        ],
        schema_version: 1,
      });
    } finally {
      removeDir(dir);
    }
  });
});
