import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseQueue } from '../lib/database-queue';
import { readCache } from '../lib/read-cache';
import { fetchPrivateJson } from '../lib/fetch-private-json';

test('concurrent database callers never pipeline and a transaction keeps exclusive access', async () => {
  const queue = new DatabaseQueue(async () => {});
  let active = 0;
  const events: string[] = [];
  const transaction = queue.run(async () => {
    assert.equal(active++, 0); events.push('begin'); await delay(5);
    events.push('commit'); active--; return 'receipt';
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => queue.run(async () => {
    assert.equal(active++, 0); events.push('query'); await delay(1); active--; return i;
  })));
  assert.equal(await transaction, 'receipt'); assert.deepEqual(events.slice(0, 2), ['begin', 'commit']);
  assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => i));
});

test('a lost driver promise is bounded, resets the connection, and does not replay work', async () => {
  let resets = 0, writes = 0;
  const queue = new DatabaseQueue(async () => { resets++; }, 15);
  await assert.rejects(queue.run(() => { writes++; return new Promise(() => {}); }), { code: 'DB_TIMEOUT' });
  assert.equal(resets, 1); assert.equal(writes, 1);
  assert.equal(await queue.run(async () => 'healthy'), 'healthy');
});

test('queued work keeps its whole budget once it starts; only an overlong wait or overload is refused', async () => {
  // The budget is measured from the job's start: work that waited behind a stalled transaction still runs.
  const queue = new DatabaseQueue(async () => { await delay(5); }, 15, 3, 1000);
  const stalled = queue.run(() => new Promise(() => {}));
  const queued = queue.run(async () => { await delay(10); return 'ran after the stall'; });
  await assert.rejects(stalled, { code: 'DB_TIMEOUT' });
  assert.equal(await queued, 'ran after the stall');
  // A separate, generous wait limit: work that waited longer never executes.
  const strict = new DatabaseQueue(async () => {}, 50, 2, 5);
  const slow = strict.run(() => delay(20));
  let ran = false;
  await assert.rejects(strict.run(async () => { ran = true; }), { code: 'DB_BUSY' });
  await slow; assert.equal(ran, false);
  // Overload is bounded by capacity before anything is queued.
  const full = new DatabaseQueue(async () => {}, 15, 2);
  const first = full.run(() => new Promise(() => {}));
  const second = full.run(async () => 'second');
  await assert.rejects(full.run(async () => {}), { code: 'DB_BUSY' });
  await assert.rejects(first, { code: 'DB_TIMEOUT' }); assert.equal(await second, 'second');
});

test('private cache coalesces bursts, expires, and does not retain failures or invalidated loads', async () => {
  let calls = 0;
  const cache = readCache(10, async () => { await delay(1); return ++calls; });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => cache.get())), Array(8).fill(1));
  await delay(15); assert.equal(await cache.get(), 2);
  cache.invalidate(); assert.equal(await cache.get(), 3);
  let fail = true;
  const errors = readCache(1000, async () => { if (fail) throw new Error('offline'); return 'ok'; });
  await assert.rejects(errors.get()); fail = false; assert.equal(await errors.get(), 'ok');
  let release!: (n: number) => void;
  const changing = readCache(1000, () => new Promise<number>(r => { release = r; }));
  const old = changing.get(); await delay(0); changing.invalidate(); release(1); await old;
  const fresh = changing.get(); await delay(0); release(2); assert.equal(await fresh, 2);
});

test('client retries a 503 once, surfaces a 504 without retrying, bounds hanging reads, and respects navigation cancellation', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => ++calls === 1 ? new Response('unavailable', { status: 503 }) : Response.json({ ok: true });
    assert.deepEqual(await fetchPrivateJson('/api/test', new AbortController().signal), { ok: true }); assert.equal(calls, 2);
    calls = 0;
    // A 504 is the server's read budget: a second attempt would only wait through it again.
    globalThis.fetch = async () => { calls++; return Response.json({ error: 'slow' }, { status: 504 }); };
    await assert.rejects(fetchPrivateJson('/api/test', new AbortController().signal), /\(504\)/); assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async (_url, options) => { calls++; return new Promise((_resolve, reject) => {
      const signal = options!.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }); };
    // Keep the test event loop alive; AbortSignal.timeout itself uses an unref'ed timer.
    const keepAlive = delay(40);
    await assert.rejects(fetchPrivateJson('/api/test', new AbortController().signal, 5)); assert.equal(calls, 2);
    calls = 0;
    await assert.rejects(fetchPrivateJson('/api/test', new AbortController().signal, 5, false)); assert.equal(calls, 1);
    const navigation = new AbortController(); navigation.abort(); calls = 0;
    await assert.rejects(fetchPrivateJson('/api/test', navigation.signal, 5)); assert.equal(calls, 1);
    await keepAlive;
  } finally { globalThis.fetch = original; }
});
