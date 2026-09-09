import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { canonicalJson } from "../src/canonical.js";
import { INTERPRETATIONS, INTERPRETATIONS_DATE, NOT_INTERPRETED, OUTSIDE_LIST_NOTE, applyInterpretations, detectNotInterpreted, findInterpretation, findNotInterpreted } from "../src/interpretations/index.js";
import { isLoopbackHost, urlHost } from "../src/interpretations/i7-mcp-transport.js";
import { SEMANTICS_DOC_DATE, type Delta, type Entry, type Snapshot } from "../src/types.js";
import { DiffCases, deltaFor, deltasOf, listOf } from "./diff-helpers.js";

const cases = new DiffCases();
after(() => cases.cleanup());

const IDS = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8"];

function entryOf(name: string, key: string | RegExp): { entry: Entry; snapshot: Snapshot } {
  const { head } = cases.snapshots(name);
  const entry = head.entries.find((candidate) => (typeof key === "string" ? candidate.key === key : key.test(candidate.key)));
  if (entry === undefined) {
    throw new Error(`no entry ${String(key)} in ${name}`);
  }
  return { entry, snapshot: head };
}

describe("interpretations: closed list metadata (JG-154)", () => {
  it("is the ordered closed list I1..I8, each citing a doc section and the 2026-09-07 date", () => {
    assert.deepEqual(
      INTERPRETATIONS.map(({ META }) => META.id),
      IDS,
    );
    assert.equal(INTERPRETATIONS_DATE, "2026-09-07");
    assert.equal(SEMANTICS_DOC_DATE, INTERPRETATIONS_DATE);
    for (const { META, classify } of INTERPRETATIONS) {
      assert.equal(META.semantics_doc_date, "2026-09-07", META.id);
      assert.ok(META.doc_section.length > 5, `${META.id} doc_section`);
      assert.ok(META.title.length > 0 && META.summary.length > 0 && META.explain.length > 50, META.id);
      assert.ok(["proven", "projected", "proven / unresolved"].includes(META.tier), `${META.id} tier ${META.tier}`);
      assert.equal(typeof classify, "function");
      assert.equal(findInterpretation(META.id)?.META, META);
    }
    assert.equal(findInterpretation("I9"), null);
    assert.deepEqual(
      INTERPRETATIONS.map(({ META }) => META.tier),
      ["projected", "proven", "projected", "projected", "proven", "proven", "proven / unresolved", "proven"],
    );
  });

  it("classify is pure: it never mutates the entry or the snapshot", () => {
    const { entry, snapshot } = entryOf("i4-wildcard-before-subcommand", "perm:allow:Bash(git * main)");
    const before = canonicalJson({ entry, snapshot });
    for (const interpretation of INTERPRETATIONS) {
      interpretation.classify(entry, snapshot);
    }
    detectNotInterpreted(entry);
    assert.equal(canonicalJson({ entry, snapshot }), before);
  });
});

describe("interpretations I1 rule-string shadowing (projected)", () => {
  it("an allow added for a string base already denies is shadowed: neutral, projected, flagged", () => {
    const diff = cases.diff("i1-shadowed-by-existing-deny");
    const delta = deltaFor(diff, "perm:allow:Bash(rm *)");
    assert.equal(delta.direction, "neutral");
    assert.equal(delta.tier, "projected");
    assert.ok(delta.flags.includes("shadowed"));
    assert.ok(delta.interpretations.includes("I1"));
    assert.ok(delta.notes.some((note) => note.includes("shadowed by perm:deny:Bash(rm *)") && note.includes("deny → ask → allow")), delta.notes.join("\n"));
    assert.equal(listOf(diff, "perm:allow:Bash(rm *)"), "unresolved");
    assert.equal(delta.category, null);
    assert.equal(diff.summary.expands, false);
  });

  it("an allow added for a string that ask lists is shadowed by the ask rule", () => {
    const delta = deltaFor(cases.diff("i1-shadowed-by-ask"), "perm:allow:Bash(git push)");
    assert.equal(delta.direction, "neutral");
    assert.ok(delta.notes.some((note) => note.includes("shadowed by perm:ask:Bash(git push)")));
  });

  it("negative case (JG-155): deny and allow added for the same string → allow shadowed, never a proven expansion", () => {
    const diff = cases.diff("i1-deny-and-allow-added");
    const deny = deltaFor(diff, "perm:deny:Bash(git push)");
    const allow = deltaFor(diff, "perm:allow:Bash(git push)");
    assert.equal(deny.direction, "narrows");
    assert.equal(deny.tier, "proven");
    assert.equal(allow.direction, "neutral");
    assert.equal(allow.tier, "projected");
    assert.ok(allow.flags.includes("shadowed"));
    assert.equal(diff.summary.expands, false);
    assert.notEqual(diff.summary.exit_code, 1);
  });

  it("I1 makes no claim about a deny rule or an unshadowed allow", () => {
    const i1 = findInterpretation("I1")!;
    const { entry: deny, snapshot } = entryOf("i1-deny-and-allow-added", "perm:deny:Bash(git push)");
    assert.equal(i1.classify(deny, snapshot), null);
    const { entry: allow } = entryOf("i1-deny-and-allow-added", "perm:allow:Bash(npm test)");
    assert.equal(i1.classify(allow, snapshot), null);
  });
});

