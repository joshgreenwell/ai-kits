import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { companionCapabilitiesSchema } from '../lib/companion-capabilities';
import { optionSupport, settingsMatrix } from '../lib/companion-settings';

const corpus = join(import.meta.dirname, 'fixtures', 'usage-v2', 'capabilities');
const files = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.json')).sort();

test('every valid capability document parses strictly', () => {
  const names = files(join(corpus, 'valid'));
  assert.ok(names.length >= 2);
  for (const name of names) {
    const document = companionCapabilitiesSchema.parse(JSON.parse(readFileSync(join(corpus, 'valid', name), 'utf8')));
    assert.equal(document.schema_version, 1, name);
    assert.ok(document.adapters.every(row => row.modes.length <= 8), `${name}: bounded mode lists`);
  }
});

test('every invalid capability document is rejected with its labeled reason', () => {
  const names = files(join(corpus, 'invalid'));
  assert.ok(names.length >= 4);
  for (const name of names) {
    const wrapper = JSON.parse(readFileSync(join(corpus, 'invalid', name), 'utf8')) as { reason: string; document: unknown };
    assert.ok(wrapper.reason, `${name}: labeled`);
    assert.equal(companionCapabilitiesSchema.safeParse(wrapper.document).success, false, `${name} (${wrapper.reason}) was accepted`);
  }
});

test('deny entries are closed mode paths, never paths or free text', () => {
  const valid = companionCapabilitiesSchema.parse(JSON.parse(readFileSync(join(corpus, 'valid', 'default-build.json'), 'utf8')));
  for (const entry of ['C:\\Users\\x', '/home/x/vault', 'allowance.claude_reader.oauth_usage.extra', 'Providers.Claude', '']) {
    assert.equal(companionCapabilitiesSchema.safeParse({ ...valid, deny: [entry] }).success, false, entry);
  }
  for (const entry of ['claude_execution', 'providers.cursor', 'execution.resource_attribution', 'allowance.codex_reader.app_server']) {
    assert.equal(companionCapabilitiesSchema.safeParse({ ...valid, deny: [entry] }).success, true, entry);
  }
});

test('option support reads each companion build’s own report and never blocks a value', () => {
  const document = companionCapabilitiesSchema.parse(JSON.parse(readFileSync(join(corpus, 'valid', 'default-build.json'), 'utf8')));
  const row = (path: string) => settingsMatrix.flatMap(group => group.rows).find(r => r.path === path)!;
  const reports = [{ machine_label: 'pc', current: true, document }, { machine_label: 'stale', current: false, document }];
  assert.equal(optionSupport(row('execution.detail_level'), 'buckets_only', []).state, 'always');
  assert.equal(optionSupport(row('execution.detail_level'), 'requests', []).state, 'unverified');
  assert.deepEqual(optionSupport(row('execution.detail_level'), 'requests', reports), { state: 'supported', supported: 1, reporting: 1, label: 'supported by 1 of 1 reporting' });
  assert.equal(optionSupport(row('allowance.claude_reader'), 'oauth_usage', reports).state, 'supported', 'oauth_usage is an implemented claude_account mode');
  assert.equal(optionSupport(row('allowance.codex_reader'), 'embedded', reports).state, 'supported', 'embedded rides on the codex execution adapter');
  assert.equal(optionSupport(row('allowance.codex_reader'), 'web_backend', reports).state, 'unsupported', 'web_backend stays unimplemented');
  assert.equal(optionSupport(row('execution.claude_local_logs'), false, []).state, 'always', 'switching something off needs nothing');
  assert.equal(optionSupport(row('providers.cursor'), true, reports).state, 'supported');
  assert.equal(optionSupport(row('hooks.claude_statusline'), true, reports).state, 'supported');
  assert.equal(optionSupport(row('allowance.claude_oauth_keepalive'), true, reports).state, 'supported');
  assert.equal(optionSupport(row('live_mode'), true, reports).state, 'unsupported');
  assert.equal(optionSupport(row('browser.claude_web'), true, reports).state, 'always', 'browser rows carry no companion requirement');
  const second = [...reports, { machine_label: 'mac', current: true, document: { ...document, features: { ...document.features, detail_levels: ['buckets_only'] } } }];
  assert.deepEqual(optionSupport(row('execution.detail_level'), 'requests', second), { state: 'partial', supported: 1, reporting: 2, label: 'supported by 1 of 2 reporting' });
});
