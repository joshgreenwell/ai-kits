import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";

import type { Diff } from "../src/types.js";
import { GOLDEN_FIXTURES, GoldenRepos, expectedOf, goldenCases, runGoldenCli, runGoldenInProcess, type GoldenCase } from "./golden-helpers.js";

const repos = new GoldenRepos();
after(() => repos.cleanup());

/** The cases JG-158 requires, by directory name, with the exit code each must produce by default. */
const REQUIRED: ReadonlyArray<[string, number]> = [
  ["add-hook", 1],
  ["add-mcp-stdio", 1],
  ["add-mcp-http-loopback", 1],
  ["add-mcp-http-remote", 1],
  ["add-mcp-var-url", 2],
  ["add-allow-whole-tool", 1],
  ["add-allow-scoped", 0],
  ["remove-deny", 1],
  ["add-deny", 0],
  ["mode-default-to-bypass", 1],
  ["mode-bypass-to-default", 0],
  ["mode-default-to-dontask", 1],
  ["mode-default-to-acceptedits", 0],
  ["reformat-only", 0],
  ["tracked-local-adds-allow", 1],
  ["duplicate-keys", 3],
  ["jsonc-comments", 0],
  ["wildcard-before-subcommand", 2],
  ["ignored-shapes", 0],
  ["enabled-plugins", 2],
];

/** Real-looking secret patterns; a match is tolerated only when its line says SYNTHETIC. */
export const SECRET_PATTERNS: ReadonlyArray<RegExp> = [/sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /-----BEGIN/, /xox[baprs]-/];

/** Lines of `text` that carry a real-looking secret not marked SYNTHETIC. */
export function unmarkedSecrets(text: string): string[] {
  return text.split("\n").filter((line) => SECRET_PATTERNS.some((pattern) => pattern.test(line)) && !line.includes("SYNTHETIC"));
}

function parse(text: string): Diff {
  return JSON.parse(text) as Diff;
}

function caseByName(name: string): GoldenCase {
  const found = goldenCases().find((item) => item.name === name);
  if (found === undefined) {
    throw new Error(`golden case ${name} is missing`);
  }
  return found;
}

