import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { allDeltas, diffSnapshots } from "../src/diff.js";
import { DIRECTION_RULES, classifyDirection, findDirectionRule } from "../src/direction.js";
import { takeSnapshot } from "../src/snapshot.js";
import type { ChangeKind, Diff, Direction, Tier } from "../src/types.js";
import { DiffCases, deltaFor, deltasOf, listOf } from "./diff-helpers.js";
import { makeRepo, removeDir } from "./helpers.js";

const cases = new DiffCases();
after(() => cases.cleanup());

interface Row {
  name: string;
  key: string | RegExp;
  change: ChangeKind;
  direction: Direction;
  rule: string;
  tier?: Tier;
}

/** One fixture per direction row of JG-153, both mode directions included. */
const DIRECTION_ROWS: Row[] = [
  { name: "allow-added", key: "perm:allow:Bash(npm run build)", change: "added", direction: "widens", rule: "D-allow-added" },
  { name: "ask-added", key: "perm:ask:Bash(git push)", change: "added", direction: "neutral", rule: "D-ask-added" },
  { name: "deny-added", key: "perm:deny:Bash(rm -rf /)", change: "added", direction: "narrows", rule: "D-deny-added" },
  { name: "deny-removed", key: "perm:deny:Bash(curl *)", change: "removed", direction: "widens", rule: "D-deny-removed" },
  { name: "allow-removed", key: "perm:allow:Bash(npm test)", change: "removed", direction: "narrows", rule: "D-allow-removed" },
  { name: "hook-added", key: /^hook:PreToolUse:Bash:[0-9a-f]{64}$/, change: "added", direction: "widens", rule: "D-hook-added" },
  { name: "hook-command-changed", key: /^hook:PreToolUse:Bash:[0-9a-f]{64}$/, change: "changed", direction: "widens", rule: "D-hook-changed" },
  { name: "mcp-added", key: "mcp:docs", change: "added", direction: "widens", rule: "D-mcp-added" },
  { name: "mcp-url-changed", key: "mcp:build", change: "changed", direction: "widens", rule: "D-mcp-changed" },
  { name: "enable-all-mcp-on", key: "plugin_flag:enableAllProjectMcpServers", change: "changed", direction: "widens", rule: "D-enable-all-mcp" },
  { name: "mode-widened", key: "mode:defaultMode", change: "changed", direction: "widens", rule: "D-mode-widened" },
  { name: "mode-widened-dontask", key: "mode:defaultMode", change: "changed", direction: "widens", rule: "D-mode-widened" },
  { name: "mode-widened-auto", key: "mode:defaultMode", change: "added", direction: "widens", rule: "D-mode-widened" },
  { name: "mode-narrowed", key: "mode:defaultMode", change: "changed", direction: "narrows", rule: "D-mode-narrowed" },
  { name: "disable-all-hooks-on", key: "plugin_flag:disableAllHooks", change: "changed", direction: "narrows", rule: "D-hooks-disabled" },
  { name: "disable-all-hooks-off", key: "plugin_flag:disableAllHooks", change: "changed", direction: "widens", rule: "D-hooks-reenabled" },
  { name: "dir-added", key: "dir:../shared-lib", change: "added", direction: "widens", rule: "D-dir-added" },
  { name: "unknown-shape", key: "unknown:/model", change: "changed", direction: "unknown", rule: "D-unknown", tier: "unresolved" },
];

