import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { EXIT_ANNOTATE, EXIT_EXPANDS, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE } from "../src/cli.js";
import { DIRECTION_RULES } from "../src/direction.js";
import { explainIds, renderInterpretationsDoc } from "../src/explain.js";
import { INTERPRETATIONS, NOT_INTERPRETED } from "../src/interpretations/index.js";
import type { Diff } from "../src/types.js";
import { DiffCases, diffCases, type DiffRepo } from "./diff-helpers.js";
import { runCli } from "./helpers.js";

const cases = new DiffCases();
after(() => cases.cleanup());

const DOC_PATH = fileURLToPath(new URL("../../docs/interpretations.md", import.meta.url));
const README_PATH = fileURLToPath(new URL("../../README.md", import.meta.url));

function check(repo: DiffRepo, ...extra: string[]): ReturnType<typeof runCli> {
  return runCli(["check", "--base", repo.baseSha, "--head", repo.headSha, ...extra], repo.dir);
}

function parseDiff(text: string): Diff & { command: string } {
  return JSON.parse(text) as Diff & { command: string };
}

describe("CLI check: real pipeline exit codes (JG-155)", () => {
  it("a proven expansion in a failing category exits 1 and prints one line per delta", () => {
    const repo = cases.repo("hook-added");
    const run = check(repo);
    assert.equal(run.status, EXIT_EXPANDS, run.stderr);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, new RegExp(`^CONTROL-SURFACE DIFF {2}base=${repo.baseSha} head=${repo.headSha}\n`));
    assert.match(run.stdout, /\nEXPANDED\n {2}hooks\n {4}added {3}hook {8}hook:PreToolUse:Bash:[0-9a-f]{64} {2}widens proven {2}\.claude\/settings\.json:\d+\n/);
    assert.match(run.stdout, /\nverdict: expands \(exit 1\); expands=true; categories=hook\n/);
    assert.ok(!/no changes/i.test(run.stdout));
  });

  it("narrowing only exits 0; an annotate-only scoped allow exits 0 and 1 with --fail-on scoped-allow", () => {
    assert.equal(check(cases.repo("deny-added")).status, EXIT_OK);
    const scoped = cases.repo("allow-added");
    assert.equal(check(scoped).status, EXIT_OK);
    assert.equal(check(scoped, "--fail-on", "scoped-allow").status, EXIT_EXPANDS);
    assert.equal(check(cases.repo("hook-added"), "--fail-on", "scoped-allow").status, EXIT_OK, "--fail-on replaces the default set");
  });

  it("projected-only exits 2, 1 with --strict, 1 with --fail-on projected; unresolved-only exits 2 / 1 / 2", () => {
    const glob = cases.repo("i4-wildcard-before-subcommand");
    assert.equal(check(glob).status, EXIT_ANNOTATE);
    assert.equal(check(glob, "--strict").status, EXIT_EXPANDS);
    assert.equal(check(glob, "--fail-on", "projected").status, EXIT_EXPANDS);
    const unknown = cases.repo("unknown-shape");
    assert.equal(check(unknown).status, EXIT_ANNOTATE);
    assert.equal(check(unknown, "--strict").status, EXIT_EXPANDS);
    assert.equal(check(unknown, "--fail-on", "projected").status, EXIT_ANNOTATE);
    assert.match(check(unknown).stdout, /\nUNRESOLVED\n {2}other\n {4}changed unknown {5}unknown:\/model {2}unknown unresolved {2}/);
  });

  it("incomplete exits 3 and never prints 'no changes'; an expansion alongside is printed too", () => {
    const repo = cases.repo("incomplete-head");
    const run = check(repo);
    assert.equal(run.status, EXIT_INCOMPLETE);
    assert.match(run.stderr, /^incomplete: \.mcp\.json: duplicate key "mcpServers" at \/mcpServers \(lines \d+, \d+\)\n$/);
    assert.match(run.stdout, /\nINCOMPLETE\n {2}\.mcp\.json: duplicate key "mcpServers"/);
    assert.ok(!/no changes/i.test(run.stdout), run.stdout);
    assert.match(run.stdout, /not a clean result/);
    const both = check(cases.repo("incomplete-with-expansion"));
    assert.equal(both.status, EXIT_INCOMPLETE);
    assert.match(both.stdout, /\nINCOMPLETE\n[\s\S]*\nEXPANDED\n {2}hooks\n {4}added {3}hook {8}hook:PreToolUse:Bash:/);
    assert.match(both.stdout, /\nverdict: incomplete \(exit 3\); expands=true; categories=hook\n/);
    assert.match(both.stdout, /\n {2}- incomplete: \.mcp\.json: duplicate key "mcpServers"/);
    assert.match(both.stdout, /\n {2}- expands \(hook\): hook:PreToolUse:Bash:/);
    for (const strict of [[], ["--strict"], ["--fail-on", "projected"]]) {
      assert.equal(check(cases.repo("incomplete-with-expansion"), ...strict).status, EXIT_INCOMPLETE);
    }
  });

  it("reformat-only → empty diff, 'no changes', exit 0 (diff and check)", () => {
    const repo = cases.repo("reformat-only");
    for (const command of ["diff", "check"]) {
      const run = runCli([command, "--base", repo.baseSha, "--head", repo.headSha], repo.dir);
      assert.equal(run.status, EXIT_OK, run.stderr);
      assert.match(run.stdout, /\nno changes\n/);
      const json = runCli([command, "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir);
      const diff = parseDiff(json.stdout);
      assert.deepEqual([diff.added, diff.removed, diff.changed, diff.unresolved, diff.incomplete], [[], [], [], [], []]);
      assert.equal(diff.summary.verdict, "no-change");
      assert.equal(diff.command, command);
    }
  });

  it("an unknown --fail-on category is a usage error (64) before anything is read", () => {
    const repo = cases.repo("hook-added");
    const run = check(repo, "--fail-on", "hook,bogus");
    assert.equal(run.status, EXIT_USAGE);
    assert.match(run.stderr, /unknown --fail-on category bogus; valid: hook, mcp, mode, whole-tool-allow, directory, hooks-reenabled, deny-removed, scoped-allow, projected/);
  });
});

describe("CLI check/diff --json: full Diff, byte-deterministic (JG-157 groundwork)", () => {
  it("emits the full Diff with both sides' sha, sources, assumptions and incomplete, keys sorted", () => {
    const repo = cases.repo("i7-mcp-http-remote");
    const run = runCli(["check", "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir);
    assert.equal(run.status, EXIT_EXPANDS, run.stderr);
    const diff = parseDiff(run.stdout);
    assert.deepEqual(Object.keys(diff), [...Object.keys(diff)].sort());
    assert.deepEqual(Object.keys(diff).sort(), ["added", "base", "changed", "command", "head", "incomplete", "removed", "schema_version", "semantics_doc_date", "summary", "unresolved"]);
    assert.equal(diff.schema_version, 1);
    assert.equal(diff.semantics_doc_date, "2026-09-07");
    assert.equal(diff.base.sha, repo.baseSha);
    assert.equal(diff.head.sha, repo.headSha);
    assert.ok(Array.isArray(diff.base.sources) && diff.base.sources.length === 3);
    assert.ok(diff.head.assumptions.some((line) => line.startsWith("semantics: ")));
    assert.deepEqual(diff.incomplete, []);
    assert.equal(diff.added.length, 1);
    assert.deepEqual(diff.added[0]?.flags, ["plaintext"]);
    assert.equal(diff.summary.exit_code, 1);
  });

  it("two runs on identical input are byte-identical, for diff and check, text and JSON", () => {
    const repo = cases.repo("i8-ignored-shapes");
    for (const command of ["diff", "check"]) {
      for (const extra of [[], ["--json"]]) {
        const first = runCli([command, "--base", repo.baseSha, "--head", repo.headSha, ...extra], repo.dir);
        const second = runCli([command, "--base", repo.baseSha, "--head", repo.headSha, ...extra], repo.dir);
        assert.equal(first.status, second.status);
        assert.equal(first.stdout, second.stdout, `${command} ${extra.join(" ")}`);
        assert.ok(first.stdout.length > 100);
      }
    }
  });

  it("--json with an incomplete scan still emits valid JSON with incomplete[] populated and exit 3", () => {
    const repo = cases.repo("incomplete-with-expansion");
    const run = runCli(["check", "--base", repo.baseSha, "--head", repo.headSha, "--json"], repo.dir);
    assert.equal(run.status, EXIT_INCOMPLETE);
    const diff = parseDiff(run.stdout);
    assert.equal(diff.incomplete.length, 1);
    assert.equal(diff.summary.exit_code, 3);
    assert.equal(diff.summary.expands, true);
  });

  it("the diff command exits with the same verdict code as check and honours the same options", () => {
    const repo = cases.repo("i3-exact-and-prefix");
    assert.equal(runCli(["diff", "--base", repo.baseSha, "--head", repo.headSha], repo.dir).status, EXIT_OK);
    assert.equal(runCli(["diff", "--base", repo.baseSha, "--head", repo.headSha, "--fail-on", "projected"], repo.dir).status, EXIT_EXPANDS);
    const text = runCli(["diff", "--base", repo.baseSha, "--head", repo.headSha], repo.dir).stdout;
    assert.match(text, /\n {4}added {3}perm {8}perm:allow:Bash\(npm run \*\) {2}widens proven prefix {2}\.claude\/settings\.json:\d+\n/);
    assert.match(text, /\n {4}added {3}perm {8}perm:allow:Bash\(npm run build\) {2}widens proven exact {2}\.claude\/settings\.json:\d+\n/);
  });
});

describe("CLI explain (JG-154 / JG-160)", () => {
  it("explains I1..I8 with the doc section and the 2026-09-07 date", () => {
    for (const { META } of INTERPRETATIONS) {
      const run = runCli(["explain", META.id], process.cwd());
      assert.equal(run.status, EXIT_OK, `${META.id}: ${run.stderr}`);
      assert.match(run.stdout, new RegExp(`^${META.id} {2}${META.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`));
      assert.ok(run.stdout.includes(`doc section: ${META.doc_section}`), META.id);
      assert.ok(run.stdout.includes("semantics doc date: 2026-09-07"), META.id);
      assert.ok(run.stdout.includes(META.explain), META.id);
    }
  });

  it("explains every direction rule, not-interpreted item, category and flag", () => {
    const ids = explainIds();
    for (const rule of DIRECTION_RULES) {
      assert.ok(ids.includes(rule.id), rule.id);
    }
    for (const item of NOT_INTERPRETED) {
      assert.ok(ids.includes(item.id), item.id);
    }
    for (const id of ["D-allow-added", "D-mode-widened", "N-compound-command", "hook", "scoped-allow", "projected", "plaintext"]) {
      const run = runCli(["explain", id], process.cwd());
      assert.equal(run.status, EXIT_OK, id);
      assert.match(run.stdout, new RegExp(`^${id} {2}`));
    }
    assert.match(runCli(["explain", "D-allow-added"], process.cwd()).stdout, /direction: widens/);
    assert.equal(new Set(ids).size, ids.length, "IDs are unique");
  });

  it("an unknown ID exits 64 and lists the valid IDs", () => {
    const run = runCli(["explain", "I9"], process.cwd());
    assert.equal(run.status, EXIT_USAGE);
    assert.match(run.stderr, /^explain: unknown ID 'I9'\nvalid IDs: I1, I2, I3, I4, I5, I6, I7, I8, N-compound-command, .*D-allow-added.*, hook, .*projected, .*tracked_local\n$/s);
    assert.equal(run.stdout, "");
  });
});

describe("docs generated from metadata (JG-154 / JG-160)", () => {
  it("docs/interpretations.md matches the generator output", () => {
    const committed = fs.readFileSync(DOC_PATH, "utf8");
    assert.equal(committed, renderInterpretationsDoc(), "run `npm run docs` to regenerate docs/interpretations.md");
    assert.match(committed, /^<!-- Generated by scripts\/render-interpretations\.mjs/);
    assert.match(committed, /dated \*\*2026-09-07\*\*/);
    for (const { META } of INTERPRETATIONS) {
      assert.ok(committed.includes(`### ${META.id} — ${META.title}`), META.id);
      assert.ok(committed.includes(META.doc_section), META.id);
    }
  });

  it("README lists exit codes, default failing categories and the dated closed interpretation list", () => {
    const readme = fs.readFileSync(README_PATH, "utf8");
    assert.match(readme, /2026-09-07/);
    for (const category of ["hook", "mcp", "mode", "whole-tool-allow", "directory", "hooks-reenabled", "deny-removed", "scoped-allow"]) {
      assert.ok(readme.includes(`\`${category}\``), category);
    }
    for (const { META } of INTERPRETATIONS) {
      assert.ok(readme.includes(META.id), META.id);
    }
    assert.match(readme, /\| 3 +\| scan incomplete/);
    assert.match(readme, /--fail-on/);
    assert.match(readme, /--strict/);
  });

  it("every fixture case under fixtures/diff is headered synthetic and has base/ and head/", () => {
    const names = diffCases();
    assert.ok(names.length >= 50, `${names.length} cases`);
    for (const name of names) {
      for (const side of ["base", "head"]) {
        const dir = `${fileURLToPath(new URL("../../fixtures/diff/", import.meta.url))}${name}/${side}`;
        assert.ok(fs.existsSync(dir), `${name}/${side}`);
        for (const file of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
          if (!file.isFile()) {
            continue;
          }
          const text = fs.readFileSync(`${file.parentPath}/${file.name}`, "utf8");
          assert.match(text, /origin: synthetic/, `${name}/${side}/${file.name}`);
          assert.match(text, /completeness: /, `${name}/${side}/${file.name}`);
          assert.ok(!/AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{16,}|ghp_/.test(text), `${name}/${side}/${file.name} carries a credential-like literal`);
        }
      }
    }
  });
});

describe("CLI check against a temp repository built from the fixtures (manual check reproduced)", () => {
  let repo: DiffRepo;
  before(() => {
    repo = cases.repo("mode-widened");
  });

  it("node dist/src/cli.js check --base <sha> --head <sha>", () => {
    const run = check(repo);
    assert.equal(run.status, EXIT_EXPANDS);
    assert.match(run.stdout, /\nEXPANDED\n {2}mode\n {4}changed mode {8}mode:defaultMode {2}widens proven {2}\.claude\/settings\.json:\d+\n/);
    assert.match(run.stdout, /defaultMode default → bypassPermissions/);
    assert.match(run.stdout, /I5: defaultMode "bypassPermissions" is a widening mode/);
  });
});