describe("interpretations I2 whole-tool vs scoped (proven)", () => {
  it("Bash and Bash(*) are whole_tool, proven, category whole-tool-allow", () => {
    const diff = cases.diff("i2-whole-tool");
    for (const key of ["perm:allow:Bash", "perm:allow:Bash(*)", "perm:allow:Read"]) {
      const delta = deltaFor(diff, key);
      assert.equal(delta.breadth, "whole_tool", key);
      assert.equal(delta.breadth_tier, "proven", key);
      assert.equal(delta.tier, "proven", key);
      assert.equal(delta.direction, "widens", key);
      assert.equal(delta.category, "whole-tool-allow", key);
      assert.ok(delta.interpretations.includes("I2"), key);
      assert.equal(listOf(diff, key), "added", key);
    }
    assert.equal(diff.summary.expands, true);
  });

  it("Bash(...) is scoped: I2 claims proven without a breadth and leaves breadth to I3", () => {
    const { entry, snapshot } = entryOf("i3-exact-and-prefix", "perm:allow:Bash(npm run build)");
    const claim = findInterpretation("I2")!.classify(entry, snapshot);
    assert.notEqual(claim, null);
    assert.equal(claim?.breadth, undefined);
    assert.equal(claim?.tier, "proven");
  });
});

describe("interpretations I3 / I4 Bash breadth (projected)", () => {
  it("Bash(npm run build) → exact, proven; Bash(npm run *) → prefix, projected", () => {
    const diff = cases.diff("i3-exact-and-prefix");
    const exact = deltaFor(diff, "perm:allow:Bash(npm run build)");
    assert.equal(exact.breadth, "exact");
    assert.equal(exact.breadth_tier, "proven");
    assert.equal(exact.tier, "proven");
    assert.equal(exact.category, "scoped-allow");
    assert.equal(listOf(diff, exact.key), "added");
    const prefix = deltaFor(diff, "perm:allow:Bash(npm run *)");
    assert.equal(prefix.breadth, "prefix");
    assert.equal(prefix.breadth_tier, "projected");
    assert.equal(prefix.category, "scoped-allow");
    assert.equal(listOf(diff, prefix.key), "added", "a prefix allow is decided (annotate-only), not unresolved");
    const { entry, snapshot } = entryOf("i3-exact-and-prefix", "perm:allow:Bash(npm run *)");
    const claim = findInterpretation("I3")!.classify(entry, snapshot);
    assert.deepEqual([claim?.breadth, claim?.tier], ["prefix", "projected"]);
    const exactClaim = findInterpretation("I3")!.classify(entryOf("i3-exact-and-prefix", "perm:allow:Bash(npm run build)").entry, snapshot);
    assert.deepEqual([exactClaim?.breadth, exactClaim?.tier], ["exact", "proven"]);
  });

  it("Bash(git * main) → breadth glob, flagged broad, projected, listed as unresolved", () => {
    const diff = cases.diff("i4-wildcard-before-subcommand");
    const delta = deltaFor(diff, "perm:allow:Bash(git * main)");
    assert.equal(delta.breadth, "glob");
    assert.equal(delta.breadth_tier, "projected");
    assert.ok(delta.flags.includes("broad"));
    assert.ok(delta.flags.includes("breadth_unresolved"));
    assert.ok(delta.interpretations.includes("I3") && delta.interpretations.includes("I4"));
    assert.equal(listOf(diff, delta.key), "unresolved");
    assert.equal(delta.direction, "widens");
    assert.equal(delta.category, "scoped-allow");
    const { entry, snapshot } = entryOf("i4-wildcard-before-subcommand", "perm:allow:Bash(git * main)");
    const claim = findInterpretation("I4")!.classify(entry, snapshot);
    assert.deepEqual([claim?.breadth, claim?.tier, claim?.flags], ["glob", "projected", ["broad"]]);
    assert.equal(findInterpretation("I4")!.classify(entryOf("i3-exact-and-prefix", "perm:allow:Bash(npm run *)").entry, snapshot), null, "a trailing wildcard is not broad");
  });
});

