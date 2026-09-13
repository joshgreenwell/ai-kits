// Writes lib/generated/usage-v2.schema.json from lib/usage-contract.ts.
// Run with `node --import tsx scripts/build-usage-schema.mjs` (npm run usage-schema).
// The companion vendors this file byte for byte; CI fails when either copy drifts.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { usageSchemaJson } from '../lib/usage-contract.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const text = JSON.stringify(usageSchemaJson, null, 2) + '\n';
await mkdir(resolve(root, 'lib/generated'), { recursive: true });
await writeFile(resolve(root, 'lib/generated/usage-v2.schema.json'), text);
console.log(`Wrote usage-v2 JSON Schema: ${text.length} bytes`);
