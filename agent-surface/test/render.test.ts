import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { EXIT_INCOMPLETE, EXIT_OK, run } from "../src/cli.js";
import { CREDENTIAL_PRESENT } from "../src/redact.js";
import { renderDiffJson, renderSnapshotJson } from "../src/render/json.js";
import { ASSUMPTION_LINES, KIND_GROUPS, NO_CONFIGURATION_LINE } from "../src/render/shared.js";
import { renderDeltaLine, renderDiffText, renderSnapshotText } from "../src/render/text.js";
import { takeSnapshot } from "../src/snapshot.js";
import type { Delta, Diff } from "../src/types.js";
import { DiffCases, deltasOf } from "./diff-helpers.js";
import { makeRepo, removeDir, runCli } from "./helpers.js";

const cases = new DiffCases();
const repos: string[] = [];
after(() => {
  cases.cleanup();
  for (const dir of repos) {
    removeDir(dir);
  }
});

/** The §3.7 block exactly as the epic prints it (JG-145). */
const ASSUMPTIONS_BLOCK = [
  "Assumptions",
  "  Semantics doc date     2026-09-07",
  "  Scope                  repository-controlled files only",
  "  Workspace trust        assumed accepted (allow rules/dirs are held until then)",
  "  Runtime mode           per defaultMode in head; CLI flags not modeled",
  "  Sandbox                not modeled",
  "  Hooks                  presence only; decisions not modeled",
  "  Managed/user/local     not read",
  "  Plugins                not modeled (flagged if enabledPlugins non-empty)",
];

