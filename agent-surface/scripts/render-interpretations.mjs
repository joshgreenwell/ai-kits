#!/usr/bin/env node
// Regenerates docs/interpretations.md from the interpretation, direction-rule
// and category metadata. Run `npm run docs` (builds first). A test fails when
// the committed file is stale.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderInterpretationsDoc } from "../dist/src/explain.js";

const target = fileURLToPath(new URL("../docs/interpretations.md", import.meta.url));
writeFileSync(target, renderInterpretationsDoc());
process.stdout.write(`wrote ${target}\n`);
