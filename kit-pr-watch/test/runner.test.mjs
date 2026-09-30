import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { workSchema } from './contract.mjs';

// The runner's command line, run in a scratch config folder so nothing touches this Mac's own setup,
// and a check that it reads only fields the work list promises.
const runner = fileURLToPath(new URL('../pr-watch.mjs', import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), 'pr-watch-'));
const cli = (args, home = scratch()) => spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, PERSONAL_HUB_CONFIG: '' } });

test('an unknown command exits 2 and lists the commands', () => {
  const result = cli(['unknown-command']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Commands: tick, check, keygen, install, uninstall, status/);
});

test('check refuses anything but a github.com pull request link, without reading a config', () => {
  const directory = scratch();
  const result = cli(['check', 'https://example.com/example-owner/example-app/pull/12', '--config', join(directory, 'publish.json')]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage: node pr-watch\.mjs check https:\/\/github\.com\/owner\/repo\/pull\/123/);
});

test('keygen saves the key privately and prints only its hash', () => {
  const directory = scratch();
  const config = join(directory, 'publish.json');
  writeFileSync(config, JSON.stringify({ url: 'https://board.example.com' }));
  const made = cli(['keygen', '--config', config]);
  assert.equal(made.status, 0, made.stderr);
  const saved = JSON.parse(readFileSync(config, 'utf8'));
  const { key, kinds } = saved.producers['pr-watch'];
  assert.deepEqual(kinds, ['pr-watch']);
  assert.equal(saved.url, 'https://board.example.com', 'the rest of the config is kept');
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.ok(!made.stdout.includes(key), 'the key is never printed');
  assert.match(made.stdout, new RegExp(`"hash":"${createHash('sha256').update(key).digest('hex')}"`));
  const again = cli(['keygen', '--config', config]);
  assert.equal(again.status, 1, 'an existing key is replaced only with --rotate');
  assert.equal(JSON.parse(readFileSync(config, 'utf8')).producers['pr-watch'].key, key);
});

test('every field the runner reads from a watch is one the work list promises', () => {
  const promised = Object.keys(workSchema.properties.watches.items.properties);
  const source = ['pr-watch.mjs', 'pr-watch-core.mjs'].map(file => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')).join('\n');
  // `watch.<field>` reads, leaving out file names such as pr-watch.json.
  const read = new Set([...source.matchAll(/\bwatch\.([a-z_]+)/g)].map(([, field]) => field).filter(field => !['mjs', 'json', 'lock', 'log', 'md'].includes(field)));
  assert.ok(read.size > 10, 'the scan finds the runner\'s reads');
  for (const field of read) assert.ok(promised.includes(field), `the runner reads watch.${field}, which pr-watch-work-v1 does not name`);
});
