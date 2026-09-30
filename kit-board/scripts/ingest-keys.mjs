// INGEST_KEYS_JSON from the producer keys on this machine, for a host whose secret cannot be read back.
//
//   node scripts/ingest-keys.mjs build | pbcopy     every local producer as { name: { hash, kinds } }; hashes only
//   pbpaste | node scripts/ingest-keys.mjs check    names and kinds of a value (never a hash), and which match
//                                                  this machine's keys
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const config = JSON.parse(readFileSync(process.env.PERSONAL_HUB_CONFIG ?? `${homedir()}/.config/personal-hub/publish.json`, 'utf8'));
const local = Object.fromEntries(Object.entries(config.producers ?? {})
  .filter(([, producer]) => producer?.key && Array.isArray(producer.kinds))
  .map(([name, producer]) => [name, { hash: createHash('sha256').update(producer.key).digest('hex'), kinds: producer.kinds }]));

const command = process.argv[2];
if (command === 'build') {
  process.stdout.write(JSON.stringify(local));
  console.error(`${Object.keys(local).length} producers from this machine: ${Object.keys(local).join(', ')}. Add any producer that lives only on another machine.`);
} else if (command === 'check') {
  const raw = readFileSync(0, 'utf8').trim();
  let value;
  try { value = JSON.parse(raw); } catch (error) { console.log(`Not valid JSON: ${error.message}`); process.exit(1); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    console.log(`It parses to ${Array.isArray(value) ? 'an array' : `a ${typeof value}`}; it must be one JSON object.${typeof value === 'string' ? ' It is probably wrapped in quotes.' : ''}`);
    process.exit(1);
  }
  for (const [name, entry] of Object.entries(value)) {
    const mine = local[name];
    const state = !mine ? 'not a producer on this machine' : entry?.hash === mine.hash ? 'matches this machine\'s key' : 'DOES NOT MATCH this machine\'s key';
    console.log(`${name}: kinds ${JSON.stringify(entry?.kinds)}, ${state}`);
  }
  const missing = Object.keys(local).filter(name => !(name in value));
  console.log(missing.length ? `\nMISSING from the value: ${missing.join(', ')}` : '\nEvery producer on this machine is present.');
  process.exitCode = missing.length || Object.entries(value).some(([name, entry]) => local[name] && entry?.hash !== local[name].hash) ? 1 : 0;
} else {
  console.error('Usage: node scripts/ingest-keys.mjs build | check');
  process.exit(2);
}
