import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { stableJson } from '../lib/contracts';
import { parseUsageEnvelope } from '../lib/usage-contract';
import { normalizeQuota } from '../browser/claude-quota/normalize.js';
import { bindingRequest, buildEnvelope, detectPlatform, failureEnvelope, identityHash, pairRequest, parsePairResponse, settingsGate, uploadDisposition } from '../browser/claude-quota/collector.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };
const bearer = (key: string) => new Request('http://localhost/api/v1/usage', { headers: { authorization: `Bearer ${key}` } });
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'browser', 'claude-web-usage.json'), 'utf8')) as Record<string, unknown>;
const OBSERVED_AT = '2026-09-02T03:20:00.000Z';

/**
 * The v2 browser path end to end against the store: a browser pairing code, the collector's pair
 * request, its binding request with the companion-compatible identity hash, the config gate, an
 * envelope built from the web usage fixture, and the reading read back through the compatibility
 * view, the v2 dashboard, and the Connections summary; then dual publication and the gates.
 */
maybe('browser collector v2: pair, bind, upload allowance readings, and read them back', async () => {
  const { createUsageStore } = await import('../lib/usage-store');
  const sql = postgres(url!, options);
  const store = createUsageStore(() => sql);
  const account = `claude-${randomUUID().slice(0, 8)}`, claudeUuid = randomUUID();
  try {
    const issued = await store.issuePairingCode({ kind: 'browser', machine_label: 'Chrome · test' });
    assert.equal(issued.kind, 'browser');
    const request = pairRequest({ code: issued.code.toLowerCase().replace('-', ' '), machineLabel: 'Chrome · test', platform: detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') });
    assert.deepEqual([request.kind, request.platform, request.arch], ['browser', 'windows', 'unknown']);
    const paired = parsePairResponse(await store.pairInstall(request, '203.0.113.9'));
    const install = await store.companionInstall(bearer(paired.key));
    assert.equal(install.kind, 'browser');

    // The binding carries the hash the companion would post for the same claude.ai account.
    const hash = await identityHash('claude', claudeUuid);
    assert.equal(hash, createHash('sha256').update(stableJson(['claude', claudeUuid])).digest('hex'));
    const bound = await store.createBinding(install, bindingRequest({ accountId: account, accountLabel: 'Claude test', identityHash: hash }));
    assert.equal(bound.created, true); assert.equal(bound.binding.identity_hash, hash);
    const bindingId = bound.binding.binding_id as string;
    assert.deepEqual(await store.confirmIdentity(install, bindingId, { identity_hash: hash }), { ok: true, binding_id: bindingId, identity_hash: hash, enabled: true });
    const config = (await store.companionConfig(install)).document;
    const gate = settingsGate(config, bindingId);
    assert.deepEqual([gate.collect, gate.reason, gate.serverIdentityHash], [true, null, hash]);

    // Upload: every recognized window from the fixture, one reading each, accepted once and duplicated on retry.
    const quotas = normalizeQuota(fixture, OBSERVED_AT);
    const envelope = await buildEnvelope({ bindingId, quotas, startedAt: OBSERVED_AT, finishedAt: '2026-09-02T03:20:01.000Z', platform: 'windows', settingsVersion: config.settings_version });
    const { envelope: parsed, invalid } = parseUsageEnvelope(envelope);
    assert.equal(invalid.length, 0);
    const receipt = await store.ingestUsage(install, parsed, invalid);
    assert.deepEqual([receipt.accepted.buckets, receipt.accepted.records, receipt.rejected.length], [0, 4, 0]);
    const retry = await store.ingestUsage(install, parseUsageEnvelope(envelope).envelope);
    assert.deepEqual([retry.accepted.records, retry.duplicates], [0, 4], 'a retried body is a duplicate, never a second reading');

    // Read back: the compatibility view, the v2 current-reading selection, and the Connections summary.
    const view = await sql`SELECT window_key, label, used_percent, reader, origin, history_only, window_minutes FROM personal_hub.allowance_percent_view WHERE account_id = ${account} ORDER BY window_key`;
    assert.deepEqual(view.map(r => [r.window_key, r.label, Number(r.used_percent), r.reader, r.origin, r.history_only]), [
      ['extra_usage', 'Claude · extra usage', 7.5, 'web_backend', 'allowance_readings', false],
      ['five_hour', 'Claude · 5h', 12.5, 'web_backend', 'allowance_readings', false],
      ['seven_day', 'Claude · weekly', 40, 'web_backend', 'allowance_readings', false],
      ['seven_day_claude_opus_4', 'Claude · weekly · Claude Opus 4', 3, 'web_backend', 'allowance_readings', false],
    ]);
    const dashboard = await store.usageDashboard();
    const current = (dashboard.allowance as Record<string, unknown>[]).filter(row => row.account_id === account);
    assert.deepEqual(current.map(row => [row.meter_key, row.reader, row.basis, row.value]).sort(), [
      ['extra_usage', 'web_backend', 'reported', 7.5], ['five_hour', 'web_backend', 'reported', 12.5], ['seven_day', 'web_backend', 'reported', 40], ['seven_day_claude_opus_4', 'web_backend', 'reported', 3]].sort());
    const summary = (await store.listInstalls()).installs.find(i => i.id === install.id)!;
    assert.equal(summary.kind, 'browser'); assert.equal(summary.companion_version, 'browser-2.0.0');
    assert.deepEqual([summary.health.pairing, summary.health.binding, summary.health.identity, summary.health.execution, summary.health.coverage_only], ['paired', 'complete', 'confirmed', 'ok', false]);
    assert.equal(summary.bindings[0].identity_state, 'confirmed');
    assert.deepEqual(summary.bindings[0].last_observation.allowance, { observed_at: new Date(OBSERVED_AT).toISOString(), resets_at: '2026-09-02T05:00:00.000Z', reader: 'web_backend' });
    assert.equal(summary.accepted_by_type['allowance.reading'].accepted, 4);
    assert.equal(summary.latest_run?.coverage[0].adapter, 'claude_browser');

    // Dual publication: the v1 sample of the same observation is shown once, as the v2 reading (v2 wins on a tie).
    const v1Source = randomUUID();
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash) VALUES (${v1Source}, ${account}, 'Chrome · legacy', 'browser', ${createHash('sha256').update(randomUUID()).digest('hex')})`;
    const five = quotas.find(q => q?.window_key === 'five_hour')!;
    await sql`INSERT INTO personal_hub.quota_samples (id, account_id, source_id, content_hash, window_key, label, observed_at, used_percent, resets_at, window_minutes)
      VALUES (${randomUUID()}, ${account}, ${v1Source}, ${createHash('sha256').update('v1-copy').digest('hex')}, 'five_hour', ${five.label}, ${five.observed_at}, ${five.used_percent}, ${five.resets_at}, 300)`;
    const fiveHour = await sql`SELECT origin, reader FROM personal_hub.allowance_percent_view WHERE account_id = ${account} AND window_key = 'five_hour'`;
    assert.deepEqual(fiveHour.map(r => [r.origin, r.reader]), [['allowance_readings', 'web_backend']]);
    // An older v1-only observation stays visible as v1 history.
    await sql`INSERT INTO personal_hub.quota_samples (id, account_id, source_id, content_hash, window_key, label, observed_at, used_percent, resets_at, window_minutes)
      VALUES (${randomUUID()}, ${account}, ${v1Source}, ${createHash('sha256').update('v1-older').digest('hex')}, 'five_hour', ${five.label}, '2026-09-02T02:20:00.000Z', 9, ${five.resets_at}, 300)`;
    const history = await sql`SELECT origin, used_percent FROM personal_hub.allowance_percent_view WHERE account_id = ${account} AND window_key = 'five_hour' ORDER BY observed_at`;
    assert.deepEqual(history.map(r => [r.origin, Number(r.used_percent)]), [['quota_samples', 9], ['allowance_readings', 12.5]]);
    // After the cutover the disabled v1 source keeps its history as history only.
    await sql`UPDATE personal_hub.telemetry_sources SET disabled = true WHERE id = ${v1Source}`;
    const afterCutover = await sql`SELECT origin, history_only FROM personal_hub.allowance_percent_view WHERE account_id = ${account} AND window_key = 'five_hour' ORDER BY observed_at`;
    assert.deepEqual(afterCutover.map(r => [r.origin, r.history_only]), [['quota_samples', true], ['allowance_readings', false]]);

    // A coverage-only failure body is contact, not a reading: the run states the missing tab and the ledger is untouched.
    const failed = failureEnvelope({ startedAt: '2026-09-02T04:20:00.000Z', finishedAt: '2026-09-02T04:20:01.000Z', platform: 'windows', settingsVersion: config.settings_version, code: 'no_tab' });
    const failedReceipt = await store.ingestUsage(install, parseUsageEnvelope(failed).envelope);
    assert.deepEqual([failedReceipt.accepted.records, failedReceipt.rejected.length], [0, 0]);
    const afterFailure = (await store.listInstalls()).installs.find(i => i.id === install.id)!;
    assert.deepEqual(afterFailure.latest_run?.coverage.map(c => [c.state, c.detail_code]), [['prerequisite_missing', 'no_tab']]);
    assert.equal(afterFailure.health.coverage_only, true);
    assert.equal(afterFailure.bindings[0].last_observation.allowance?.observed_at, new Date(OBSERVED_AT).toISOString(), 'contact never moves the reading');

    // Gates the collector honours from the config document, and the key refusal it stops on.
    await store.updateInstall({ id: install.id, action: 'pause' });
    assert.equal(settingsGate((await store.companionConfig(await store.companionInstall(bearer(paired.key)))).document, bindingId).reason, 'paused');
    await store.updateInstall({ id: install.id, action: 'resume' });
    await store.updateInstall({ id: install.id, action: 'binding_disable', binding_id: bindingId });
    assert.equal(settingsGate((await store.companionConfig(await store.companionInstall(bearer(paired.key)))).document, bindingId).reason, 'binding_disabled');
    const disabledReading = await store.ingestUsage(install, parseUsageEnvelope(await buildEnvelope({ bindingId, quotas: normalizeQuota(fixture, '2026-09-02T03:40:00.000Z'), startedAt: '2026-09-02T03:40:00.000Z', finishedAt: '2026-09-02T03:40:01.000Z', platform: 'windows' })).envelope);
    assert.equal(disabledReading.rejected.every(r => r.reason === 'binding_not_enabled'), true);
    await store.updateInstall({ id: install.id, action: 'disable' });
    await assert.rejects(store.companionInstall(bearer(paired.key)), /Unauthorized/);
    assert.equal(uploadDisposition(401), 'stop_auth');
  } finally {
    await sql.end({ timeout: 1 });
  }
});
