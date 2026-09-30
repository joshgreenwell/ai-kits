import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validate } from '../contract/validate.mjs';

// The board's contract copies and fixtures are checked here with nothing but Node, so the kit's CI
// never needs the board checked out. contracts.yml is the job that keeps contract/ equal to the board's.
const kit = fileURLToPath(new URL('..', import.meta.url));
const read = path => JSON.parse(readFileSync(join(kit, path), 'utf8'));
const manifest = read('fixtures/MANIFEST.json');
const schema = id => read(`contract/${id}.schema.json`);
const fixtures = group => Object.entries(manifest[group]).map(([name, entry]) => ({ name, entry, body: read(`fixtures/${group}/${name}`) }));
const joined = path => path.join('.');

// What the board checks after the schema: JSON Schema cannot say "not in the future" or "a real date".
function boardOnlyIssues(body) {
  const issues = [];
  if (Date.parse(body.produced_at) > Date.now() + 300_000) issues.push('produced_at is in the future');
  const date = body.period_key.length === 7 ? body.period_key + '-01' : body.period_key;
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) issues.push('period_key is not a calendar date');
  return issues;
}

test('the manifest declares its fixtures and lists exactly the files present', () => {
  assert.deepEqual(manifest.declaration, { ...manifest.declaration, origin: 'synthetic', completeness: 'complete', excerpt_or_raw: 'raw' });
  assert.match(manifest.declaration.ref, /\S/);
  for (const group of ['valid', 'invalid']) {
    const present = readdirSync(join(kit, 'fixtures', group)).filter(name => name.endsWith('.json')).sort();
    assert.deepEqual(Object.keys(manifest[group]).sort(), present, `fixtures/${group} and the manifest agree`);
    for (const [name, entry] of Object.entries(manifest[group])) assert.ok(readdirSync(join(kit, 'contract')).includes(`${entry.contract}.schema.json`), `${name} names a contract in contract/`);
  }
});

test('valid fixtures pass the contract copy and the board-only checks', () => {
  for (const { name, entry, body } of fixtures('valid')) {
    const result = validate(body, schema(entry.contract));
    assert.deepEqual(result.issues, [], `${name} passes ${entry.contract}`);
    assert.deepEqual(boardOnlyIssues(body), [], `${name} passes the board-only checks`);
  }
});

test('each invalid fixture is refused where the manifest says, and by the part it names', () => {
  for (const { name, entry, body } of fixtures('invalid')) {
    const result = validate(body, schema(entry.contract));
    assert.equal(result.valid, false, `${name} is refused`);
    assert.deepEqual(result.issues.map(issue => joined(issue.path)), [entry.path], `${name} fails only at ${entry.path}`);
    // The envelope is enforced (400); a payload mismatch is recorded in observe mode and still stored.
    assert.equal(entry.path.split('.')[0] === 'payload' ? 'contract' : 'envelope', entry.refused_by, `${name} is refused by the ${entry.refused_by}`);
  }
});

test('the contract examples pass their own schemas', () => {
  for (const file of readdirSync(join(kit, 'contract')).filter(name => name.endsWith('.example.json'))) {
    const id = file.replace(/\.example\.json$/, '');
    assert.deepEqual(validate(read(`contract/${file}`), schema(id)).issues, [], `${id} example`);
  }
});

test('the validator command line exits 0 on a match and 1 on a mismatch', () => {
  const run = (id, file) => spawnSync(process.execPath, [join(kit, 'contract/validate.mjs'), join(kit, `contract/${id}.schema.json`), join(kit, file)], { encoding: 'utf8' });
  const [valid] = fixtures('valid');
  const [invalid] = fixtures('invalid');
  assert.equal(run(valid.entry.contract, `fixtures/valid/${valid.name}`).status, 0);
  const refused = run(invalid.entry.contract, `fixtures/invalid/${invalid.name}`);
  assert.equal(refused.status, 1);
  assert.deepEqual(JSON.parse(refused.stdout).issues.map(issue => joined(issue.path)), [invalid.entry.path]);
});

test('fixtures carry no credentials, real hosts, or real addresses', () => {
  const credential = /(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{16}|-----BEGIN|Bearer\s+\S{12,}|[A-Fa-f0-9]{32,})/;
  for (const group of ['valid', 'invalid']) for (const name of readdirSync(join(kit, 'fixtures', group))) {
    const text = readFileSync(join(kit, 'fixtures', group, name), 'utf8');
    assert.doesNotMatch(text, credential, `${name} has no credential shapes`);
    for (const [url] of text.matchAll(/https?:\/\/[^\s"'<>|)\]]+/g)) {
      assert.match(new URL(url).hostname, /(^|\.)example\.(com|org|net)$/, `${name} links only to example hosts: ${url}`);
    }
    for (const [address] of text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) assert.match(address, /@example\.(com|org|net)$/, `${name} uses example addresses: ${address}`);
  }
});
