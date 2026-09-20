import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { stableJson } from '../lib/contracts';
import { allowanceReadingSchema, parseUsageEnvelope, usageEnvelopeSchema } from '../lib/usage-contract';
import { normalizeQuota } from '../browser/claude-quota/normalize.js';
import * as collector from '../browser/claude-quota/collector.js';

const HUB = 'https://personal-observatory-jg.vercel.app';
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'browser', 'claude-web-usage.json'), 'utf8')) as Record<string, unknown>;
const OBSERVED_AT = '2026-09-02T03:20:00.000Z';
const BINDING = '8a4e5f6b-7c83-4d9e-bfa0-3b4c5d6e7f80';
const KEY = 'k'.repeat(43);
/** The meter keys the companion's statusline and OAuth readers produce for the same windows (`observatory-core::inbox`). */
const COMPANION_METER_KEYS = ['five_hour', 'seven_day', 'seven_day_claude_opus_4', 'extra_usage'];
const COMPANION_LABELS: Record<string, string> = { five_hour: 'Claude · 5h', seven_day: 'Claude · weekly', seven_day_claude_opus_4: 'Claude · weekly · Claude Opus 4', extra_usage: 'Claude · extra usage' };

type Route = (input: { method: string; path: string; headers: Record<string, string>; body: unknown }) => { status: number; json?: unknown; etag?: string } | Promise<{ status: number; json?: unknown; etag?: string }>;
/** Loads the service worker in a fresh realm with a stubbed `chrome` and a routed `fetch`; returns a message sender. */
function loadWorker(state: Record<string, unknown>, tab: () => unknown, route: Route) {
  let handler: Function;
  const calls: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const context = {
    chrome: {
      runtime: { id: 'test-extension', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn: Function) { handler = fn; } } },
      alarms: { get: async () => ({ periodInMinutes: 60 }), create: async () => {}, onAlarm: { addListener() {} } },
      tabs: { query: async () => (tab() === null ? [] : [{ id: 1 }]) },
      scripting: { executeScript: async () => [{ result: tab() }] },
      storage: { local: { setAccessLevel: async () => {}, get: async () => structuredClone(state), set: async (value: object) => Object.assign(state, structuredClone(value)) } },
    },
    normalizeQuota, ...collector, AbortSignal, encodeURIComponent,
    fetch: async (url: string, options: { method?: string; headers: Record<string, string>; body?: string }) => {
      assert.ok(url.startsWith(HUB + '/'), 'the worker only talks to the Observatory');
      const call = { method: options.method ?? 'GET', path: url.slice(HUB.length), headers: options.headers, body: options.body === undefined ? undefined : JSON.parse(options.body) };
      calls.push(call);
      const r = await route(call);
      return { status: r.status, json: async () => r.json ?? null, headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? r.etag ?? null : null) } };
    },
  };
  const source = readFileSync(new URL('../browser/claude-quota/background.js', import.meta.url), 'utf8').replace(/^import [^;]+;\n/gm, '');
  vm.runInNewContext(source, context);
  const message = (value: object) => new Promise<any>(resolve => handler(value, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, resolve));
  return { message, calls };
}
const snapshot = (accountId = 'account-one', usage: unknown = fixture) => ({ accountId, email: 'PRIVATE SENTINEL@example.invalid', organizations: [{ id: 'org-one', name: 'PRIVATE SENTINEL org' }], usage, observedAt: OBSERVED_AT });
const receipt = (records: number, rejected: { record_id: string; reason: string }[] = []) => ({ ok: true, schema_version: 2, run_id: 'r', accepted: { buckets: 0, records }, duplicates: 0, rejected });
const configDocument = (overrides: Record<string, unknown> = {}, binding: Record<string, unknown> = {}) => ({
  schema_version: 2, settings_version: 7, install: { id: 'install-1', kind: 'browser', machine_label: 'Chrome · test', paused: false },
  bindings: [{ binding_id: BINDING, account_id: 'claude-personal', provider: 'claude', enabled: true, identity_hash: null, ...binding }],
  settings: { paused: false, cadence_minutes: 60, providers: { claude: true, codex: true, cursor: false }, ...overrides }, companion: { latest_version: null },
});

