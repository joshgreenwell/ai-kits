import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT_OK } from "../src/cli.js";
import { CATEGORY_META, DEFAULT_FAILING_CATEGORIES } from "../src/categories.js";
import { DIRECTION_RULES } from "../src/direction.js";
import { explainEntries, renderExplainDoc } from "../src/explain.js";
import { INTERPRETATIONS, NOT_INTERPRETED } from "../src/interpretations/index.js";
import { ASSUMPTION_LINES } from "../src/render/shared.js";
import { SEMANTICS_DOC_DATE } from "../src/types.js";
import { VERSION } from "../src/version.js";
import { runCli } from "./helpers.js";

const at = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string): string => fs.readFileSync(at(rel), "utf8");

describe("docs/explain.md generated from the explain registry (JG-160)", () => {
  it("matches the generator output and has one entry per interpretation, direction rule and category, citing the doc section", () => {
    const committed = read("docs/explain.md");
    assert.equal(committed, renderExplainDoc(), "run `npm run docs` to regenerate docs/explain.md");
    for (const { META } of INTERPRETATIONS) {
      assert.ok(committed.includes(`### \`${META.id}\` — ${META.title}`), META.id);
      assert.ok(committed.includes(`- doc section: ${META.doc_section}`), META.id);
    }
    for (const rule of DIRECTION_RULES) {
      assert.ok(committed.includes(`### \`${rule.id}\` — ${rule.title}`), rule.id);
    }
    for (const category of CATEGORY_META) {
      assert.ok(committed.includes(`### \`${category.id}\` — ${category.title}`), category.id);
    }
    for (const item of NOT_INTERPRETED) {
      assert.ok(committed.includes(`### \`${item.id}\``), item.id);
    }
    assert.match(committed, /### `D-hook-added` — hook added\n\n- direction: widens\n- tier: proven\n- cites: I6 \(Hooks reference > Configuration\)/);
    assert.equal(committed.split("\n### ").length - 1, explainEntries().length);
  });

  it("agent-surface explain <ID> works for every interpretation and category (and every other registered ID)", () => {
    for (const entry of explainEntries()) {
      const run = runCli(["explain", entry.id], process.cwd());
      assert.equal(run.status, EXIT_OK, entry.id);
      assert.ok(run.stdout.startsWith(`${entry.id}  ${entry.title}\n`), entry.id);
    }
  });
});

describe("README, SECURITY.md and CHANGELOG (JG-160)", () => {
  const readme = read("README.md");

  it("README states the thesis, the answers / does-not-answer pair and points at /permissions, /doctor, /status", () => {
    assert.match(readme, /expands the control surface/);
    assert.match(readme, /## What it answers/);
    assert.match(readme, /## What it does not answer/);
    for (const command of ["/permissions", "/doctor", "/status"]) {
      assert.ok(readme.includes(`\`${command}\``), command);
    }
  });

  it("README explains the assumptions header line by line", () => {
    for (const [label, value] of ASSUMPTION_LINES) {
      assert.ok(readme.includes(`\`${label}\``), label);
      assert.ok(readme.includes(value), value);
    }
    assert.match(readme, /## The assumptions header/);
  });

  it("README lists exit codes, default failing categories, the Actions step with fetch-depth 0, the dated closed list, Never and maintenance", () => {
    assert.match(readme, /\| 0 +\| no change/);
    assert.match(readme, /\| 3 +\| scan incomplete/);
    assert.match(readme, /\| 64 +\| usage error/);
    for (const category of DEFAULT_FAILING_CATEGORIES) {
      assert.ok(readme.includes(`\`${category}\``), category);
    }
    assert.match(readme, /npx agent-surface check --base origin\/main --head HEAD/);
    assert.match(readme, /fetch-depth: 0/);
    assert.ok(readme.includes(`semantics_doc_date: ${SEMANTICS_DOC_DATE}`));
    for (const { META } of INTERPRETATIONS) {
      assert.ok(readme.includes(`\`${META.id}\``), META.id);
    }
    assert.match(readme, /## Never/);
    for (const never of ["matcher reproduction", "WITHOUT ASKING", "attack-chain", "MCP tool-description scanning", "risk scores", "network", "environment-variable expansion"]) {
      assert.ok(readme.includes(never), never);
    }
    assert.match(readme, /## Maintenance/);
    assert.match(readme, /CHANGELOG/);
  });

  it("SECURITY.md describes disclosure, what the tool never does, and the scope of guarantees", () => {
    const security = read("SECURITY.md");
    assert.match(security, /## Reporting a vulnerability/);
    assert.match(security, /private vulnerability reporting/i);
    assert.match(security, /## What the tool never does/);
    for (const never of ["execute", "network", "expand"]) {
      assert.ok(new RegExp(never, "i").test(security), never);
    }
    assert.match(security, /## Scope of the guarantees/);
    assert.match(security, /test\/security\.test\.ts/);
  });

  it("CHANGELOG lists the current version with interpretations I1–I8 dated 2026-09-07", () => {
    const changelog = read("CHANGELOG.md");
    assert.ok(changelog.includes(`## ${VERSION}`), VERSION);
    const section = changelog.slice(changelog.indexOf(`## ${VERSION}`));
    assert.ok(section.includes(SEMANTICS_DOC_DATE));
    for (const { META } of INTERPRETATIONS) {
      assert.ok(section.includes(`\`${META.id}\``), META.id);
      assert.ok(section.includes(META.title), META.title);
    }
  });
});

describe("package.json finalized for publish (JG-160)", () => {
  interface Pkg {
    name: string;
    version: string;
    license: string;
    bin: Record<string, string>;
    files: string[];
    engines: { node: string };
    repository: { type: string; url: string; directory: string };
    publishConfig: { access: string };
    scripts: Record<string, string>;
    dependencies?: Record<string, string>;
  }
  const pkg = JSON.parse(read("package.json")) as Pkg;

  it("has name, version, license, bin, files, engines, repository, publishConfig and prepublishOnly", () => {
    assert.equal(pkg.name, "agent-surface");
    assert.equal(pkg.version, VERSION);
    assert.equal(pkg.license, "BSD-2-Clause");
    assert.deepEqual(pkg.bin, { "agent-surface": "./dist/src/cli.js" });
    assert.ok(pkg.files.includes("dist/") && pkg.files.includes("!dist/test/") && pkg.files.includes("LICENSE"));
    assert.equal(pkg.engines.node, ">=20");
    assert.deepEqual(pkg.repository, { type: "git", url: "https://github.com/joshgreenwell/ai-kits", directory: "agent-surface" });
    assert.deepEqual(pkg.publishConfig, { access: "public" });
    assert.equal(pkg.scripts["prepublishOnly"], "npm run build && npm test");
    assert.equal(pkg.dependencies, undefined, "zero runtime dependencies");
    assert.ok(fs.existsSync(at("LICENSE")));
    assert.match(read("LICENSE"), /BSD 2-Clause License/);
  });

  it("the CI workflow packs the tarball and publishes on agent-surface-v* tags with provenance", () => {
    const workflow = read("../.github/workflows/agent-surface.yml");
    assert.match(workflow, /^\s+pack:$/m);
    assert.match(workflow, /npm pack/);
    assert.match(workflow, /actions\/upload-artifact/);
    assert.match(workflow, /^\s+publish:$/m);
    assert.match(workflow, /agent-surface-v\*/);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /npm publish --provenance --access public/);
    assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  });
});