describe("golden fixture suite (JG-158)", () => {
  const all = goldenCases();

  it("every required case exists, and the enumeration finds every directory (a new case cannot be forgotten)", () => {
    const names = all.map((item) => item.name);
    for (const [name] of REQUIRED) {
      assert.ok(names.includes(name), `required case ${name}`);
    }
    const onDisk = fs
      .readdirSync(GOLDEN_FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(names, onDisk);
    for (const item of all) {
      for (const variant of item.variants) {
        for (const file of [variant.jsonFile, variant.textFile, variant.exitFile]) {
          assert.ok(fs.existsSync(path.join(item.dir, file)), `${item.name}/${file} exists (run node scripts/update-golden.mjs)`);
        }
      }
      for (const side of ["base", "head"]) {
        assert.ok(fs.existsSync(path.join(item.dir, side)), `${item.name}/${side}`);
      }
    }
    const scoped = caseByName("add-allow-scoped");
    assert.deepEqual(
      scoped.variants.map((variant) => [variant.name, variant.args]),
      [
        ["default", []],
        ["fail-on-scoped-allow", ["--fail-on", "scoped-allow"]],
      ],
    );
  });

  for (const item of all) {
    for (const variant of item.variants) {
      it(`${item.name} [${variant.name}]: CLI and in-process output equal expected.json / expected.txt / expected.exit`, () => {
        const repo = repos.repo(item);
        const expected = expectedOf(item, variant);
        const required = REQUIRED.find(([name]) => name === item.name);
        if (required !== undefined && variant.name === "default") {
          assert.equal(expected.exit, required[1], `${item.name} exit code per JG-158`);
        }
        const cli = runGoldenCli(repo, variant);
        assert.equal(cli.exit, expected.exit, cli.stderr);
        assert.equal(cli.json, expected.json, `${item.name} [${variant.name}] --json`);
        assert.equal(cli.text, expected.text, `${item.name} [${variant.name}] text`);
        const inproc = runGoldenInProcess(repo, variant);
        assert.equal(inproc.exit, expected.exit);
        assert.equal(inproc.json, expected.json, `${item.name} [${variant.name}] --json in-process`);
        assert.equal(inproc.text, expected.text, `${item.name} [${variant.name}] text in-process`);
        assert.doesNotThrow(() => JSON.parse(cli.json));
      });
    }
  }

  it("determinism: the whole suite run twice is byte-identical", () => {
    for (const item of all) {
      const repo = repos.repo(item);
      for (const variant of item.variants) {
        const first = runGoldenCli(repo, variant);
        const second = runGoldenCli(repo, variant);
        assert.equal(first.json, second.json, `${item.name} [${variant.name}] json`);
        assert.equal(first.text, second.text, `${item.name} [${variant.name}] text`);
        assert.equal(first.exit, second.exit);
      }
    }
  });

  it("negative case: an expected.json carrying a real-looking secret fails the hygiene check", () => {
    for (const item of all) {
      for (const variant of item.variants) {
        const text = fs.readFileSync(path.join(item.dir, variant.jsonFile), "utf8");
        assert.deepEqual(unmarkedSecrets(text), [], `${item.name}/${variant.jsonFile}`);
        assert.deepEqual(unmarkedSecrets(fs.readFileSync(path.join(item.dir, variant.textFile), "utf8")), [], `${item.name}/${variant.textFile}`);
      }
    }
    // The checker itself must catch each pattern (literals are assembled at runtime so this file stays clean).
    const samples = [`sk-${"a".repeat(24)}`, `AKIA${"B".repeat(16)}`, `ghp_${"c".repeat(32)}`, "-----BEGIN RSA PRIVATE KEY-----", "xoxb-1234"];
    for (const sample of samples) {
      assert.equal(unmarkedSecrets(`"value": "${sample}"`).length, 1, sample);
      assert.equal(unmarkedSecrets(`"value": "${sample}" SYNTHETIC`).length, 0, `${sample} marked`);
    }
  });

  it("every base/ and head/ file is a headered synthetic fixture", () => {
    for (const item of all) {
      for (const side of ["base", "head"]) {
        const dir = path.join(item.dir, side);
        for (const file of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
          if (!file.isFile()) {
            continue;
          }
          const text = fs.readFileSync(path.join(file.parentPath, file.name), "utf8");
          assert.match(text, /origin: synthetic/, `${item.name}/${side}/${file.name}`);
          assert.match(text, /completeness: /, `${item.name}/${side}/${file.name}`);
          assert.deepEqual(unmarkedSecrets(text), [], `${item.name}/${side}/${file.name}`);
        }
      }
    }
  });
});

describe("golden cases carry the JG-158 findings, not only the exit codes", () => {
  function diffOf(name: string, variantName = "default"): Diff {
    const item = caseByName(name);
    const variant = item.variants.find((candidate) => candidate.name === variantName);
    assert.ok(variant !== undefined, variantName);
    return parse(runGoldenCli(repos.repo(item), variant).json);
  }

  it("MCP http loopback is not flagged plaintext; http remote is", () => {
    const loopback = diffOf("add-mcp-http-loopback");
    assert.equal(loopback.added.length, 3);
    assert.ok(loopback.added.every((delta) => !delta.flags.includes("plaintext")));
    const remote = diffOf("add-mcp-http-remote");
    assert.deepEqual(remote.added.map((delta) => delta.flags), [["plaintext"]]);
  });

  it("a ${VAR} URL is unresolved with variable_reference; the URL is never expanded", () => {
    const diff = diffOf("add-mcp-var-url");
    assert.equal(diff.unresolved.length, 1);
    assert.deepEqual(diff.unresolved[0]?.flags, ["variable_reference"]);
    assert.ok(JSON.stringify(diff).includes("${MCP_HOST}"));
  });

  it("scoped allow is annotate-only by default and fails with --fail-on scoped-allow", () => {
    const byDefault = diffOf("add-allow-scoped");
    assert.equal(byDefault.summary.expands, false);
    assert.equal(byDefault.summary.exit_code, 0);
    assert.deepEqual(byDefault.summary.categories, ["scoped-allow"]);
    const strict = diffOf("add-allow-scoped", "fail-on-scoped-allow");
    assert.equal(strict.summary.expands, true);
    assert.equal(strict.summary.exit_code, 1);
    assert.deepEqual(strict.summary.fail_on, { categories: ["scoped-allow"], projected: false });
  });

  it("add deny is NARROWED (exit 0); remove deny is a proven expansion (exit 1)", () => {
    const added = diffOf("add-deny");
    assert.deepEqual(added.added.map((delta) => delta.direction), ["narrows"]);
    const item = caseByName("add-deny");
    assert.ok(runGoldenCli(repos.repo(item), item.variants[0] as NonNullable<typeof item.variants[0]>).text.includes("\nNARROWED\n"));
    const removed = diffOf("remove-deny");
    assert.equal(removed.summary.expands, true);
    assert.deepEqual(removed.summary.categories, ["deny-removed"]);
  });

  it("mode changes: bypassPermissions and dontAsk widen, acceptEdits is neutral (annotate), narrowing exits 0", () => {
    assert.deepEqual(diffOf("mode-default-to-bypass").changed.map((delta) => [delta.direction, delta.category]), [["widens", "mode"]]);
    assert.deepEqual(diffOf("mode-default-to-dontask").changed.map((delta) => [delta.direction, delta.category]), [["widens", "mode"]]);
    assert.deepEqual(diffOf("mode-default-to-acceptedits").changed.map((delta) => [delta.direction, delta.tier]), [["neutral", "proven"]]);
    assert.deepEqual(diffOf("mode-bypass-to-default").changed.map((delta) => delta.direction), ["narrows"]);
  });

  it("reformat-only and comment-only changes are empty diffs", () => {
    for (const name of ["reformat-only", "jsonc-comments"]) {
      const diff = diffOf(name);
      assert.deepEqual([diff.added, diff.removed, diff.changed, diff.unresolved, diff.incomplete], [[], [], [], [], []], name);
      assert.equal(diff.summary.verdict, "no-change");
    }
  });

  it("a tracked settings.local.json is flagged as tracked local, in the assumptions and on the delta", () => {
    const diff = diffOf("tracked-local-adds-allow");
    assert.ok(diff.head.assumptions.some((line) => line.startsWith("local file shared via Git (trust-held by Claude Code)")));
    assert.deepEqual(diff.added.map((delta) => delta.flags), [["tracked_local"]]);
    assert.equal(diff.added[0]?.head?.file, ".claude/settings.local.json");
  });

  it("duplicate keys are incomplete (exit 3); ignored shapes are flagged and exit 0; wildcard-before-subcommand is projected (exit 2)", () => {
    const dup = diffOf("duplicate-keys");
    assert.equal(dup.summary.verdict, "incomplete");
    assert.match(dup.incomplete[0]?.reason ?? "", /duplicate key "mcpServers"/);
    const ignored = diffOf("ignored-shapes");
    assert.ok(ignored.added.length >= 6 && ignored.added.every((delta) => delta.flags.includes("ignored_by_claude_code")));
    assert.equal(ignored.summary.exit_code, 0);
    const glob = diffOf("wildcard-before-subcommand");
    assert.deepEqual(glob.unresolved.map((delta) => [delta.breadth, delta.breadth_tier]), [["glob", "projected"]]);
    assert.equal(glob.summary.exit_code, 2);
  });

  it("enabledPlugins present is flagged in the assumptions and unresolved (exit 2)", () => {
    const diff = diffOf("enabled-plugins");
    assert.ok(diff.head.assumptions.some((line) => line.startsWith("plugins: enabledPlugins is non-empty")));
    assert.ok(!diff.base.assumptions.some((line) => line.startsWith("plugins: enabledPlugins")));
    assert.equal(diff.unresolved.length, 1);
    assert.equal(diff.summary.exit_code, 2);
  });
});
