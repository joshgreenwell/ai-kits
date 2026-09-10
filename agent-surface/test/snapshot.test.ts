import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { EXIT_INCOMPLETE, EXIT_OK } from "../src/cli.js";
import { semanticEntry } from "../src/entries.js";
import { schemaVersionMismatch } from "../src/snapshotfile.js";
import { BASE_ASSUMPTIONS, takeSnapshot } from "../src/snapshot.js";
import { SCHEMA_VERSION, SEMANTICS_DOC_DATE, type Entry, type Snapshot } from "../src/types.js";
import { FIXTURES, makeRepo, removeDir, runCli } from "./helpers.js";
import { validate, type Schema } from "./schema-validator.js";

const SCHEMA_PATH = fileURLToPath(new URL("../../docs/snapshot.schema.json", import.meta.url));

function loadSchema(): Schema {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Schema;
}

function parseSnapshot(text: string): Snapshot {
  return JSON.parse(text) as Snapshot;
}

/** Strip evidence that legitimately differs between two scans of the same semantics. */
function comparable(snapshot: Snapshot): unknown {
  return {
    ...snapshot,
    origin: null,
    sources: snapshot.sources.map((source) => ({ ...source, sha: null, blob: null })),
    entries: snapshot.entries.map((entry) => ({ ...semanticEntry(entry), json_pointer: entry.json_pointer })),
  };
}

describe("snapshot: shape and assumptions (JG-152, JG-143 §3.7)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("rich");
  });
  after(() => removeDir(repo.dir));

  it("carries schema_version 1, semantics_doc_date 2026-09-07, min_claude_version null and the fixed assumptions", () => {
    const { snapshot } = takeSnapshot({ kind: "git", spec: "HEAD", sha: repo.sha, cwd: repo.dir });
    assert.equal(snapshot.schema_version, 1);
    assert.equal(SCHEMA_VERSION, 1);
    assert.equal(snapshot.semantics_doc_date, "2026-09-07");
    assert.equal(SEMANTICS_DOC_DATE, "2026-09-07");
    assert.equal(snapshot.min_claude_version, null);
    assert.deepEqual(snapshot.assumptions.slice(0, BASE_ASSUMPTIONS.length), [...BASE_ASSUMPTIONS]);
    assert.equal(BASE_ASSUMPTIONS.length, 8);
    for (const topic of ["semantics:", "scope:", "trust:", "mode:", "sandbox:", "hooks:", "not read:", "plugins:"]) {
      assert.ok(BASE_ASSUMPTIONS.some((line) => line.startsWith(topic)), topic);
    }
    assert.ok(snapshot.assumptions.some((line) => line.includes("local file shared via Git")), "tracked local flag");
    assert.ok(snapshot.assumptions.some((line) => line.startsWith("plugins: enabledPlugins is non-empty")), "plugin flag");
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "assumptions",
      "entries",
      "incomplete",
      "min_claude_version",
      "origin",
      "schema_version",
      "semantics_doc_date",
      "sources",
    ]);
  });

  it("sorts entries by key then file and leaves incomplete empty for a clean side", () => {
    const { snapshot } = takeSnapshot({ kind: "git", spec: "HEAD", sha: repo.sha, cwd: repo.dir });
    const keys = snapshot.entries.map((entry) => `${entry.key} ${entry.file}`);
    assert.deepEqual(keys, [...keys].sort());
    assert.deepEqual(snapshot.incomplete, []);
    assert.ok(snapshot.entries.length > 30);
  });

  it("validates against docs/snapshot.schema.json (clean, credential and incomplete sides)", () => {
    const schema = loadSchema();
    assert.equal(schema["$schema"], "https://json-schema.org/draft/2020-12/schema");
    const rich = takeSnapshot({ kind: "git", spec: "HEAD", sha: repo.sha, cwd: repo.dir }).snapshot;
    assert.deepEqual(validate(JSON.parse(canonicalJson(rich)), schema), []);
    for (const name of ["credential", "non-string-allow", "reformat-b", "no-config"]) {
      const root = path.join(FIXTURES, "repos", name);
      const snapshot = takeSnapshot({ kind: "worktree", spec: root, root }).snapshot;
      assert.deepEqual(validate(JSON.parse(canonicalJson(snapshot)), schema), [], name);
    }
    const broken = JSON.parse(canonicalJson(rich)) as Record<string, unknown>;
    broken["schema_version"] = 2;
    (broken["entries"] as Array<Record<string, unknown>>)[0]!["tier"] = "certain";
    delete (broken["sources"] as Array<Record<string, unknown>>)[0]!["blob"];
    const errors = validate(broken, schema);
    assert.ok(errors.some((error) => error.includes("/schema_version")), errors.join("\n"));
    assert.ok(errors.some((error) => error.includes("/entries/0/tier")), errors.join("\n"));
    assert.ok(errors.some((error) => error.includes("missing required property blob")), errors.join("\n"));
  });

  it("is byte-deterministic across two runs (in-process and CLI)", () => {
    const first = canonicalJson(takeSnapshot({ kind: "git", spec: "HEAD", sha: repo.sha, cwd: repo.dir }).snapshot);
    const second = canonicalJson(takeSnapshot({ kind: "git", spec: "HEAD", sha: repo.sha, cwd: repo.dir }).snapshot);
    assert.equal(first, second);
    const cliFirst = runCli(["snapshot", "HEAD", "--json"], repo.dir);
    const cliSecond = runCli(["snapshot", "HEAD", "--json"], repo.dir);
    assert.equal(cliFirst.status, EXIT_OK, cliFirst.stderr);
    assert.equal(cliFirst.stdout, cliSecond.stdout);
    assert.equal(cliFirst.stdout, first);
  });
});

