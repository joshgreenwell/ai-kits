import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { CATEGORIES, DEFAULT_FAILING_CATEGORIES } from "../src/categories.js";
import { computeVerdict, FAIL_ON_NAMES, isUndecided, parseFailOnList, resolveFailOn, type VerdictOptions } from "../src/verdict.js";
import { DiffCases, deltaFor } from "./diff-helpers.js";

const cases = new DiffCases();
after(() => cases.cleanup());

const DEFAULT: VerdictOptions = { failOn: [], strict: false };
const STRICT: VerdictOptions = { failOn: [], strict: true };
const PROJECTED: VerdictOptions = { failOn: ["projected"], strict: false };

describe("verdict: expands derives from proven entries only (JG-155)", () => {
  it("summary.expands is true only with a proven widens delta in a failing category", () => {
    assert.equal(cases.diff("hook-added").summary.expands, true);
    assert.equal(cases.diff("deny-removed").summary.expands, true, "deny removed is proven even though the rule's breadth is projected");
    assert.equal(cases.diff("allow-added").summary.expands, false, "scoped-allow is not a failing category by default");
    assert.equal(cases.diff("i4-wildcard-before-subcommand").summary.expands, false, "a glob allow is undecided");
    assert.equal(cases.diff("i7-mcp-var-url").summary.expands, false, "an unresolved server is not proven");
    assert.equal(cases.diff("i1-deny-and-allow-added").summary.expands, false, "a shadowed allow is projected neutral");
    assert.equal(cases.diff("deny-added").summary.expands, false);
    assert.equal(cases.diff("allow-added", { failOn: ["scoped-allow"], strict: false }).summary.expands, true, "proven scoped allow with --fail-on scoped-allow");
  });

  it("summary.categories lists every widening delta's category, any tier", () => {
    assert.deepEqual(cases.diff("hook-added").summary.categories, ["hook"]);
    assert.deepEqual(cases.diff("i7-mcp-var-url").summary.categories, ["mcp"]);
    assert.deepEqual(cases.diff("i3-exact-and-prefix").summary.categories, ["scoped-allow"]);
    assert.deepEqual(cases.diff("i2-whole-tool").summary.categories, ["whole-tool-allow"]);
    assert.deepEqual(cases.diff("deny-added").summary.categories, []);
    assert.deepEqual(cases.diff("i8-ignored-shapes").summary.categories, []);
  });

  it("every default failing category is reachable: hook, mcp (incl. enableAllProjectMcpServers), mode, whole-tool-allow, directory, hooks-reenabled, deny-removed", () => {
    const reached: Record<string, string> = {
      hook: "hook-added",
      mcp: "mcp-added",
      mode: "mode-widened",
      "whole-tool-allow": "i2-whole-tool",
      directory: "dir-added",
      "hooks-reenabled": "disable-all-hooks-off",
      "deny-removed": "deny-removed",
    };
    for (const category of DEFAULT_FAILING_CATEGORIES) {
      const diff = cases.diff(reached[category] ?? "");
      assert.deepEqual(diff.summary.categories, [category], category);
      assert.equal(diff.summary.exit_code, 1, category);
      assert.equal(diff.summary.expands, true, category);
    }
    assert.deepEqual(cases.diff("enable-all-mcp-on").summary.categories, ["mcp"]);
    assert.equal(cases.diff("enable-all-mcp-on").summary.exit_code, 1);
    assert.equal(cases.diff("mcp-url-changed").summary.exit_code, 1);
    assert.equal(cases.diff("hook-command-changed").summary.exit_code, 1);
  });
});

