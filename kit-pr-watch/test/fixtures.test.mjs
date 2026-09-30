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

test('the manifest declares its fixtures and lists exactly the files present', () => {
  assert.deepEqual(manifest.declaration, { ...manifest.declaration, origin: 'synthetic', completeness: 'complete', excerpt_or_raw: 'raw' });
  assert.match(manifest.declaration.ref, /\S/);
  for (const group of ['valid', 'invalid']) {
    const present = readdirSync(join(kit, 'fixtures', group)).filter(name => name.endsWith('.json')).sort();
    assert.deepEqual(Object.keys(manifest[group]).sort(), present, `fixtures/${group} and the manifest agree`);
    for (const [name, entry] of Object.entries(manifest[group])) {
      assert.ok(readdirSync(join(kit, 'contract')).includes(`${entry.contract}.schema.json`), `${name} names a contract in contract/`);
      assert.equal(entry.contract, name.startsWith('work-') ? 'pr-watch-work-v1' : 'pr-watch-report-v1', `${name} is named for its contract`);
    }
  }
});

test('valid fixtures pass the contract copy', () => {
  for (const { name, entry, body } of fixtures('valid')) assert.deepEqual(validate(body, schema(entry.contract)).issues, [], `${name} passes ${entry.contract}`);
});

test('each invalid fixture is refused where the manifest says, and nowhere else', () => {
  for (const { name, entry, body } of fixtures('invalid')) {
    const result = validate(body, schema(entry.contract));
    assert.equal(result.valid, false, `${name} is refused`);
    assert.deepEqual(result.issues.map(issue => joined(issue.path)), [entry.path], `${name} fails only at ${entry.path}`);
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

test('fixtures carry no credentials, real pull requests, or real commits', () => {
  const credential = /(sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{16}|-----BEGIN|Bearer\s+\S{12,})/;
  for (const group of ['valid', 'invalid']) for (const name of readdirSync(join(kit, 'fixtures', group))) {
    const text = readFileSync(join(kit, 'fixtures', group, name), 'utf8');
    assert.doesNotMatch(text, credential, `${name} has no credential shapes`);
    // A watch id counts up from zero, and a commit or a fingerprint is one digit repeated, so none can name a real object.
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
    for (const [id] of text.matchAll(uuid)) assert.match(id, /^00000000-0000-4000-8000-0{9}[0-9]{3}$/, `${name} uses a synthetic watch id: ${id}`);
    for (const [run] of text.replace(uuid, '').matchAll(/[0-9a-f]{7,}/g)) assert.equal(new Set(run).size, 1, `${name} uses a synthetic hash: ${run}`);
    for (const [url] of text.matchAll(/https?:\/\/[^\s"'<>|)\]]+/g)) {
      const { hostname, pathname } = new URL(url);
      assert.ok(hostname === 'github.com' ? pathname.startsWith('/example-owner/example-app/') : /(^|\.)example\.(com|org|net)$/.test(hostname), `${name} links only to the example repository or example hosts: ${url}`);
    }
    for (const [address] of text.matchAll(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)) assert.match(address, /@example\.(com|org|net)$/, `${name} uses example addresses: ${address}`);
  }
});
