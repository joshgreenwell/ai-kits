#!/usr/bin/env node
// Regenerates fixtures/golden/<case>/expected*.{json,txt,exit} by running the
// compiled CLI over a temporary git repository built from base/ and head/
// (see test/golden-helpers.ts for the placeholder rule). Run `npm run build`
// first, then `node scripts/update-golden.mjs [case ...]`. Review the diff of
// every regenerated file: the expected output is the specification.

import { writeFileSync } from "node:fs";
import * as path from "node:path";

import { GoldenRepos, goldenCases, runGoldenCli } from "../dist/test/golden-helpers.js";

const only = new Set(process.argv.slice(2));
const repos = new GoldenRepos();
try {
  for (const goldenCase of goldenCases()) {
    if (only.size > 0 && !only.has(goldenCase.name)) {
      continue;
    }
    const repo = repos.repo(goldenCase);
    for (const variant of goldenCase.variants) {
      const result = runGoldenCli(repo, variant);
      writeFileSync(path.join(goldenCase.dir, variant.jsonFile), result.json);
      writeFileSync(path.join(goldenCase.dir, variant.textFile), result.text);
      writeFileSync(path.join(goldenCase.dir, variant.exitFile), `${result.exit}\n`);
      process.stdout.write(`${goldenCase.name} [${variant.name}] exit ${result.exit}\n`);
    }
  }
} finally {
  repos.cleanup();
}