describe("interpretations I5 defaultMode (proven)", () => {
  it("bypassPermissions, auto and dontAsk widen; dontAsk carries the not-allow-everything note", () => {
    for (const name of ["mode-widened", "mode-widened-auto", "mode-widened-dontask"]) {
      const delta = deltaFor(cases.diff(name), "mode:defaultMode");
      assert.equal(delta.direction, "widens", name);
      assert.equal(delta.tier, "proven", name);
      assert.equal(delta.category, "mode", name);
      assert.ok(delta.interpretations.includes("I5"), name);
    }
    const dontAsk = deltaFor(cases.diff("mode-widened-dontask"), "mode:defaultMode");
    assert.ok(dontAsk.notes.some((note) => note.includes("dontAsk is not allow-everything")), dontAsk.notes.join("\n"));
  });

  it("acceptEdits, plan and default do not widen", () => {
    const delta = deltaFor(cases.diff("mode-neutral"), "mode:defaultMode");
    assert.equal(delta.direction, "neutral");
    assert.equal(delta.tier, "proven");
    assert.equal(delta.category, null);
  });

  it("negative case: an unknown defaultMode value → unresolved, direction unknown, never widens", () => {
    const diff = cases.diff("mode-unknown");
    const delta = deltaFor(diff, "mode:defaultMode");
    assert.equal(delta.tier, "unresolved");
    assert.equal(delta.direction, "unknown");
    assert.equal(delta.category, null);
    assert.equal(listOf(diff, "mode:defaultMode"), "unresolved");
    assert.equal(diff.summary.expands, false);
    assert.ok(delta.notes.some((note) => note.includes('"yolo" is not a documented value')));
    for (const options of [{ failOn: [], strict: false }, { failOn: ["projected"], strict: true }]) {
      assert.equal(cases.diff("mode-unknown", options).summary.expands, false);
    }
  });
});

describe("interpretations I6 hooks (proven)", () => {
  it("hook presence per event and matcher is proven; the command is recorded, never executed", () => {
    const delta = deltaFor(cases.diff("hook-added"), /^hook:PreToolUse:Bash:/);
    assert.equal(delta.tier, "proven");
    assert.ok(delta.interpretations.includes("I6"));
    assert.ok(delta.notes.some((note) => note.includes('hook on PreToolUse for matcher "Bash"') && note.includes("never executed")), delta.notes.join("\n"));
    assert.equal((delta.head?.value as { command: string }).command, "echo pre-bash");
  });
});

