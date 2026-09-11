import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, issueSession, verifySession } from '../lib/crypto';
import { prepareArtifact } from '../lib/artifact';
import { readJson, reportSchema, stableJson } from '../lib/contracts';
import { createHash } from 'node:crypto';

test('passwords use salted scrypt and reject wrong passwords', async () => {
  const hash = await hashPassword('example-test-only');
  assert.equal(await verifyPassword('example-test-only', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.notEqual(hash, await hashPassword('example-test-only'));
});
test('sessions reject tampering, expiry, password rotation, and secret rotation', () => {
  const now = Date.now(); const session = issueSession('test-secret', 'password-hash', now);
  assert.equal(verifySession(session, 'test-secret', 'password-hash', now), true);
  assert.equal(verifySession(session + 'x', 'test-secret', 'password-hash', now), false);
  assert.equal(verifySession(session, 'test-secret', 'password-hash', now + 8 * 86400_000), false);
  assert.equal(verifySession(session, 'test-secret', 'changed', now), false);
  assert.equal(verifySession(session, 'changed', 'password-hash', now), false);
});
test('report documents cannot share origin, make network calls, submit forms, or run inline handlers', () => {
  const { html, csp } = prepareArtifact('<html><head><title>Report</title></head><body><a href="#section">Go</a><details><summary>More</summary></details><select id="severity" disabled><option>All</option></select><script>console.log("tabs")</script><img onerror="fetch(\"/api/reports\")"></body></html>');
  assert.match(csp, /sandbox allow-scripts/); assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /script-src 'sha256-/); assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /connect-src 'none'/); assert.match(csp, /form-action 'none'/);
  assert.match(html, /data-personal-hub-theme/);
  assert.match(html, /href="#section"/);
  assert.match(html, /<details>/);
  assert.match(html, /data-personal-hub-layout/);
  assert.match(html, /data-personal-hub-controls/);
  assert.match(html, /<select id="severity" disabled>/);
  // Shared controls and the layout bridge obey the same exact-script CSP as
  // authored scripts without gaining origin or network privileges.
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`));
  }
});
test('stream limits are enforced even without a Content-Length header', async () => {
  const request = new Request('http://localhost', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(500) }) });
  await assert.rejects(readJson(request, 50), /too large/);
});
test('idempotency hashes do not depend on object key order', () => {
  assert.equal(stableJson({ b: 2, a: { y: 1, x: 2 } }), stableJson({ a: { x: 2, y: 1 }, b: 2 }));
});
test('reports reject invalid dates and preserve partial coverage', () => {
  const report = { schema_version: 1, period_key: '2026-09-07', subject_key: 'josh', idempotency_key: 'abc', title: 'Daily tasks', produced_at: '2026-09-07T09:00:00-05:00', status: 'partial', coverage: { outlook: 'unavailable' }, payload: {} };
  assert.equal(reportSchema.parse(report).status, 'partial');
  assert.equal(reportSchema.safeParse({ ...report, period_key: '2026-02-30' }).success, false);
});
