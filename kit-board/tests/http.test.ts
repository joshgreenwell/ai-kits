import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { failure, READ_TIMEOUT_MESSAGE } from '../lib/http';
import { RequestError } from '../lib/contracts';
import { DatabaseUnavailable } from '../lib/database-queue';

test('failures map to their causes: 503 only for a missing database, 504 for the read budget, 500 otherwise', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const outcome = async (error: unknown) => { const response = failure(error); return [response.status, (await response.json() as { error: string }).error] as const; };
    assert.deepEqual(await outcome(new RequestError('The report database is not connected yet', 503)), [503, 'The report database is not connected yet']);
    assert.deepEqual(await outcome(new DatabaseUnavailable('DB_TIMEOUT')), [504, READ_TIMEOUT_MESSAGE]);
    assert.deepEqual(await outcome(new DatabaseUnavailable('DB_BUSY')), [504, READ_TIMEOUT_MESSAGE]);
    assert.deepEqual(await outcome(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })), [504, READ_TIMEOUT_MESSAGE]);
    assert.equal((await outcome(Object.assign(new Error('relation missing'), { code: '42P01' })))[0], 500);
    assert.equal((await outcome(new Error('boom')))[0], 500);
    assert.equal((await outcome(new Error('boom')))[1], 'The request could not be completed. Please try again.');
    assert.equal(failure(z.object({ a: z.string() }).safeParse({}).error).status, 400);
    assert.equal(failure(new Error('x')).headers.get('cache-control'), 'private, no-store, max-age=0');
  } finally { console.error = quiet; }
});