describe("verdict: --fail-on and --strict (JG-155)", () => {
  it("--fail-on accepts a comma list of every category plus projected", () => {
    assert.deepEqual(FAIL_ON_NAMES, [...CATEGORIES, "projected"]);
    assert.deepEqual(parseFailOnList(" hook, mcp ,,projected "), ["hook", "mcp", "projected"]);
    const resolved = resolveFailOn(["scoped-allow", "hook", "hook"]);
    assert.ok(resolved.ok);
    assert.deepEqual(resolved.failOn, { categories: ["hook", "scoped-allow"], projected: false });
    const bad = resolveFailOn(["hook", "bogus"]);
    assert.ok(!bad.ok);
    assert.match(bad.error, /unknown --fail-on category bogus; valid: hook, mcp/);
    assert.throws(() => computeVerdict(cases.diff("hook-added"), { failOn: ["bogus"], strict: false }), /unknown --fail-on/);
  });

  it("--fail-on overrides the default set: scoped-allow fails, hook no longer does", () => {
    const options = { failOn: ["scoped-allow"], strict: false };
    assert.equal(cases.diff("allow-added", options).summary.exit_code, 1);
    assert.deepEqual(cases.diff("allow-added", options).summary.fail_on, { categories: ["scoped-allow"], projected: false });
    assert.equal(cases.diff("hook-added", options).summary.exit_code, 0);
    assert.equal(cases.diff("hook-added", options).summary.expands, false);
    assert.equal(cases.diff("hook-added", { failOn: ["hook", "scoped-allow"], strict: false }).summary.exit_code, 1);
  });

  it("--fail-on projected keeps the default categories and makes projected widenings exit 1", () => {
    const prefix = cases.diff("i3-exact-and-prefix", PROJECTED);
    assert.equal(prefix.summary.exit_code, 1, "Bash(npm run *) widens on a projected breadth");
    assert.equal(prefix.summary.expands, false, "expands still derives from proven entries only");
    assert.deepEqual(prefix.summary.fail_on, { categories: [...DEFAULT_FAILING_CATEGORIES].sort(), projected: true });
    assert.ok(prefix.summary.reasons.some((reason) => reason.startsWith("expands (projected, scoped-allow): perm:allow:Bash(npm run *)")));
    assert.equal(cases.diff("i3-exact-and-prefix", DEFAULT).summary.exit_code, 0);
    assert.equal(cases.diff("hook-added", PROJECTED).summary.exit_code, 1, "default categories still fail");
    assert.equal(cases.diff("i4-wildcard-before-subcommand", PROJECTED).summary.exit_code, 1);
    assert.equal(cases.diff("i1-deny-and-allow-added", PROJECTED).summary.exit_code, 2, "a shadowed (neutral) rule is not a projected widening");
    assert.equal(cases.diff("deny-added", PROJECTED).summary.exit_code, 0, "a projected narrowing never fails");
  });

  it("--strict turns exit 2 into exit 1 and leaves 0, 1 and 3 alone", () => {
    assert.equal(cases.diff("i4-wildcard-before-subcommand", STRICT).summary.exit_code, 1);
    assert.equal(cases.diff("unknown-shape", STRICT).summary.exit_code, 1);
    assert.equal(cases.diff("unknown-shape", STRICT).summary.expands, false);
    assert.ok(cases.diff("unknown-shape", STRICT).summary.reasons.includes("strict: undecided deltas fail"));
    assert.equal(cases.diff("deny-added", STRICT).summary.exit_code, 0);
    assert.equal(cases.diff("hook-added", STRICT).summary.exit_code, 1);
    assert.equal(cases.diff("incomplete-head", STRICT).summary.exit_code, 3);
  });
});