describe("interpretations I7 MCP transport (proven / unresolved)", () => {
  it('"url": "http://example.com" → proven, flagged plaintext', () => {
    const diff = cases.diff("i7-mcp-http-remote");
    const delta = deltaFor(diff, "mcp:build");
    assert.equal(delta.tier, "proven");
    assert.ok(delta.flags.includes("plaintext"));
    assert.equal(delta.direction, "widens");
    assert.equal(delta.category, "mcp");
    assert.equal(listOf(diff, "mcp:build"), "added");
  });

  it('"url": "http://localhost:3000" (and 127.0.0.1, [::1]) → proven, not flagged plaintext', () => {
    const diff = cases.diff("i7-mcp-http-loopback");
    for (const key of ["mcp:local", "mcp:local4", "mcp:local6"]) {
      const delta = deltaFor(diff, key);
      assert.equal(delta.tier, "proven", key);
      assert.ok(!delta.flags.includes("plaintext"), key);
      assert.ok(delta.notes.some((note) => note.includes("loopback")), key);
    }
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("[::1]"), true);
    assert.equal(isLoopbackHost("example.com"), false);
    assert.equal(urlHost("http://[::1]:3000/sse"), "[::1]");
    assert.equal(urlHost("http://user@example.com:8080/x"), "example.com");
  });

  it('"url": "http://${MCP_HOST}/sse" → unresolved, never expanded', () => {
    const diff = cases.diff("i7-mcp-var-url");
    const delta = deltaFor(diff, "mcp:events");
    assert.equal(delta.tier, "unresolved");
    assert.ok(delta.flags.includes("variable_reference"));
    assert.equal(listOf(diff, "mcp:events"), "unresolved");
    assert.equal(delta.direction, "widens", "the direction table still says an added server widens");
    assert.equal(delta.category, "mcp");
    assert.equal(diff.summary.expands, false, "an unresolved delta is never a proven expansion");
    assert.equal(diff.summary.exit_code, 2);
  });

  it("https:// is proven and unflagged; stdio is proven with the command recorded", () => {
    const https = deltaFor(cases.diff("i7-mcp-https"), "mcp:build");
    assert.deepEqual([https.tier, https.flags], ["proven", []]);
    const stdio = deltaFor(cases.diff("mcp-added"), "mcp:docs");
    assert.equal(stdio.tier, "proven");
    assert.ok(stdio.notes.some((note) => note.includes('command "npx" recorded, never executed')));
  });
});

describe("interpretations I8 ignored shapes (proven)", () => {
  const SHAPES = [
    "perm:allow:Write(src/)",
    "perm:allow:NotebookEdit(notebooks/a.ipynb)",
    "perm:allow:Glob(src/**)",
    "perm:allow:MultiEdit(src/)",
    "perm:allow:mcp__docs__search(query)",
    "perm:allow:Read(*.env)",
    "perm:deny:Write(secrets/)",
  ];

  it("Write(src/) in allow → flagged ignored by Claude Code, direction neutral (it grants nothing)", () => {
    const diff = cases.diff("i8-ignored-shapes");
    const delta = deltaFor(diff, "perm:allow:Write(src/)");
    assert.equal(delta.direction, "neutral");
    assert.equal(delta.tier, "proven");
    assert.ok(delta.flags.includes("ignored_by_claude_code"));
    assert.ok(delta.notes.some((note) => note.includes("ignored by Claude Code") && note.includes("grants nothing")), delta.notes.join("\n"));
    assert.equal(delta.category, null);
    assert.equal(listOf(diff, delta.key), "added");
  });

  it("every documented ignored shape is neutral, proven and flagged; the diff exits 0", () => {
    const diff = cases.diff("i8-ignored-shapes");
    for (const key of SHAPES) {
      const delta = deltaFor(diff, key);
      assert.equal(delta.direction, "neutral", key);
      assert.equal(delta.tier, "proven", key);
      assert.ok(delta.flags.includes("ignored_by_claude_code"), key);
      assert.ok(delta.interpretations.includes("I8"), key);
    }
    assert.equal(diff.summary.exit_code, 0);
    assert.equal(diff.summary.expands, false);
  });
});