describe("diff: direction table, one fixture per row (JG-153)", () => {
  for (const row of DIRECTION_ROWS) {
    it(`${row.name}: ${String(row.key)} ${row.change} → ${row.direction} (${row.rule})`, () => {
      const diff = cases.diff(row.name);
      assert.deepEqual(diff.incomplete, []);
      const delta = deltaFor(diff, row.key);
      assert.equal(delta.change, row.change);
      assert.equal(delta.direction, row.direction);
      assert.equal(delta.rule, row.rule);
      assert.equal(delta.tier, row.tier ?? "proven");
      assert.equal(findDirectionRule(row.rule)?.direction, row.direction);
      if (row.tier === "unresolved") {
        assert.equal(listOf(diff, row.key), "unresolved");
      } else {
        assert.equal(listOf(diff, row.key), row.change === "moved" ? "changed" : row.change);
      }
      if (row.change === "added") {
        assert.equal(delta.base, null);
        assert.notEqual(delta.head, null);
      } else if (row.change === "removed") {
        assert.equal(delta.head, null);
        assert.notEqual(delta.base, null);
      } else {
        assert.notEqual(delta.base, null);
        assert.notEqual(delta.head, null);
      }
      assert.equal(delta.head?.direction ?? delta.base?.direction, delta.direction, "entry copies carry the delta's classification");
      assert.equal(delta.head?.tier ?? delta.base?.tier, delta.tier);
    });
  }

  it("every delta is an Entry pair with direction and tier, and the Diff has the §3.5 shape", () => {
    const diff = cases.diff("hook-added");
    assert.deepEqual(Object.keys(diff).sort(), ["added", "base", "changed", "head", "incomplete", "removed", "schema_version", "semantics_doc_date", "summary", "unresolved"]);
    assert.deepEqual(Object.keys(diff.base).sort(), ["assumptions", "incomplete", "origin", "sha", "sources"]);
    assert.equal(diff.base.sha, cases.repo("hook-added").baseSha);
    assert.equal(diff.head.sha, cases.repo("hook-added").headSha);
    assert.deepEqual(Object.keys(diff.summary).sort(), ["categories", "exit_code", "expands", "fail_on", "reasons", "strict", "verdict"]);
    for (const delta of deltasOf(diff)) {
      assert.deepEqual(Object.keys(delta).sort(), [
        "base",
        "breadth",
        "breadth_tier",
        "category",
        "change",
        "direction",
        "flags",
        "head",
        "interpretations",
        "key",
        "kind",
        "notes",
        "rule",
        "tier",
      ]);
      assert.ok(["widens", "narrows", "neutral", "unknown"].includes(delta.direction));
      assert.ok(["proven", "projected", "unresolved"].includes(delta.tier));
    }
  });

  it("a hook command change is one changed delta pairing the removed and added keys, not removed + added", () => {
    const diff = cases.diff("hook-command-changed");
    assert.equal(deltasOf(diff).length, 1);
    const delta = deltaFor(diff, /^hook:/);
    assert.equal(delta.change, "changed");
    assert.notEqual(delta.base?.key, delta.head?.key);
    assert.equal(delta.key, delta.head?.key);
    assert.ok(delta.notes.some((note) => note.startsWith("hook command changed; previous key hook:PreToolUse:Bash:")));
    assert.equal(delta.category, "hook");
  });

  it("enableAllProjectMcpServers true → false and disableAllHooks removed while true use the off rules", () => {
    const off = deltaFor(cases.diff("enable-all-mcp-off"), "plugin_flag:enableAllProjectMcpServers");
    assert.equal(off.direction, "narrows");
    assert.equal(off.rule, "D-enable-all-mcp-off");
    const removedTrue = classifyDirection("removed", "plugin_flag", "plugin_flag:disableAllHooks", { ...off.base!, key: "plugin_flag:disableAllHooks", value: true }, null);
    assert.equal(removedTrue.rule, "D-hooks-reenabled");
    assert.equal(removedTrue.direction, "widens");
    const addedFalse = classifyDirection("added", "plugin_flag", "plugin_flag:disableAllHooks", null, { ...off.base!, key: "plugin_flag:disableAllHooks", value: false });
    assert.equal(addedFalse.rule, "D-flag-default");
    assert.equal(addedFalse.direction, "neutral");
  });

  it("mode changes within one class are neutral; an unknown value is unknown/unresolved", () => {
    const neutral = deltaFor(cases.diff("mode-neutral"), "mode:defaultMode");
    assert.equal(neutral.direction, "neutral");
    assert.equal(neutral.rule, "D-mode-neutral");
    assert.equal(neutral.tier, "proven");
    const unknown = deltaFor(cases.diff("mode-unknown"), "mode:defaultMode");
    assert.equal(unknown.direction, "unknown");
    assert.equal(unknown.tier, "unresolved");
    assert.equal(unknown.rule, "D-mode-unknown");
  });

  it("every direction rule has an id, a title, a direction, a tier and an explanation", () => {
    const ids = DIRECTION_RULES.map((rule) => rule.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const rule of DIRECTION_RULES) {
      assert.match(rule.id, /^D-[a-z-]+$/);
      assert.ok(rule.title.length > 0 && rule.explain.length > 20, rule.id);
    }
    for (const row of DIRECTION_ROWS) {
      assert.ok(ids.includes(row.rule), row.rule);
    }
    assert.equal(findDirectionRule("D-nope"), null);
  });
});