describe("snapshot: reformat-only pair yields identical entries (JG-151)", () => {
  let a: { dir: string; sha: string };
  let b: { dir: string; sha: string };
  before(() => {
    a = makeRepo("reformat-a");
    b = makeRepo("reformat-b");
  });
  after(() => {
    removeDir(a.dir);
    removeDir(b.dir);
  });

  it("produces byte-identical semantic entries and snapshots (minus sources sha/blob, line, source_sha, raw)", () => {
    const left = takeSnapshot({ kind: "git", spec: "HEAD", sha: a.sha, cwd: a.dir }).snapshot;
    const right = takeSnapshot({ kind: "git", spec: "HEAD", sha: b.sha, cwd: b.dir }).snapshot;
    assert.notEqual(a.sha, b.sha);
    assert.deepEqual(left.incomplete, []);
    assert.deepEqual(right.incomplete, []);
    assert.equal(left.entries.length, 5);
    assert.deepEqual(
      left.entries.map((entry) => entry.key),
      right.entries.map((entry) => entry.key),
    );
    assert.equal(canonicalJson(left.entries.map(semanticEntry)), canonicalJson(right.entries.map(semanticEntry)));
    assert.equal(canonicalJson(comparable(left)), canonicalJson(comparable(right)));
    const rawLeft = left.entries.map((entry) => (entry.value as { raw?: string }).raw);
    const rawRight = right.entries.map((entry) => (entry.value as { raw?: string }).raw);
    assert.notDeepEqual(rawLeft, rawRight, "raw text is retained per side");
    assert.ok(rawRight.includes("Bash( npm run * )"));
    assert.ok(rawLeft.includes("Bash(npm run:*)"));
  });
});