describe("verdict: exit-code matrix (JG-155)", () => {
  const ROWS: Array<{ label: string; name: string; expected: [number, number, number] }> = [
    { label: "none", name: "no-change", expected: [0, 0, 0] },
    { label: "narrows-only", name: "deny-added", expected: [0, 0, 0] },
    { label: "proven-widen-failing", name: "hook-added", expected: [1, 1, 1] },
    { label: "proven-widen-annotate-only", name: "allow-added", expected: [0, 0, 0] },
    { label: "projected-only", name: "i4-wildcard-before-subcommand", expected: [2, 1, 1] },
    { label: "unresolved-only", name: "unknown-shape", expected: [2, 1, 2] },
    { label: "incomplete", name: "incomplete-head", expected: [3, 3, 3] },
  ];
  const COLUMNS: Array<[string, VerdictOptions]> = [
    ["default", DEFAULT],
    ["--strict", STRICT],
    ["--fail-on projected", PROJECTED],
  ];

  for (const row of ROWS) {
    for (const [index, [label, options]] of COLUMNS.entries()) {
      it(`${row.label} × ${label} → exit ${row.expected[index]}`, () => {
        const diff = cases.diff(row.name, options);
        assert.equal(diff.summary.exit_code, row.expected[index], diff.summary.reasons.join("\n"));
        assert.equal(computeVerdict(diff, options).exit_code, row.expected[index]);
        assert.equal(diff.summary.strict, options.strict);
      });
    }
  }

  it("verdict labels follow the code: no-change, pass, expands, undecided, incomplete", () => {
    assert.equal(cases.diff("no-change").summary.verdict, "no-change");
    assert.equal(cases.diff("deny-added").summary.verdict, "pass");
    assert.equal(cases.diff("allow-added").summary.verdict, "pass");
    assert.equal(cases.diff("hook-added").summary.verdict, "expands");
    assert.equal(cases.diff("unknown-shape").summary.verdict, "undecided");
    assert.equal(cases.diff("unknown-shape", STRICT).summary.verdict, "undecided");
    assert.equal(cases.diff("incomplete-head").summary.verdict, "incomplete");
  });
});

describe("verdict: incomplete always wins (JG-155)", () => {
  it("exit 3 even when a proven expansion is also present, with both reported", () => {
    for (const options of [DEFAULT, STRICT, PROJECTED]) {
      const diff = cases.diff("incomplete-with-expansion", options);
      assert.equal(diff.summary.exit_code, 3);
      assert.equal(diff.summary.verdict, "incomplete");
      assert.equal(diff.summary.expands, true, "the proven expansion is still computed");
      assert.deepEqual(diff.summary.categories, ["hook"]);
      assert.equal(diff.incomplete.length, 1);
      assert.match(diff.incomplete[0]?.reason ?? "", /duplicate key "mcpServers"/);
      assert.ok(diff.summary.reasons.some((reason) => reason.startsWith("incomplete: .mcp.json: duplicate key")), diff.summary.reasons.join("\n"));
      assert.ok(diff.summary.reasons.some((reason) => reason.startsWith("expands (hook): hook:PreToolUse:Bash:")), diff.summary.reasons.join("\n"));
      const hook = deltaFor(diff, /^hook:/);
      assert.equal(hook.direction, "widens");
      assert.equal(hook.tier, "proven");
    }
  });

  it("an incomplete side with no deltas is still exit 3, never no-change", () => {
    const diff = cases.diff("incomplete-head");
    assert.equal(diff.summary.exit_code, 3);
    assert.notEqual(diff.summary.verdict, "no-change");
    assert.ok(diff.incomplete.some((item) => item.path === ".mcp.json" && /duplicate key "mcpServers"/.test(item.reason)));
    assert.deepEqual([diff.added, diff.removed, diff.changed, diff.unresolved], [[], [], [], []], "settings are unchanged; the unreadable .mcp.json yields no entry");
  });
});

describe("verdict: negative case, deny + allow for the same string (JG-155)", () => {
  it("the allow is shadowed (I1, projected) and never counted as a proven expansion", () => {
    const diff = cases.diff("i1-deny-and-allow-added");
    const allow = deltaFor(diff, "perm:allow:Bash(git push)");
    assert.equal(allow.tier, "projected");
    assert.ok(allow.flags.includes("shadowed"));
    assert.ok(isUndecided(allow));
    assert.equal(diff.summary.expands, false);
    assert.equal(diff.summary.exit_code, 2, "annotated, not failed");
    assert.equal(cases.diff("i1-deny-and-allow-added", STRICT).summary.exit_code, 1);
    assert.equal(cases.diff("i1-deny-and-allow-added", { failOn: ["scoped-allow", "whole-tool-allow"], strict: false }).summary.expands, false);
  });
});