test('legacy v1 setup cannot replace credentials during an in-flight upload or mix a changed Claude identity', async () => {
  const connection = { source_id: 'source-one', account_id: 'personal-one', provider: 'claude', mode: 'browser', key: 'a'.repeat(43), url: HUB };
  const state: Record<string, any> = { connection, pin: { accountId: 'account-one', orgId: 'org-one' }, outbox: [] };
  let release: Function, started: Function, accountId = 'account-one', uploads = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const { message } = loadWorker(state, () => snapshot(accountId), async call => {
    assert.equal(call.path, '/api/v1/telemetry'); assert.equal(call.headers.Authorization, 'Bearer ' + connection.key);
    uploads++; started(); await pending; return { status: 200, json: { ok: true, id: 'receipt' } };
  });
  const collecting = message({ type: 'collect' });
  await inFlight;
  assert.match((await message({ type: 'import', connection: { ...connection, key: 'b'.repeat(43) } })).error, /running/);
  assert.match((await message({ type: 'pin', accountId: 'account-one', orgId: 'org-one' })).error, /running/);
  assert.match((await message({ type: 'pair', code: 'ABCD-EFGH' })).error, /running/);
  release!(); assert.equal((await collecting).ok, true);
  assert.equal(state.outbox.length, 0);
  accountId = 'different-account';
  assert.match((await message({ type: 'collect' })).error, /account changed/);
  assert.equal(state.lastError.code, 'account_mismatch');
  assert.match((await message({ type: 'pin', accountId, orgId: 'org-one' })).error, /new Observatory account/);
  assert.equal(uploads, 1);
});

