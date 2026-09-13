import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adapterProvider, contentSubject, normalizePairingCode, parseUsageEnvelope, usageEnvelopeSchema, usageSchemaJson, type UsageEnvelope } from '../lib/usage-contract';
import { adapterGate, defaultCollectionSettings, getSetting, installOverrideSchema, mergeSettings, setSetting, collectionSettingsSchema } from '../lib/companion-settings';

const corpus = join(import.meta.dirname, 'fixtures', 'usage-v2', 'wire');
const files = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.json')).sort();

test('every valid wire fixture parses and keeps its records', () => {
  const names = files(join(corpus, 'valid'));
  assert.ok(names.length >= 4);
  for (const name of names) {
    const text = readFileSync(join(corpus, 'valid', name), 'utf8');
    const envelope = usageEnvelopeSchema.parse(JSON.parse(text)) as UsageEnvelope;
    assert.equal(envelope.schema_version, 2, name);
    assert.ok(Array.isArray(envelope.buckets) && Array.isArray(envelope.records), `${name}: defaults applied`);
  }
});

test('every invalid wire fixture is rejected with its labeled reason', () => {
  const names = files(join(corpus, 'invalid'));
  assert.ok(names.length >= 10);
  for (const name of names) {
    const wrapper = JSON.parse(readFileSync(join(corpus, 'invalid', name), 'utf8')) as { reason: string; envelope: unknown };
    assert.ok(wrapper.reason, `${name}: labeled`);
    assert.equal(usageEnvelopeSchema.safeParse(wrapper.envelope).success, false, `${name} (${wrapper.reason}) was accepted`);
  }
});

test('the generated JSON Schema is current', () => {
  const generated = readFileSync(join(import.meta.dirname, '..', 'lib', 'generated', 'usage-v2.schema.json'), 'utf8');
  assert.equal(generated, JSON.stringify(usageSchemaJson, null, 2) + '\n', 'run `npm run usage-schema` and commit lib/generated/usage-v2.schema.json');
});

test('adapters map to providers and the content subject drops observation identity', () => {
  assert.equal(adapterProvider('claude_browser'), 'claude');
  assert.equal(adapterProvider('openai_api'), 'openai_api');
  const envelope = usageEnvelopeSchema.parse(JSON.parse(readFileSync(join(corpus, 'valid', 'companion-all-record-types.json'), 'utf8')));
  for (const record of envelope.records) {
    const subject = contentSubject(record);
    for (const key of ['record_id', 'binding_id', 'observed_at', 'parser_version']) assert.equal(key in subject, false, `${record.record_type}.${key}`);
    if (record.record_type === 'account.usage_bucket') assert.equal('provider_refreshed_at' in subject, false);
    assert.equal(subject.record_type, record.record_type);
  }
  assert.equal(normalizePairingCode('ab3d-ef7h'), 'AB3DEF7H');
});

test('detail records preserve zero, revisions, orphan evidence, and invocation cardinality', () => {
  const envelope = usageEnvelopeSchema.parse(JSON.parse(readFileSync(join(corpus, 'valid', 'detail-contract-events.json'), 'utf8')));
  const requests = envelope.records.filter(record => record.record_type === 'activity.request');
  const explicitZero = requests.find(record => record.token_accounting?.reported_total === 0);
  assert.ok(explicitZero);
  assert.deepEqual(explicitZero.tokens, { input_fresh: 0, input_cached: 0, input_cache_write: 0, output: 0, reasoning: 0 });
  assert.equal(explicitZero.model_actual, null, 'a recorded call may have an unknown resolved model');
  const positiveRemainder = requests.find(record => record.token_accounting?.unclassified === 5);
  assert.ok(positiveRemainder);
  assert.equal(positiveRemainder.token_accounting?.reported_total, 155);
  assert.equal((positiveRemainder.tokens.input_fresh ?? 0) + (positiveRemainder.tokens.input_cached ?? 0)
    + (positiveRemainder.tokens.input_cache_write ?? 0) + (positiveRemainder.tokens.output ?? 0), 150);

  const tools = envelope.records.filter(record => record.record_type === 'tool.event');
  assert.equal(tools.filter(record => record.event_kind === 'invocation').length, 1, 'result and progress rows do not count as calls');
  assert.equal(tools.filter(record => record.event_kind === 'result').length, 3, 'multiple and orphan results remain evidence');
  assert.equal(envelope.records.filter(record => record.record_type === 'resource.access').length, 2, 'one invocation can touch multiple sources');
  assert.ok(envelope.coverage[0].capabilities?.some(capability => capability.dimension === 'resource'));

  const revised = { ...tools[0], record_id: '00000000-0000-4000-8000-000000000001', outcome: 'succeeded' as const };
  assert.notDeepEqual(contentSubject(tools[0]), contentSubject(revised), 'outcome changes are revisions');
  const repeated = { ...tools[0], record_id: '00000000-0000-4000-8000-000000000002' };
  assert.deepEqual(contentSubject(tools[0]), contentSubject(repeated), 'observation identity does not create a revision');
});

