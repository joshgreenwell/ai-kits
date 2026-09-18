import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageQuery, usageQuerySchema, USAGE_QUERY_CACHE_TTL_MS, USAGE_QUERY_SECTIONS } from '../lib/usage-query';

test('the usage query accepts a section and rejects an unknown one', () => {
  assert.equal(parseUsageQuery(new URLSearchParams()).section, undefined);
  assert.equal(parseUsageQuery(new URLSearchParams('section=overview')).section, 'overview');
  assert.equal(parseUsageQuery(new URLSearchParams('preset=last_7_days&section=tools')).section, 'tools');
  assert.deepEqual(USAGE_QUERY_SECTIONS, ['overview', 'requests', 'tools']);
  assert.equal(USAGE_QUERY_CACHE_TTL_MS, 5 * 60_000);
  assert.equal(usageQuerySchema.safeParse({ section: 'everything' }).success, false);
});