test('pairing builds the companion pair request, keeps the install key locally, and refuses a second pairing', async () => {
  assert.deepEqual(collector.pairRequest({ code: ' abcd-efgh ', machineLabel: '  Chrome · personal ', platform: 'windows' }),
    { code: 'ABCD-EFGH', machine_label: 'Chrome · personal', kind: 'browser', platform: 'windows', arch: 'unknown' });
  assert.throws(() => collector.pairRequest({ code: 'ABC', machineLabel: 'x', platform: 'linux' }), /eight characters/);
  assert.equal(collector.detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'darwin');
  assert.equal(collector.detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(collector.detectPlatform(undefined), 'unknown');
  assert.throws(() => collector.parsePairResponse({ install_id: 'nope', key: KEY }), /no usable install key/);
  assert.throws(() => collector.parsePairResponse({ install_id: BINDING, key: 'short' }), /no usable install key/);

  const state: Record<string, any> = {};
  let status = 201;
  const { message, calls } = loadWorker(state, () => snapshot(), call => {
    assert.equal(call.path, '/api/v1/companion/pair'); assert.equal(call.headers.Authorization, undefined, 'pairing carries no key');
    return status === 201 ? { status, json: { install_id: '4d1a5a0e-2b7c-4c3d-9e8f-0a1b2c3d4e5f', key: KEY } } : { status, json: { error: 'Invalid or expired pairing code' } };
  });
  status = 401;
  assert.match((await message({ type: 'pair', code: 'ZZZZ-ZZZZ', label: 'Chrome' })).error, /Invalid or expired/);
  assert.equal(Object.hasOwn(state, 'install'), false);
  status = 201;
  assert.equal((await message({ type: 'pair', code: 'abcd efgh', label: 'Chrome · test' })).paired, true);
  assert.deepEqual(calls.at(-1)!.body, { code: 'ABCD-EFGH', machine_label: 'Chrome · test', kind: 'browser', platform: 'unknown', arch: 'unknown' });
  assert.equal(state.install.key, KEY); assert.equal(state.install.id, '4d1a5a0e-2b7c-4c3d-9e8f-0a1b2c3d4e5f');
  assert.match((await message({ type: 'pair', code: 'ABCD-EFGH', label: 'again' })).error, /already paired/);
  assert.match((await message({ type: 'collect' })).pending, /Bind the signed-in Claude account/);
});

test('the identity hash and binding request match what the companion posts for a Claude sign-in', async () => {
  const uuid = '11111111-2222-4333-8444-555555555555';
  const hash = await collector.identityHash('claude', uuid);
  assert.equal(hash, createHash('sha256').update(stableJson(['claude', uuid])).digest('hex'));
  assert.deepEqual(collector.bindingRequest({ accountId: 'claude-personal', accountLabel: '', identityHash: hash }),
    { account_id: 'claude-personal', provider: 'claude', account_label: 'claude-personal', identity_hash: hash });
  assert.throws(() => collector.bindingRequest({ accountId: 'Claude Personal', accountLabel: 'x', identityHash: hash }), /account id/);
  assert.throws(() => collector.bindingRequest({ accountId: 'claude-personal', accountLabel: 'me@example.invalid', identityHash: hash }), /not an email/);
});

test('envelope v2 from the web usage fixture validates against the server contract with the companion meter keys and nothing forbidden', async () => {
  const quotas = normalizeQuota(fixture, OBSERVED_AT);
  const envelope = await collector.buildEnvelope({ bindingId: BINDING, quotas, startedAt: OBSERVED_AT, finishedAt: '2026-09-02T03:20:01.000Z', platform: 'windows', settingsVersion: 7, durationMs: 950 });
  const parsed = usageEnvelopeSchema.parse(envelope);
  assert.equal(parsed.run.companion_version, 'browser-2.0.0'); assert.equal(parsed.run.settings_version, 7); assert.deepEqual(parsed.buckets, []);
  assert.deepEqual(parsed.records.map(r => r.record_type === 'allowance.reading' && r.meter_key), COMPANION_METER_KEYS);
  for (const record of envelope.records) {
    const reading = allowanceReadingSchema.parse(record);
    assert.deepEqual([reading.adapter, reading.channel, reading.reader, reading.basis, reading.kind, reading.unit], ['claude_browser', 'browser_session', 'web_backend', 'reported', 'percent_used', 'percent']);
    assert.equal(reading.label, COMPANION_LABELS[reading.meter_key]);
    assert.equal(reading.window_minutes, reading.meter_key === 'five_hour' ? 300 : 10080);
    assert.equal(reading.raw_window_id, reading.meter_key);
    assert.equal(reading.observed_at, OBSERVED_AT);
  }
  const byKey = Object.fromEntries(envelope.records.map(r => [r.meter_key, r]));
  assert.equal(byKey.five_hour.value, 12.5); assert.equal(byKey.seven_day.value, 40); assert.equal(byKey.seven_day_claude_opus_4.value, 3); assert.equal(byKey.extra_usage.value, 7.5);
  assert.equal(byKey.extra_usage.resets_at, byKey.seven_day.resets_at, 'extra usage inherits the weekly anchor');
  assert.deepEqual(parsed.coverage.map(c => [c.adapter, c.state, c.records_emitted, c.probe_requests, c.capabilities?.[0]?.state]), [['claude_browser', 'ok', 4, 3, 'complete']]);
  assert.equal(parseUsageEnvelope(envelope).invalid.length, 0);
  // Record ids are a function of binding, meter, and observation, so a retried body is a duplicate rather than a second reading.
  const again = await collector.buildEnvelope({ bindingId: BINDING, quotas, startedAt: OBSERVED_AT, finishedAt: '2026-09-02T03:20:01.000Z', platform: 'windows', settingsVersion: 7 });
  assert.deepEqual(again.records.map(r => r.record_id), envelope.records.map(r => r.record_id));
  assert.notEqual(again.run.run_id, envelope.run.run_id);
  // Ids are random or hashed hex, so they are excluded from the content scan; everything else is the upload.
  const body = JSON.stringify({ ...envelope, run: { ...envelope.run, run_id: '' }, records: envelope.records.map(({ record_id: _id, ...record }) => record) });
  for (const forbidden of ['PRIVATE SENTINEL', '@', 'organization', 'email', 'tokens', 'cookie', 'input_tokens', '123456', '65432', '99']) assert.equal(body.includes(forbidden), false, `body must not carry ${forbidden}`);
  const failure = usageEnvelopeSchema.parse(collector.failureEnvelope({ startedAt: OBSERVED_AT, finishedAt: '2026-09-02T03:20:01.000Z', platform: 'windows', code: 'no_tab' }));
  assert.deepEqual(failure.coverage.map(c => [c.state, c.detail_code, c.probe_requests, c.capabilities?.[0]?.state]), [['prerequisite_missing', 'no_tab', 0, 'unsupported']]);
  assert.equal(failure.records.length, 0);
});

test('outbox policy: retain on 5xx/429/408/network, stop on 401/403, drop other 4xx and continue', async () => {
  const table: [number | null, string][] = [[200, 'done'], [201, 'done'], [null, 'retain'], [500, 'retain'], [503, 'retain'], [429, 'retain'], [408, 'retain'], [401, 'stop_auth'], [403, 'stop_auth'], [400, 'drop'], [404, 'drop'], [409, 'drop'], [413, 'drop'], [422, 'drop']];
  for (const [status, expected] of table) assert.equal(collector.uploadDisposition(status), expected, `status ${status}`);
  const body = (observed: string) => ({ schema_version: 2, run: { finished_at: observed }, records: [{ observed_at: observed }] });
  const queue = [body('2026-09-01T00:00:00Z'), body('2026-09-01T01:00:00Z'), body('2026-09-01T02:00:00Z'), body('2026-09-01T03:00:00Z')];
  const statuses = [400, 200, 503, 200];
  const drained = await collector.drainOutbox(queue, async () => ({ status: statuses.shift()!, receipt: { error: 'bad body' } }));
  assert.deepEqual(drained.dropped, [{ status: 400, observed_at: '2026-09-01T00:00:00Z', error: 'bad body' }], 'the rejected body is dropped with its status and observation');
  assert.equal(drained.delivered.length, 1, 'the body behind it was delivered');
  assert.deepEqual(drained.stopped, { reason: 'retry', status: 503, message: 'bad body' });
  assert.deepEqual(drained.queue.map(b => b.run.finished_at), ['2026-09-01T02:00:00Z', '2026-09-01T03:00:00Z'], 'a server fault keeps the rest');
  const refused = await collector.drainOutbox(queue, async () => ({ status: 401, receipt: null }));
  assert.equal(refused.queue.length, 4); assert.equal(refused.stopped?.reason, 'unauthorized');
  const offline = await collector.drainOutbox(queue, async () => { throw new Error('offline'); });
  assert.equal(offline.queue.length, 4); assert.equal(offline.stopped?.reason, 'network');
  assert.equal(collector.enqueue(Array.from({ length: 200 }, (_, i) => body(String(i))), body('new')).length, collector.OUTBOX_LIMIT);
  assert.equal(collector.bodyObservedAt({ schema_version: 1, observed_at: 'v1' }), 'v1');
});

test('the config document gates collection: paused, provider off, binding disabled or missing; cadence is read from it', () => {
  assert.deepEqual(collector.settingsGate(null, BINDING), { collect: true, reason: null, cadenceMinutes: 60, serverIdentityHash: undefined });
  assert.equal(collector.settingsGate(configDocument(), BINDING).collect, true);
  assert.equal(collector.settingsGate(configDocument({ cadence_minutes: 15 }), BINDING).cadenceMinutes, 15);
  assert.equal(collector.settingsGate(configDocument({ paused: true }), BINDING).reason, 'paused');
  assert.equal(collector.settingsGate(configDocument({ providers: { claude: false, codex: true, cursor: false } }), BINDING).reason, 'provider_off');
  assert.equal(collector.settingsGate(configDocument({}, { enabled: false }), BINDING).reason, 'binding_disabled');
  assert.equal(collector.settingsGate(configDocument(), 'other').reason, 'binding_missing');
  assert.equal(collector.settingsGate(configDocument({}, { identity_hash: 'h'.repeat(64) }), BINDING).serverIdentityHash, 'h'.repeat(64));
});

test('health states are derived from stored facts only and name every unsupported case', () => {
  const now = Date.parse('2026-09-02T04:00:00.000Z');
  const install = { id: BINDING, machineLabel: 'Chrome', pairedAt: OBSERVED_AT }, binding = { id: BINDING, accountId: 'claude-personal', identityConfirmed: true };
  const pin = { accountId: 'account-one', orgId: 'org-one' }, lastRead = { observedAt: OBSERVED_AT, windows: COMPANION_METER_KEYS };
  assert.equal(collector.deriveHealth({}, now).code, 'unpaired');
  assert.equal(collector.deriveHealth({ install }, now).code, 'unbound');
  assert.equal(collector.deriveHealth({ install, binding }, now).code, 'unpinned');
  assert.equal(collector.deriveHealth({ install, binding, pin }, now).code, 'waiting');
  const ok = collector.deriveHealth({ install, binding, pin, lastRead, lastUploadV2: { at: '2026-09-02T03:20:02.000Z', accepted: 4, duplicates: 0, rejected: [] } }, now);
  assert.equal(ok.code, 'ok'); assert.match(ok.summary, /4 windows/);
  assert.equal(Object.fromEntries(ok.lines)['Recognized windows'], COMPANION_METER_KEYS.join(', '));
  assert.match(Object.fromEntries(ok.lines)['Bound account'], /claude-personal · identity confirmed/);
  for (const [code, expected] of [['no_tab', 'no_tab'], ['account_mismatch', 'account_mismatch'], ['no_windows', 'no_windows'], ['unauthorized', 'key_invalid'], ['identity_changed', 'identity_changed']] as const) {
    const health = collector.deriveHealth({ install, binding, pin, lastRead, lastError: { code, message: 'x', at: '2026-09-02T03:30:00.000Z' } }, now);
    assert.equal(health.code, expected, code); assert.match(health.summary, /Unsupported|refused|different identity/);
  }
  assert.equal(collector.deriveHealth({ install, binding, pin, lastRead, gate: { reason: 'paused' } }, now).code, 'paused');
  assert.equal(collector.deriveHealth({ install, binding, pin, lastRead, outboxV2: [{}] }, now).code, 'retrying');
  const legacy = collector.deriveHealth({ connection: { account_id: 'personal-one' }, pin, lastRead }, now);
  assert.match(Object.fromEntries(legacy.lines)['Legacy v1 bridge'], /personal-one/);
  assert.equal(collector.DUPLICATE_POLICY, 'v2_wins_on_tie');
});

test('a paired profile binds, honours the config, uploads envelope v2, drops a rejected body, retains on 5xx, and reports a missing tab', async () => {
  const install = { id: '4d1a5a0e-2b7c-4c3d-9e8f-0a1b2c3d4e5f', key: KEY, machineLabel: 'Chrome · test', url: HUB, pairedAt: OBSERVED_AT };
  const state: Record<string, any> = { install, outboxV2: [], outbox: [] };
  let tab: unknown = snapshot();
  let usageStatus = 200, config = configDocument();
  const hash = await collector.identityHash('claude', 'account-one');
  const uploads: unknown[] = [];
  const { message, calls } = loadWorker(state, () => tab, call => {
    assert.equal(call.headers.Authorization, 'Bearer ' + KEY);
    if (call.path === '/api/v1/companion/bindings') {
      assert.deepEqual(call.body, { account_id: 'claude-personal', provider: 'claude', account_label: 'claude-personal', identity_hash: hash });
      config = configDocument({}, { identity_hash: hash });
      return { status: 201, json: { binding_id: BINDING, account_id: 'claude-personal', provider: 'claude', enabled: true, identity_hash: hash } };
    }
    if (call.path === '/api/v1/companion/config') return { status: 200, json: config, etag: '"v1"' };
    if (call.path === '/api/v1/usage') {
      uploads.push(call.body);
      if (usageStatus !== 200) return { status: usageStatus, json: { error: usageStatus === 400 ? 'Report validation failed' : 'Unavailable' } };
      const records = (call.body as { records: unknown[] }).records.length;
      return { status: 200, json: receipt(records) };
    }
    throw new Error('unexpected ' + call.path);
  });
  const bound = await message({ type: 'bind', accountId: 'account-one', orgId: 'org-one', observatoryAccountId: 'claude-personal', accountLabel: '' });
  assert.equal(bound.ok, true, JSON.stringify(bound)); assert.equal(bound.windows, 4);
  assert.deepEqual(state.binding, { id: BINDING, accountId: 'claude-personal', identityHash: hash, identityConfirmed: true });
  assert.deepEqual(state.pin, { accountId: 'account-one', orgId: 'org-one' });
  assert.equal(uploads.length, 1);
  const envelope = usageEnvelopeSchema.parse(uploads[0]);
  assert.deepEqual(envelope.records.map(r => r.binding_id), [BINDING, BINDING, BINDING, BINDING]);
  assert.equal(envelope.run.settings_version, 7);
  assert.equal(calls.some(c => c.path === '/api/v1/telemetry'), false, 'no legacy connection, no v1 upload');
  assert.deepEqual(state.lastRead, { observedAt: OBSERVED_AT, windows: COMPANION_METER_KEYS, accountMatch: true });
  assert.equal(state.lastUploadV2.accepted, 4); assert.equal(state.lastError === null, true); assert.equal(state.outboxV2.length, 0);
  assert.equal(collector.deriveHealth(state).code, 'ok');

  // A permanently rejected body is dropped, recorded with its status and observation, and never blocks later readings.
  usageStatus = 400;
  const rejected = await message({ type: 'collect' });
  assert.equal(rejected.ok, false); assert.equal(state.outboxV2.length, 0);
  assert.deepEqual([state.lastError.code, state.lastError.status, state.lastError.observedAt], ['rejected', 400, OBSERVED_AT]);
  // A server fault keeps the body for retry.
  usageStatus = 503;
  await message({ type: 'collect' });
  assert.equal(state.outboxV2.length, 1); assert.equal(state.lastError.code, 'retry'); assert.equal(state.lastError.status, 503);
  assert.equal(collector.deriveHealth(state).code, 'error');
  // The install key refused: nothing is dropped and the health says so.
  usageStatus = 401;
  await message({ type: 'collect' });
  assert.equal(state.outboxV2.length, 2); assert.equal(state.lastError.code, 'unauthorized'); assert.equal(collector.deriveHealth(state).code, 'key_invalid');
  // Back online with no Claude tab: the retained bodies drain, a coverage-only body states the missing tab, and no reading is invented.
  usageStatus = 200; tab = null;
  const before = uploads.length;
  const missing = await message({ type: 'collect' });
  assert.equal(missing.code, 'no_tab'); assert.equal(state.outboxV2.length, 0);
  const posted = uploads.slice(before) as { records: unknown[]; coverage: { state: string; detail_code: string | null }[] }[];
  assert.equal(posted.length, 3);
  assert.deepEqual(posted.at(-1)!.coverage.map(c => [c.state, c.detail_code]), [['prerequisite_missing', 'no_tab']]);
  assert.equal(posted.at(-1)!.records.length, 0);
  assert.equal(collector.deriveHealth(state).code, 'no_tab');
  assert.equal(state.lastRead.observedAt, OBSERVED_AT, 'the last real observation is kept');
  // Paused in the Observatory: no read, no upload, and the state names it.
  tab = snapshot(); config = configDocument({ paused: true }, { identity_hash: hash });
  const paused = await message({ type: 'collect' });
  assert.equal(uploads.length, before + 3); assert.equal(state.gate.reason, 'paused'); assert.equal(collector.deriveHealth(state).code, 'paused'); assert.equal(paused.windows, 0);
  // The Observatory now holds another identity for the binding: readings stop until re-confirmation is approved.
  config = configDocument({}, { identity_hash: 'f'.repeat(64) });
  await message({ type: 'collect' });
  assert.equal(uploads.length, before + 3); assert.equal(state.lastError.code, 'identity_changed');
  // Unpair clears the v2 state and the pin when no legacy connection remains.
  assert.equal((await message({ type: 'unpair' })).unpaired, true);
  assert.equal(state.install, null); assert.equal(state.binding, null); assert.equal(state.pin, null);
});

test('during dual publication one read feeds both endpoints with the same observation, and removing the legacy connection ends it', async () => {
  const install = { id: '4d1a5a0e-2b7c-4c3d-9e8f-0a1b2c3d4e5f', key: KEY, machineLabel: 'Chrome · test', url: HUB, pairedAt: OBSERVED_AT };
  const connection = { source_id: 'source-one', account_id: 'claude-personal', provider: 'claude', mode: 'browser', key: 'a'.repeat(43), url: HUB };
  const hash = await collector.identityHash('claude', 'account-one');
  const state: Record<string, any> = { install, connection, binding: { id: BINDING, accountId: 'claude-personal', identityHash: hash, identityConfirmed: true }, pin: { accountId: 'account-one', orgId: 'org-one' }, outboxV2: [], outbox: [] };
  const bodies: Record<string, any[]> = { '/api/v1/usage': [], '/api/v1/telemetry': [] };
  const { message } = loadWorker(state, () => snapshot(), call => {
    if (call.path === '/api/v1/companion/config') return { status: 200, json: configDocument({}, { identity_hash: hash }) };
    bodies[call.path].push(call);
    if (call.path === '/api/v1/usage') return { status: 200, json: receipt(4) };
    return { status: 200, json: { ok: true, id: 'v1-receipt' } };
  });
  assert.equal((await message({ type: 'collect' })).ok, true);
  const v2 = bodies['/api/v1/usage'][0], v1 = bodies['/api/v1/telemetry'][0];
  assert.equal(v2.headers.Authorization, 'Bearer ' + KEY); assert.equal(v1.headers.Authorization, 'Bearer ' + connection.key);
  assert.equal(v1.body.schema_version, 1); assert.equal(v1.body.coverage.collector_version, 'browser-2.0.0');
  const v2ByKey = Object.fromEntries(v2.body.records.map((r: any) => [r.meter_key, r]));
  for (const quota of v1.body.quotas) {
    const reading = v2ByKey[quota.window_key];
    assert.deepEqual([reading.observed_at, reading.value, reading.resets_at, reading.window_minutes], [quota.observed_at, quota.used_percent, quota.resets_at, quota.window_minutes],
      `${quota.window_key}: both bodies carry one observation, so the compatibility view shows the pair once as the v2 reading`);
  }
  assert.equal(state.lastUploadV1.at !== undefined, true); assert.equal(state.lastUploadV2.accepted, 4);
  assert.equal((await message({ type: 'removeLegacy' })).removed, true);
  assert.equal(state.connection, null); assert.deepEqual(state.outbox, []); assert.deepEqual(state.pin, { accountId: 'account-one', orgId: 'org-one' }, 'the pin survives for the v2 binding');
  await message({ type: 'collect' });
  assert.equal(bodies['/api/v1/telemetry'].length, 1, 'v1 publication stops after the cutover step'); assert.equal(bodies['/api/v1/usage'].length, 2);
});
