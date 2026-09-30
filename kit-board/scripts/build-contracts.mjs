// Writes lib/generated/contracts/ from lib/report-contracts.ts: one JSON Schema and one example per
// contract, and validate.mjs copied from lib/contract-validator.mjs. Run with `npm run contracts`.
// Kits keep byte-identical copies of these files; .github/workflows/contracts.yml fails when one drifts.
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { validate } from '../lib/contract-validator.mjs';
import { reportContractRegistry } from '../lib/report-contracts.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(root, 'lib/generated/contracts');
await mkdir(directory, { recursive: true });
const written = new Set(['validate.mjs']);
const json = value => JSON.stringify(value, null, 2) + '\n';
for (const contract of Object.values(reportContractRegistry)) {
  const { $schema, ...generated } = z.toJSONSchema(contract.schema, { io: 'input' });
  const schema = { $schema, $id: `https://github.com/joshgreenwell/ai-kits/blob/main/kit-board/lib/generated/contracts/${contract.id}.schema.json`, title: contract.title, description: contract.summary, ...generated };
  const check = validate(contract.example, schema);
  if (!check.valid) throw new Error(`${contract.id}: its example does not match its own schema: ${JSON.stringify(check.issues)}`);
  await writeFile(resolve(directory, `${contract.id}.schema.json`), json(schema));
  await writeFile(resolve(directory, `${contract.id}.example.json`), json(contract.example));
  written.add(`${contract.id}.schema.json`).add(`${contract.id}.example.json`);
}
await copyFile(resolve(root, 'lib/contract-validator.mjs'), resolve(directory, 'validate.mjs'));
for (const name of await readdir(directory)) if (!written.has(name)) await rm(resolve(directory, name));
console.log(`Wrote ${written.size} contract files to lib/generated/contracts`);