describe("interpretations: explicitly not interpreted → unresolved with a note naming the item (JG-154)", () => {
  const OBSERVABLE: Array<{ name: string; id: string; keys: string[]; phrase: string }> = [
    {
      name: "ni-compound-command",
      id: "N-compound-command",
      keys: ["perm:allow:Bash(npm test && npm run build)", "perm:allow:Bash(cd src; ls)", "perm:allow:Bash(cat a.txt | grep x)"],
      phrase: "compound-command splitting",
    },
    {
      name: "ni-wrapper-stripping",
      id: "N-wrapper-stripping",
      keys: ["perm:allow:Bash(sudo apt-get install *)", "perm:allow:Bash(env ls)", "perm:allow:Bash(time make)", "perm:allow:Bash(xargs rm)"],
      phrase: "wrapper stripping",
    },
    { name: "ni-env-assignment", id: "N-env-assignment", keys: ["perm:allow:Bash(FOO=bar make)"], phrase: "env-assignment stripping" },
    { name: "ni-redirect", id: "N-redirect", keys: ["perm:allow:Bash(echo hello > out.txt)"], phrase: "redirect checks" },
    { name: "ni-path-anchoring", id: "N-path-anchoring", keys: ["perm:allow:Read(/etc/example.conf)", "perm:allow:Edit(//src/app.ts)", "perm:allow:Read(~/notes.md)"], phrase: "path anchoring" },
    { name: "ni-depth-semantics", id: "N-depth-semantics", keys: ["perm:allow:Read(src/**)", "perm:allow:Edit(src/*)"], phrase: "depth semantics" },
    { name: "ni-symlink-pairing", id: "N-symlink-pairing", keys: ["perm:allow:Edit(build/current/config.json)"], phrase: "symlink pairing" },
    { name: "ni-plugin-provided", id: "N-plugin-provided", keys: ["plugin_flag:enabledPlugins"], phrase: "plugin-provided hooks and servers" },
  ];

  for (const item of OBSERVABLE) {
    it(`${item.id}: ${item.name} → unresolved, note names "${item.phrase}"`, () => {
      const diff = cases.diff(item.name);
      assert.notEqual(findNotInterpreted(item.id), null);
      for (const key of item.keys) {
        const delta = deltaFor(diff, key);
        assert.equal(delta.tier, "unresolved", key);
        assert.equal(listOf(diff, key), "unresolved", key);
        assert.ok(delta.interpretations.includes(item.id), `${key}: ${delta.interpretations.join(",")}`);
        assert.ok(delta.notes.some((note) => note.startsWith("not interpreted:") && note.includes(item.phrase)), `${key}: ${delta.notes.join("\n")}`);
        if (delta.kind === "perm") {
          assert.equal(delta.breadth, "unknown", `${key}: no breadth is claimed for a rule that is not interpreted`);
          assert.equal(delta.breadth_tier, null, key);
        }
      }
      assert.equal(diff.summary.expands, false);
      assert.equal(diff.summary.exit_code, 2);
    });
  }

  for (const item of [
    { name: "ni-skill-allowed-tools", id: "N-skill-allowed-tools" },
    { name: "ni-subagent-frontmatter", id: "N-subagent-frontmatter" },
  ]) {
    it(`${item.id}: ${item.name} is not a V0 input; no entry, no claim, documented as not observable`, () => {
      const diff = cases.diff(item.name);
      assert.deepEqual(deltasOf(diff), []);
      assert.equal(diff.summary.exit_code, 0);
      const listed = findNotInterpreted(item.id);
      assert.notEqual(listed, null);
      assert.equal(listed?.detect, undefined);
      assert.match(listed?.explain ?? "", /not among the V0 inputs/);
    });
  }

  it("lists every item from the epic", () => {
    assert.deepEqual(
      NOT_INTERPRETED.map((item) => item.id),
      [
        "N-compound-command",
        "N-wrapper-stripping",
        "N-env-assignment",
        "N-redirect",
        "N-path-anchoring",
        "N-depth-semantics",
        "N-symlink-pairing",
        "N-plugin-provided",
        "N-skill-allowed-tools",
        "N-subagent-frontmatter",
      ],
    );
  });

  it("anything outside the list (an unknown top-level key) is unresolved with the outside-list note", () => {
    const diff = cases.diff("unknown-shape");
    const delta = deltaFor(diff, "unknown:/model");
    assert.equal(delta.tier, "unresolved");
    assert.deepEqual(delta.interpretations, []);
    assert.ok(delta.notes.includes(OUTSIDE_LIST_NOTE));
    assert.match(OUTSIDE_LIST_NOTE, /2026-09-07/);
  });

  it("applyInterpretations returns a new delta and leaves its input untouched", () => {
    const { base, head } = cases.snapshots("i4-wildcard-before-subcommand");
    const entry = head.entries.find((candidate) => candidate.key === "perm:allow:Bash(git * main)")!;
    const delta: Delta = {
      key: entry.key,
      kind: "perm",
      change: "added",
      base: null,
      head: entry,
      direction: "widens",
      tier: "proven",
      breadth: "unknown",
      breadth_tier: null,
      category: null,
      rule: "D-allow-added",
      interpretations: [],
      flags: [],
      notes: [],
    };
    const before = canonicalJson(delta);
    const applied = applyInterpretations(delta, base, head);
    assert.equal(canonicalJson(delta), before);
    assert.notEqual(applied, delta);
    assert.deepEqual(applied.interpretations, ["I2", "I3", "I4"]);
    assert.equal(applied.breadth, "glob");
  });
});
