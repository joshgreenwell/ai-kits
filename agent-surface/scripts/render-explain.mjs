#!/usr/bin/env node
// Regenerates docs/explain.md from the explain registry (interpretations,
// not-interpreted items, direction rules, categories, flags). Run
// `npm run docs` (builds first). A test fails when the committed file is stale.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderExplainDoc } from "../dist/src/explain.js";

const target = fileURLToPath(new URL("../docs/explain.md", import.meta.url));
writeFileSync(target, renderExplainDoc());
process.stdout.write(`wrote ${target}\n`);