describe("snapshot: CLI output (JG-152)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("rich");
  });
  after(() => removeDir(repo.dir));

  it("text mode lists entries as `kind key file:line` after the assumptions and sources", () => {
    const run = runCli(["snapshot", "HEAD"], repo.dir);
    assert.equal(run.status, EXIT_OK, run.stderr);
    assert.match(run.stdout, /\nentries \(\d+\):\n/);
    assert.match(run.stdout, /\n {2}perm {8}perm:allow:Bash\(npm run \*\) {2}\.claude\/settings\.json:8\n/);
    assert.match(run.stdout, /\n {2}hook {8}hook:PreToolUse:Bash:[0-9a-f]{64} {2}\.claude\/settings\.json:17\n/);
    assert.match(run.stdout, /\n {2}mcp {9}mcp:docs {2}\.mcp\.json:7\n/);
    assert.match(run.stdout, /\n {2}unknown {5}unknown:\/model {2}\.claude\/settings\.json:33\n/);
    assert.match(run.stdout, /\n {2}perm {8}perm:allow:Bash\(npm test\) {2}\.claude\/settings\.json:8\n {2}perm {8}perm:allow:Bash\(npm test\) {2}\.claude\/settings\.local\.json:7\n/);
    assert.ok(run.stdout.indexOf("assumptions:") < run.stdout.indexOf("sources:"));
    assert.ok(run.stdout.indexOf("sources:") < run.stdout.indexOf("entries ("));
    assert.match(run.stdout, /incomplete: none\n$/);
  });

  it("JSON mode never prints env values and surfaces the unknown key", () => {
    const run = runCli(["snapshot", "HEAD", "--json"], repo.dir);
    assert.equal(run.status, EXIT_OK, run.stderr);
    assert.ok(!run.stdout.includes("https://example.invalid/api"), "env value leaked");
    assert.ok(!run.stdout.includes("synthetic-not-a-real-token"), "mcp env value leaked");
    assert.ok(run.stdout.includes('"env_key:EXAMPLE_ENDPOINT"'));
    assert.ok(run.stdout.includes('"unknown:/model"'));
    const snapshot = parseSnapshot(run.stdout);
    const unknown = snapshot.entries.find((entry) => entry.key === "unknown:/model") as Entry;
    assert.equal(unknown.kind, "unknown");
    assert.equal(unknown.direction, "unknown");
    assert.equal(unknown.tier, "unresolved");
  });

  it("a saved snapshot is accepted by snapshot, diff and check and reproduces its entries", () => {
    const first = runCli(["snapshot", "HEAD", "--json"], repo.dir);
    const saved = path.join(repo.dir, "saved.json");
    fs.writeFileSync(saved, first.stdout);
    const again = runCli(["snapshot", "saved.json", "--json"], repo.dir);
    assert.equal(again.status, EXIT_OK, again.stderr);
    assert.deepEqual(parseSnapshot(again.stdout).entries, parseSnapshot(first.stdout).entries);
    for (const command of ["diff", "check"]) {
      const run = runCli([command, "--base", "HEAD", "--head", "saved.json", "--json"], repo.dir);
      assert.equal(run.status, EXIT_OK, `${command}: a snapshot of HEAD diffed against HEAD is no change (${run.stderr})`);
      const output = JSON.parse(run.stdout) as {
        head: { origin: { kind: string }; sources: unknown[] };
        added: unknown[];
        removed: unknown[];
        changed: unknown[];
        unresolved: unknown[];
        incomplete: unknown[];
        summary: { verdict: string };
      };
      assert.equal(output.head.origin.kind, "snapshot");
      assert.equal(output.head.sources.length, parseSnapshot(first.stdout).sources.length);
      assert.deepEqual([output.added, output.removed, output.changed, output.unresolved, output.incomplete], [[], [], [], [], []]);
      assert.equal(output.summary.verdict, "no-change");
    }
  });
});

describe("snapshot: credential literal never reaches the output (JG-150)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("credential");
  });
  after(() => removeDir(repo.dir));

  it("JSON and text output contain the credential entries but not the literals", () => {
    for (const args of [["snapshot", "HEAD", "--json"], ["snapshot", "HEAD"]]) {
      const run = runCli(args, repo.dir);
      assert.equal(run.status, EXIT_OK, run.stderr);
      const text = run.stdout + run.stderr;
      for (const literal of ["sk-synthetic", "synthetic0000token", "AKIA0000000000SYNTHE", "ghp_SYNTHETIC", "github_pat_", "xoxb-", "BEGIN PRIVATE KEY", "0123456789abcdef0123456789abcdef"]) {
        assert.ok(!text.includes(literal), `${args.join(" ")}: literal leaked: ${literal}`);
      }
      assert.ok(text.includes("credential:/env/EXAMPLE_API_KEY"));
      assert.ok(text.includes("credential:/mcpServers/gh/args/3"));
    }
    const snapshot = parseSnapshot(runCli(["snapshot", "HEAD", "--json"], repo.dir).stdout);
    const credentials = snapshot.entries.filter((entry) => entry.kind === "credential");
    assert.equal(credentials.length, 10);
    assert.ok(credentials.every((entry) => entry.value === "credential-like value present"));
  });
});

