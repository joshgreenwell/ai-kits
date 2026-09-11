import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('browser setup cannot replace credentials during an in-flight upload or mix a changed Claude identity', async () => {
  const connection = { source_id: 'source-one', account_id: 'personal-one', provider: 'claude', mode: 'browser', key: 'a'.repeat(43), url: 'https://personal-observatory-jg.vercel.app' };
  const state: Record<string, any> = { connection, pin: { accountId: 'account-one', orgId: 'org-one' }, outbox: [] };
  let handler: Function, release: Function, accountId = 'account-one', uploads = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started: Function;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const context = {
    chrome: {
      runtime: { id: 'test-extension', onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn: Function) { handler = fn; } } },
      alarms: { get: async () => ({}), onAlarm: { addListener() {} } },
      tabs: { query: async () => [{ id: 1 }] },
      scripting: { executeScript: async () => [{ result: { accountId, usage: {}, observedAt: new Date().toISOString() } }] },
      storage: { local: { setAccessLevel: async () => {}, get: async () => structuredClone(state), set: async (value: object) => Object.assign(state, structuredClone(value)) } },
    },
    normalizeQuota: () => [], AbortSignal,
    fetch: async (_url: string, options: any) => { uploads++; assert.equal(options.headers.Authorization, 'Bearer ' + connection.key); started(); await pending; return { ok: true, json: async () => ({ ok: true, id: 'receipt' }) }; },
  };
  vm.runInNewContext(readFileSync(new URL('../browser/claude-quota/background.js', import.meta.url), 'utf8').replace("import { normalizeQuota } from './normalize.js';", ''), context);
  const message = (value: object) => new Promise<any>(resolve => handler(value, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, resolve));
  const collecting = message({ type: 'collect' });
  await inFlight;
  assert.match((await message({ type: 'import', connection: { ...connection, key: 'b'.repeat(43) } })).error, /running/);
  assert.match((await message({ type: 'pin', accountId: 'account-one', orgId: 'org-one' })).error, /running/);
  release!(); assert.equal((await collecting).ok, true);
  assert.equal(state.outbox.length, 0);
  accountId = 'different-account';
  assert.match((await message({ type: 'collect' })).error, /account changed/);
  assert.match((await message({ type: 'pin', accountId, orgId: 'org-one' })).error, /new Observatory account/);
  assert.equal(uploads, 1);
});