test('reasoning tokens constrain a reported total even when output is unknown', () => {
  const wrapper = JSON.parse(readFileSync(join(corpus, 'invalid', 'reasoning-above-reported-total.json'), 'utf8')) as {
    envelope: { records: Record<string, unknown>[] };
  };
  assert.equal(usageEnvelopeSchema.safeParse(wrapper.envelope).success, false, 'partial accounting cannot understate reasoning evidence');
  const record = wrapper.envelope.records[0] as Record<string, unknown>;
  const tokenAccounting = record.token_accounting as Record<string, unknown>;
  const inconsistent = { ...wrapper.envelope, records: [{ ...record,
    token_accounting: { ...tokenAccounting, unclassified: null, composition_state: 'inconsistent' } }] };
  assert.equal(usageEnvelopeSchema.safeParse(inconsistent).success, true, 'the same lower-bound conflict remains representable');
});

test('ingress rejects identifiable invalid records without discarding valid siblings', () => {
  const source = JSON.parse(readFileSync(join(corpus, 'valid', 'companion-all-record-types.json'), 'utf8')) as { records: Record<string, unknown>[] };
  const bad = { ...source.records[0], record_id: '00000000-0000-4000-8000-000000000099', private_path: '/synthetic/private.md' };
  const parsed = parseUsageEnvelope({ ...source, records: [source.records[0], bad] });
  assert.equal(parsed.envelope.records.length, 1);
  assert.deepEqual(parsed.invalid, [{ record_id: bad.record_id, reason: 'invalid' }]);
  assert.throws(() => parseUsageEnvelope({ ...source, records: [{ ...bad, record_id: 'missing' }] }));
});

test('settings merge with defaults, overrides replace whole groups, and gates follow the mode', () => {
  assert.deepEqual(mergeSettings({}), defaultCollectionSettings);
  assert.equal(collectionSettingsSchema.safeParse({ ...defaultCollectionSettings, roots: ['/x'] }).success, false, 'a setting can never name a path');
  assert.equal(installOverrideSchema.safeParse({ cadence_minutes: 45 }).success, false);
  const override = installOverrideSchema.parse({ paused: true, allowance: { claude_reader: 'oauth_usage', codex_reader: 'off', cursor_reader: 'off' } });
  const merged = mergeSettings(defaultCollectionSettings, override);
  assert.equal(merged.paused, true);
  assert.equal(merged.allowance.codex_reader, 'off');
  assert.equal(merged.cadence_minutes, 60);
  assert.equal(adapterGate(defaultCollectionSettings, 'claude_execution').enabled, true);
  assert.equal(adapterGate(defaultCollectionSettings, 'claude_account').enabled, false);
  assert.equal(adapterGate(defaultCollectionSettings, 'codex_account').mode_path, 'allowance.codex_reader.app_server');
  assert.equal(adapterGate(defaultCollectionSettings, 'cursor_execution').provider_enabled, false);
  assert.equal(adapterGate(merged, 'claude_execution').enabled, false, 'paused wins');
  const doc = setSetting({} as Record<string, unknown>, 'allowance.claude_reader', 'oauth_usage', defaultCollectionSettings as unknown as Record<string, unknown>);
  assert.deepEqual(doc.allowance, { ...defaultCollectionSettings.allowance, claude_reader: 'oauth_usage' }, 'setting one key copies the rest of the group');
  assert.equal(getSetting(defaultCollectionSettings as unknown as Record<string, unknown>, 'execution.detail_level'), 'buckets_only');
});