describe("diff: changed vs reformat, moved files, ordering, determinism (JG-153)", () => {
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

  it("reformat-only (fixtures/repos/reformat-a vs reformat-b) → empty diff, exit 0", () => {
    const left = takeSnapshot({ kind: "git", spec: "HEAD", sha: a.sha, cwd: a.dir }).snapshot;
    const right = takeSnapshot({ kind: "git", spec: "HEAD", sha: b.sha, cwd: b.dir }).snapshot;
    assert.equal(left.entries.length, 5);
    const diff = diffSnapshots(left, right);
    assert.deepEqual([diff.added, diff.removed, diff.changed, diff.unresolved, diff.incomplete], [[], [], [], [], []]);
    assert.equal(diff.summary.exit_code, 0);
    assert.equal(diff.summary.verdict, "no-change");
    assert.equal(diff.summary.expands, false);
    const fixtureDiff = cases.diff("reformat-only");
    assert.deepEqual(allDeltas(fixtureDiff), []);
    assert.equal(fixtureDiff.summary.exit_code, 0);
  });

  it("changed[] distinguishes a value change from a reformat: same key, timeout added → changed neutral", () => {
    const diff = cases.diff("hook-attrs-changed");
    assert.equal(deltasOf(diff).length, 1);
    const delta = deltaFor(diff, /^hook:/);
    assert.equal(listOf(diff, /^hook:/), "changed");
    assert.equal(delta.change, "changed");
    assert.equal(delta.rule, "D-hook-attrs-changed");
    assert.equal(delta.direction, "neutral");
    assert.ok(delta.notes.includes("changed fields: timeout"), delta.notes.join("\n"));
  });

  it("an identical entry on both sides never appears, whatever its line or raw text", () => {
    const diff = cases.diff("allow-added");
    assert.equal(listOf(diff, "perm:allow:Bash(npm test)"), null);
    assert.equal(listOf(diff, "perm:deny:Bash(curl *)"), null);
    assert.equal(deltasOf(diff).length, 1);
  });

  it("negative case: identical key/value moved from settings.json to tracked settings.local.json → changed (moved), neutral", () => {
    const diff = cases.diff("moved-file");
    assert.deepEqual(diff.incomplete, []);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.unresolved, []);
    assert.equal(diff.changed.length, 1);
    const delta = deltaFor(diff, "perm:allow:Bash(ls *)");
    assert.equal(delta.change, "moved");
    assert.equal(delta.direction, "neutral");
    assert.equal(delta.tier, "proven");
    assert.equal(delta.rule, "D-moved");
    assert.equal(delta.base?.file, ".claude/settings.json");
    assert.equal(delta.head?.file, ".claude/settings.local.json");
    assert.ok(delta.flags.includes("tracked_local"));
    assert.ok(delta.notes.some((note) => note.startsWith("identical value; location changed from .claude/settings.json:")), delta.notes.join("\n"));
    assert.equal(diff.summary.exit_code, 0);
    assert.equal(diff.summary.verdict, "pass");
  });

  it("an allow added in a tracked settings.local.json is flagged tracked_local and still counts", () => {
    const diff = cases.diff("local-allow-added");
    const delta = deltaFor(diff, "perm:allow:Bash");
    assert.equal(delta.change, "added");
    assert.ok(delta.flags.includes("tracked_local"));
    assert.equal(delta.category, "whole-tool-allow");
    assert.equal(diff.summary.exit_code, 1);
  });

  it("output lists are sorted by key and the JSON is byte-deterministic across independent runs", () => {
    const first = cases.diff("i8-ignored-shapes");
    const keys = (diff: Diff): string[] => [...diff.added, ...diff.unresolved].map((delta) => delta.key);
    for (const list of ["added", "removed", "changed", "unresolved"] as const) {
      const listKeys = first[list].map((delta) => delta.key);
      assert.deepEqual(listKeys, [...listKeys].sort(), list);
    }
    assert.ok(keys(first).length > 5);
    const again = cases.diff("i8-ignored-shapes");
    assert.equal(canonicalJson(first), canonicalJson(again));
    const { base, head } = cases.snapshots("i8-ignored-shapes");
    assert.equal(canonicalJson(diffSnapshots(base, head)), canonicalJson(diffSnapshots(base, head)));
    assert.equal(canonicalJson(base), canonicalJson(cases.snapshots("i8-ignored-shapes").base), "diffSnapshots never mutates a snapshot");
  });

  it("no-change: identical sides → no deltas, exit 0, verdict no-change", () => {
    const diff = cases.diff("no-change");
    assert.deepEqual(allDeltas(diff), []);
    assert.equal(diff.summary.verdict, "no-change");
    assert.equal(diff.summary.exit_code, 0);
  });
});