function lines(text: string): string[] {
  return text.replace(/\n$/, "").split("\n");
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function sectionIndex(text: string, name: string): number {
  return lines(text).indexOf(name);
}

/** Compose one Diff out of the deltas of several fixture diffs (the renderer is pure). */
function compose(parts: Partial<Pick<Diff, "added" | "removed" | "changed" | "unresolved" | "incomplete">>): Diff {
  const base = cases.diff("no-change");
  return { ...base, added: [], removed: [], changed: [], unresolved: [], incomplete: [], ...parts };
}

function inProcess(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const status = run(args, { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, { cwd });
  return { status, stdout: out.join(""), stderr: err.join("") };
}

describe("text renderer: header and Assumptions block (JG-156)", () => {
  it("prints the header and the eight labelled assumption lines exactly once, for diff and snapshot", () => {
    const repo = cases.repo("hook-added");
    const text = renderDiffText(cases.diff("hook-added"));
    const head = lines(text);
    assert.equal(head[0], `CONTROL-SURFACE DIFF  base=${repo.baseSha} head=${repo.headSha}`);
    assert.deepEqual(head.slice(1, 10), ASSUMPTIONS_BLOCK);
    assert.equal(count(text, "Assumptions\n"), 1);
    assert.equal(count(text, "Semantics doc date"), 1);
    assert.equal(ASSUMPTION_LINES.length, 8);

    const snapshot = cases.snapshots("hook-added").head;
    const snapshotText = renderSnapshotText(snapshot);
    const snapshotLines = lines(snapshotText);
    assert.equal(snapshotLines[0], `CONTROL-SURFACE SNAPSHOT  origin=git spec=${repo.headSha} sha=${repo.headSha}`);
    assert.deepEqual(snapshotLines.slice(1, 10), ASSUMPTIONS_BLOCK);
    assert.equal(count(snapshotText, "Assumptions\n"), 1);

    const cli = runCli(["check", "--base", repo.baseSha, "--head", repo.headSha], repo.dir);
    assert.deepEqual(lines(cli.stdout).slice(0, 10), [head[0], ...ASSUMPTIONS_BLOCK]);
    assert.equal(count(cli.stdout, "Assumptions\n"), 1);
  });

  it("appends the tracked-local and enabledPlugins notes as Flagged lines after the eight fixed lines", () => {
    const local = renderDiffText(cases.diff("local-allow-added"));
    assert.equal(lines(local)[10], "  Flagged (head)         local file shared via Git (trust-held by Claude Code): .claude/settings.local.json is tracked and included");
    const plugins = renderDiffText(cases.diff("ni-plugin-provided"));
    assert.match(lines(plugins)[10] ?? "", /^ {2}Flagged \(head\) {9}plugins: enabledPlugins is non-empty/);
    assert.equal(count(plugins, "Assumptions\n"), 1);
  });
});

describe("text renderer: sections and grouping (JG-156)", () => {
  it("orders EXPANDED → NARROWED → CHANGED → UNRESOLVED and omits empty sections", () => {
    const composed = compose({
      added: [...cases.diff("hook-added").added, ...cases.diff("i8-ignored-shapes").added],
      removed: cases.diff("allow-removed").removed,
      changed: cases.diff("mode-neutral").changed,
      unresolved: cases.diff("i4-wildcard-before-subcommand").unresolved,
    });
    const text = renderDiffText(composed);
    const order = ["EXPANDED", "NARROWED", "CHANGED", "UNRESOLVED"].map((name) => sectionIndex(text, name));
    assert.ok(order.every((index) => index > 9), text);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "sections are in order");
    assert.equal(sectionIndex(text, "INCOMPLETE"), -1);

    const onlyExpanded = renderDiffText(cases.diff("hook-added"));
    assert.ok(onlyExpanded.includes("\nEXPANDED\n"));
    for (const name of ["NARROWED", "CHANGED", "UNRESOLVED", "INCOMPLETE"]) {
      assert.equal(sectionIndex(onlyExpanded, name), -1, `${name} omitted when empty`);
    }
    const onlyNarrowed = renderDiffText(cases.diff("deny-added"));
    assert.ok(onlyNarrowed.includes("\nNARROWED\n  permissions\n    added   perm        perm:deny:"));
    assert.equal(sectionIndex(onlyNarrowed, "EXPANDED"), -1);
  });

  it("groups EXPANDED by kind in the order hooks, MCP, permissions, directories, mode, flags", () => {
    const composed = compose({
      added: [
        ...cases.diff("dir-added").added,
        ...cases.diff("i2-whole-tool").added,
        ...cases.diff("mcp-added").added,
        ...cases.diff("hook-added").added,
      ],
      changed: [...cases.diff("enable-all-mcp-on").changed, ...cases.diff("mode-widened").changed],
    });
    const text = renderDiffText(composed);
    const expanded = lines(text).slice(sectionIndex(text, "EXPANDED"));
    const groups = expanded.filter((line) => /^ {2}\S/.test(line)).map((line) => line.trim());
    assert.deepEqual(groups.slice(0, 6), ["hooks", "MCP", "permissions", "directories", "mode", "flags"]);
    assert.deepEqual(
      KIND_GROUPS.map((group) => group.label),
      ["hooks", "MCP", "permissions", "directories", "mode", "flags", "other"],
    );
    assert.ok(deltasOf(composed).every((delta) => text.includes(` ${delta.key}  `)), "every delta is printed");
  });

  it("each line shows change, kind, key, direction, tier, breadth (perm only) and file:line", () => {
    const perm = deltasOf(cases.diff("i3-exact-and-prefix")).find((delta) => delta.key === "perm:allow:Bash(npm run *)") as Delta;
    assert.equal(renderDeltaLine(perm), "    added   perm        perm:allow:Bash(npm run *)  widens proven prefix  .claude/settings.json:10");
    const hook = deltasOf(cases.diff("hook-added"))[0] as Delta;
    assert.match(renderDeltaLine(hook), /^ {4}added {3}hook {8}hook:PreToolUse:Bash:[0-9a-f]{64} {2}widens proven {2}\.claude\/settings\.json:19$/);
    assert.ok(!renderDeltaLine(hook).includes(" - "), "no breadth placeholder for non-perm entries");
    const local = deltasOf(cases.diff("local-allow-added"))[0] as Delta;
    assert.equal(renderDeltaLine(local), "    added   perm        perm:allow:Bash  widens proven whole_tool [tracked_local]  .claude/settings.local.json:8");
    const moved = deltasOf(cases.diff("moved-file"))[0] as Delta;
    assert.match(renderDeltaLine(moved), /^ {4}moved {3}perm {8}perm:allow:Bash\(ls \*\) {2}neutral proven prefix \[tracked_local\] {2}\.claude\/settings\.local\.json:\d+$/);
  });

  it("prints INCOMPLETE first after the header whenever non-empty, and never 'no changes'", () => {
    const both = renderDiffText(cases.diff("incomplete-with-expansion"));
    assert.equal(lines(both)[10], "INCOMPLETE");
    assert.match(lines(both)[11] ?? "", /^ {2}\.mcp\.json: duplicate key "mcpServers" at \/mcpServers \(lines 6, 7\)$/);
    assert.ok(sectionIndex(both, "INCOMPLETE") < sectionIndex(both, "EXPANDED"));
    assert.ok(!/no changes/i.test(both));
    const only = renderDiffText(cases.diff("incomplete-head"));
    assert.equal(lines(only)[10], "INCOMPLETE");
    assert.ok(!/no changes/i.test(only));
    assert.ok(only.includes("\nno deltas derived; the scan is incomplete and this is not a clean result\n"));
    assert.match(only, /\nverdict: incomplete \(exit 3\)/);
  });

  it("negative case: only unresolved deltas → UNRESOLVED section plus one line that no verdict was derived", () => {
    for (const name of ["i4-wildcard-before-subcommand", "unknown-shape", "i7-mcp-var-url"]) {
      const diff = cases.diff(name);
      assert.deepEqual([diff.added, diff.removed, diff.changed], [[], [], []], name);
      const text = renderDiffText(diff);
      assert.ok(text.includes("\nUNRESOLVED\n"), name);
      assert.equal(count(text, "no verdict derived"), 1, name);
      assert.match(text, /\nno verdict derived: every change \(\d+\) is unresolved; nothing is proven either way\nverdict: undecided \(exit 2\)/, name);
    }
    const decided = renderDiffText(cases.diff("i1-deny-and-allow-added"));
    assert.ok(decided.includes("\nNARROWED\n") && decided.includes("\nUNRESOLVED\n"));
    assert.equal(count(decided, "no verdict derived"), 0, "a diff with a decided delta does not claim no verdict");
  });

  it("prints the no-configuration line when neither side carries any supported file, exit 0", () => {
    const repo = makeRepo("no-config");
    repos.push(repo.dir);
    for (const command of ["check", "diff"]) {
      const cli = runCli([command, "--base", repo.sha, "--head", repo.sha], repo.dir);
      assert.equal(cli.status, EXIT_OK, cli.stderr);
      const out = lines(cli.stdout);
      assert.equal(out[0], `CONTROL-SURFACE DIFF  base=${repo.sha} head=${repo.sha}`);
      assert.deepEqual(out.slice(1, 10), ASSUMPTIONS_BLOCK);
      assert.equal(out[10], NO_CONFIGURATION_LINE);
      assert.match(out[10] ?? "", /^no repository-controlled agent configuration found/);
      assert.ok(!cli.stdout.includes("no changes"));
      assert.match(cli.stdout, /\nverdict: no-change \(exit 0\)/);
    }
    const inproc = inProcess(["check", "--base", repo.sha, "--head", repo.sha], repo.dir);
    assert.equal(inproc.status, EXIT_OK);
    assert.ok(inproc.stdout.includes(`\n${NO_CONFIGURATION_LINE}\n`));
    const configured = renderDiffText(cases.diff("no-change"));
    assert.ok(configured.includes("\nno changes\n") && !configured.includes(NO_CONFIGURATION_LINE));
  });

  it("snapshot text lists sources and entries under the header and prints INCOMPLETE when needed", () => {
    const repo = makeRepo("duplicate");
    repos.push(repo.dir);
    const cli = runCli(["snapshot", "HEAD"], repo.dir);
    assert.equal(cli.status, EXIT_INCOMPLETE);
    const out = lines(cli.stdout);
    assert.equal(out[0], `CONTROL-SURFACE SNAPSHOT  origin=git spec=HEAD sha=${repo.sha}`);
    assert.equal(out[10], "INCOMPLETE");
    assert.match(out[11] ?? "", /^ {2}\.claude\/settings\.json: duplicate key/);
    assert.ok(cli.stdout.includes("\nSOURCES\n"));
    assert.ok(cli.stdout.includes("\nENTRIES (0)\n  none derived; the scan is incomplete and this is not a clean result\n"));
    assert.ok(!/\bnone\n/.test(cli.stdout.replace("none derived", "")), "an incomplete snapshot never reads as clean");
  });
});

describe("renderers: shared redaction (JG-156 / JG-157)", () => {
  it("credential-like literals never reach text or JSON output; the entry says credential-like value present", () => {
    const repo = makeRepo("credential");
    repos.push(repo.dir);
    const snapshot = takeSnapshot({ kind: "git", spec: repo.sha, sha: repo.sha, cwd: repo.dir }).snapshot;
    const text = renderSnapshotText(snapshot);
    const json = renderSnapshotJson(snapshot);
    for (const output of [text, json]) {
      assert.ok(output.includes(CREDENTIAL_PRESENT));
      assert.ok(!output.includes("ghp_SYNTHETIC"), "github token literal leaked");
      assert.ok(!output.includes("xoxb-"), "slack token literal leaked");
      assert.ok(!output.includes("synthetic-literal-header-token"), "bearer literal leaked");
    }
    assert.match(text, /\n {2}credential {2}credential:\/[^ ]+ {2}\.\S+:\d+ {2}credential-like value present\n/);
  });

  it("the output-level safety net redacts a literal that reaches a note or a key", () => {
    const diff = cases.diff("hook-added");
    const literal = `sk-${"A".repeat(24)}`;
    const delta = diff.added[0] as Delta;
    const tampered: Diff = { ...diff, added: [{ ...delta, notes: [...delta.notes, `token ${literal}`], key: `${delta.key}-${literal}` }] };
    const text = renderDiffText(tampered);
    const json = renderDiffJson("check", tampered);
    assert.ok(!text.includes(literal) && text.includes("<redacted>"));
    assert.ok(!json.includes(literal) && json.includes("<redacted>"));
    assert.ok(count(text, "<redacted>") >= 2, "key and note both redacted in text");
  });
});

describe("JSON renderer (JG-157)", () => {
  function parse(text: string): Diff & { command: string } {
    return JSON.parse(text) as Diff & { command: string };
  }

  function assertSortedKeys(value: unknown, path = "$"): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertSortedKeys(item, `${path}[${index}]`));
    } else if (value !== null && typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>);
      assert.deepEqual(keys, [...keys].sort(), `keys sorted at ${path}`);
      for (const key of keys) {
        assertSortedKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
      }
    }
  }

  it("emits the full Diff plus both snapshots' assumptions, sources and incomplete, keys sorted, entries sorted by key", () => {
    const diff = cases.diff("incomplete-with-expansion");
    const text = renderDiffJson("check", diff);
    const parsed = parse(text);
    assert.deepEqual(Object.keys(parsed), ["added", "base", "changed", "command", "head", "incomplete", "removed", "schema_version", "semantics_doc_date", "summary", "unresolved"]);
    assertSortedKeys(parsed);
    for (const side of [parsed.base, parsed.head]) {
      assert.deepEqual(Object.keys(side), ["assumptions", "incomplete", "origin", "sha", "sources"]);
      assert.equal(side.assumptions.length >= 8, true);
      assert.equal(side.sources.length, 3);
    }
    assert.equal(parsed.head.incomplete.length, 1);
    assert.deepEqual(parsed.incomplete, parsed.head.incomplete);
    assert.equal(parsed.summary.exit_code, 3);
    const keys = [...parsed.added, ...parsed.removed, ...parsed.changed, ...parsed.unresolved].map((delta) => delta.key);
    for (const list of [parsed.added, parsed.removed, parsed.changed, parsed.unresolved]) {
      const listKeys = list.map((delta) => delta.key);
      assert.deepEqual(listKeys, [...listKeys].sort());
    }
    assert.ok(keys.length > 0);
    assert.equal(text.endsWith("\n"), true);
  });

  it("two runs on identical input are byte-identical (in-process and CLI, snapshot / diff / check)", () => {
    const repo = cases.repo("i7-mcp-http-remote");
    assert.equal(renderDiffJson("diff", cases.diff("i7-mcp-http-remote")), renderDiffJson("diff", cases.diff("i7-mcp-http-remote")));
    for (const args of [
      ["snapshot", repo.headSha, "--json"],
      ["diff", "--base", repo.baseSha, "--head", repo.headSha, "--json"],
      ["check", "--base", repo.baseSha, "--head", repo.headSha, "--json"],
    ]) {
      const first = runCli(args, repo.dir);
      const second = runCli(args, repo.dir);
      assert.equal(first.stdout, second.stdout, args.join(" "));
      assert.equal(first.stdout, inProcess(args, repo.dir).stdout, `${args.join(" ")} in-process equals CLI`);
      assert.ok(first.stdout.length > 200);
    }
  });

  it("negative case: --json with an incomplete scan is valid JSON with incomplete[] populated and exit 3", () => {
    const repo = cases.repo("incomplete-head");
    for (const command of ["diff", "check"]) {
      const cli = runCli([command, "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir);
      assert.equal(cli.status, EXIT_INCOMPLETE);
      const parsed = parse(cli.stdout);
      assert.equal(parsed.incomplete.length, 1);
      assert.match(parsed.incomplete[0]?.reason ?? "", /duplicate key/);
      assert.equal(parsed.summary.verdict, "incomplete");
      assert.equal(parsed.summary.exit_code, 3);
    }
    const dup = makeRepo("duplicate");
    repos.push(dup.dir);
    const snapshot = runCli(["snapshot", "HEAD", "--json"], dup.dir);
    assert.equal(snapshot.status, EXIT_INCOMPLETE);
    assert.equal((JSON.parse(snapshot.stdout) as { incomplete: unknown[] }).incomplete.length, 1);
  });

  it("redacts identically to the text renderer (same shared function)", () => {
    const repo = makeRepo("credential");
    repos.push(repo.dir);
    const text = runCli(["snapshot", "HEAD"], repo.dir).stdout;
    const json = runCli(["snapshot", "HEAD", "--json"], repo.dir).stdout;
    const literals = ["ghp_SYNTHETIC", "github_pat_SYNTHETIC", "xoxb-", "synthetic-literal-header-token"];
    for (const literal of literals) {
      assert.ok(!text.includes(literal) && !json.includes(literal), literal);
    }
    const credentialKeys = (JSON.parse(json) as { entries: Array<{ kind: string; key: string }> }).entries.filter((entry) => entry.kind === "credential").map((entry) => entry.key);
    assert.ok(credentialKeys.length >= 5);
    for (const key of credentialKeys) {
      assert.ok(text.includes(`  ${key}  `), `${key} is listed in text too`);
    }
  });
});