describe("snapshot: schema-version mismatch and incomplete propagation (JG-152)", () => {
  let repo: { dir: string; sha: string };
  before(() => {
    repo = makeRepo("non-string-allow");
    fs.copyFileSync(path.join(FIXTURES, "snapshots", "schema-mismatch.json"), path.join(repo.dir, "mismatch.json"));
  });
  after(() => removeDir(repo.dir));

  it("a snapshot file with another schema_version exits 3 with a clear message everywhere a ref is accepted", () => {
    const expected = /snapshot schema_version mismatch: file has schema_version 99, this version of agent-surface reads schema_version 1/;
    const snapshot = runCli(["snapshot", "mismatch.json", "--json"], repo.dir);
    assert.equal(snapshot.status, EXIT_INCOMPLETE);
    assert.match(snapshot.stderr, expected);
    const output = JSON.parse(snapshot.stdout) as { incomplete: Array<{ path: string; reason: string }> };
    assert.equal(output.incomplete[0]?.path, "mismatch.json");
    assert.match(output.incomplete[0]?.reason ?? "", expected);
    for (const command of ["diff", "check"]) {
      const asHead = runCli([command, "--base", "HEAD", "--head", "mismatch.json"], repo.dir);
      assert.equal(asHead.status, EXIT_INCOMPLETE, command);
      assert.match(asHead.stderr, expected);
      const asBase = runCli([command, "--base", "mismatch.json", "--head", "HEAD"], repo.dir);
      assert.equal(asBase.status, EXIT_INCOMPLETE, command);
      assert.match(asBase.stderr, expected);
    }
    assert.equal(schemaVersionMismatch({ schema_version: 1 }), null);
    assert.equal(schemaVersionMismatch({ hello: "world" }), null, "a missing version is a shape problem, not a mismatch");
    assert.match(schemaVersionMismatch({ schema_version: 0 }) ?? "", /schema_version 0/);
  });

  it("negative case: a saved snapshot with non-empty incomplete[] propagates it into diff/check output and exit code", () => {
    const taken = runCli(["snapshot", "HEAD", "--json"], repo.dir);
    assert.equal(taken.status, EXIT_INCOMPLETE, "the fixture itself is incomplete");
    const saved = parseSnapshot(taken.stdout);
    assert.equal(saved.incomplete.length, 1);
    const reason = saved.incomplete[0]?.reason ?? "";
    assert.match(reason, /permissions\.allow element is number/);
    fs.writeFileSync(path.join(repo.dir, "incomplete.json"), taken.stdout);
    for (const command of ["diff", "check"]) {
      for (const side of ["--head", "--base"]) {
        const other = side === "--head" ? "--base" : "--head";
        const run = runCli([command, side, "incomplete.json", other, "HEAD", "--json"], repo.dir);
        assert.equal(run.status, EXIT_INCOMPLETE, `${command} ${side}`);
        const output = JSON.parse(run.stdout) as { incomplete: Array<{ path: string; reason: string; lines: number[] | null }> };
        assert.ok(
          output.incomplete.some((item) => item.path === ".claude/settings.json" && item.reason === reason && item.lines?.[0] === 7),
          `${command} ${side}: saved incomplete missing from ${JSON.stringify(output.incomplete)}`,
        );
        assert.match(run.stderr, /incomplete: \.claude\/settings\.json: permissions\.allow element is number/);
        const text = runCli([command, side, "incomplete.json", other, "HEAD"], repo.dir);
        assert.equal(text.status, EXIT_INCOMPLETE);
        assert.match(text.stdout, /permissions\.allow element is number/);
      }
    }
  });
});
