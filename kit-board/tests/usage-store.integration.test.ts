import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { stableJson } from '../lib/contracts';
import { usageEnvelopeSchema, type UsageEnvelope } from '../lib/usage-contract';

const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
const bearer = (key: string) => new Request('http://localhost/api/v1/usage', { headers: { authorization: `Bearer ${key}` } });

const run = () => ({ run_id: randomUUID(), started_at: '2026-09-02T04:00:00.000Z', finished_at: '2026-09-02T04:00:02.500Z', companion_version: '2.0.0', platform: 'darwin', arch: 'arm64', settings_version: 1 });
const header = (adapter: string, channel: string, binding_id: string, observed_at = '2026-09-02T03:20:00.000Z') =>
  ({ record_id: randomUUID(), binding_id, adapter, channel, observed_at, basis: 'exact', parser_version: '2.0.0' });
const request = (binding_id: string, adapter = 'claude_execution', seed = 'msg', channel = 'local_file') => ({ ...header(adapter, channel, binding_id), record_type: 'activity.request',
  semantic_key: sha(seed), product: 'claude_code', surface: 'cli', execution_host: 'local', session_hash: sha('sess'), session_identity: 'provider', parent_session_hash: null,
  model_requested: null, model_actual: 'claude-sonnet-4', started_at: null, ended_at: null,
  tokens: { input_fresh: 100, input_cached: 0, input_cache_write: 0, output: 50, reasoning: null }, tool_calls: null, project_hash: null, client_version: null, latency_ms: null, outcome: 'completed' });
const reading = (binding_id: string, adapter: string, channel: string, reader: string, observed_at = '2026-09-02T03:20:00.000Z', value = 30) => ({ ...header(adapter, channel, binding_id, observed_at), basis: 'reported',
  record_type: 'allowance.reading', meter_key: 'five_hour', label: 'Claude · 5h', kind: 'percent_used', value, unit: 'percent', capacity: null, window_minutes: 300,
  window_started_at: null, resets_at: '2026-09-02T05:00:00.000Z', reader, raw_window_id: 'five_hour' });
const bucket = { session_hash: sha('sess'), hour: '2026-09-02T02:00:00.000Z', model: 'claude-opus-4-1', input_tokens: 5, cached_tokens: 20, cache_write_tokens: 8, output_tokens: 24, total_tokens: 57, calls: 2 };
const coverage = (adapter: string, state = 'ok', detail_code: string | null = null) => ({ adapter, state, detail_code, stores_discovered: 1, files: 1, bytes_read: 10, records_emitted: 1,
  malformed: 0, rejected_by_server: 0, duration_ms: 5, cursor_state: 'complete', probe_requests: 0, parser_version: '2.0.0' });
const envelope = (parts: Record<string, unknown>) => usageEnvelopeSchema.parse({ schema_version: 2, run: run(), buckets: [], records: [], coverage: [], ...parts }) as UsageEnvelope;
const reasons = (result: { rejected: { record_id: string; reason: string }[] }, records: { record_id: string }[]) => records.map(r => result.rejected.find(x => x.record_id === r.record_id)?.reason ?? 'accepted');

maybe('pairing, bindings, settings, config, ingestion rules, v1 dedupe, and the compatibility view', async () => {
  const { createUsageStore } = await import('../lib/usage-store');
  const sql = postgres(url!, options);
  const store = createUsageStore(() => sql);
  const account = `claude-${randomUUID().slice(0, 8)}`, codexAccount = `codex-${randomUUID().slice(0, 8)}`;
  try {
    // Pairing: eight-character code, single use, ten-minute expiry, key returned once.
    const issued = await store.issuePairingCode({ machine_label: 'test-mac' });
    assert.match(issued.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const pairBody = { code: issued.code.toLowerCase(), machine_label: 'test-mac', kind: 'companion', platform: 'darwin', arch: 'arm64' };
    const paired = await store.pairInstall(pairBody, '203.0.113.5');
    assert.match(paired.key, /^[A-Za-z0-9_-]{43}$/);
    await assert.rejects(store.pairInstall(pairBody, '203.0.113.5'), /Invalid or expired/);
    await assert.rejects(store.pairInstall({ ...pairBody, code: 'ZZZZ-ZZZZ' }, '203.0.113.5'), /Invalid or expired/);
    const install = await store.companionInstall(bearer(paired.key));
    assert.equal(install.kind, 'companion');
    await assert.rejects(store.companionInstall(bearer('x'.repeat(43))), /Unauthorized/);
    await assert.rejects(store.companionInstall(new Request('http://localhost')), /Unauthorized/);

    // Bindings: idempotent on (install, account); provider must match the account.
    const first = await store.createBinding(install, { account_id: account, provider: 'claude', account_label: 'Claude test', identity_hash: sha('identity') });
    const again = await store.createBinding(install, { account_id: account, provider: 'claude', account_label: 'Claude test', identity_hash: sha('identity') });
    assert.equal(first.created, true); assert.equal(again.created, false); assert.equal(again.binding.binding_id, first.binding.binding_id);
    await assert.rejects(store.createBinding(install, { account_id: account, provider: 'codex', account_label: 'x', identity_hash: null }), /another provider/);
    const codex = await store.createBinding(install, { account_id: codexAccount, provider: 'codex', account_label: 'Codex test', identity_hash: null });
    const bindingId = first.binding.binding_id, codexId = codex.binding.binding_id;
    const [source] = await sql`SELECT mode, disabled FROM personal_hub.telemetry_sources WHERE id = (SELECT source_id FROM personal_hub.companion_bindings WHERE id = ${bindingId})`;
    assert.equal(source.mode, 'companion');

    // Settings and the config document.
    const before = await store.collectionSettings();
    const updated = await store.updateInstallSettings(install, { allowance: { claude_reader: 'oauth_usage', codex_reader: 'off', cursor_reader: 'off' } });
    assert.equal(updated.settings_version, before.settings_version + 1);
    await assert.rejects(store.updateInstallSettings(install, { roots: ['/x'] }), 'a setting can never name a path');
    const current = await store.companionInstall(bearer(paired.key));
    const config = await store.companionConfig(current);
    assert.equal(config.document.settings.allowance.claude_reader, 'oauth_usage');
    assert.equal(config.document.settings.cadence_minutes, 60);
    assert.equal(config.document.settings_version, updated.settings_version);
    assert.equal(config.document.bindings.length, 2);
    assert.match(config.etag, /^"[a-f0-9]{32}"$/);
    assert.equal((await store.companionConfig(current)).etag, config.etag);
    await store.updateInstall({ id: install.id, action: 'pause' });
    assert.equal((await store.companionConfig(await store.companionInstall(bearer(paired.key)))).document.settings.paused, true, 'an install pause folds into the effective settings');
    await store.updateInstall({ id: install.id, action: 'resume' });

    // Ingestion: accepted, then every record a duplicate.
    const one = envelope({ buckets: [{ binding_id: bindingId, bucket }], records: [request(bindingId), reading(codexId, 'codex_execution', 'local_file', 'embedded')],
      coverage: [coverage('claude_execution'), coverage('codex_execution', 'partial', 'unavailable_roots')] });
    const r1 = await store.ingestUsage(current, one);
    assert.deepEqual(r1.accepted, { buckets: 1, records: 2 }); assert.equal(r1.duplicates, 0); assert.deepEqual(r1.rejected, []);
    const r2 = await store.ingestUsage(current, one);
    assert.deepEqual(r2.accepted, { buckets: 0, records: 0 }); assert.equal(r2.duplicates, 3);
    const [runRow] = await sql`SELECT accepted_buckets, accepted_records, jsonb_array_length(coverage) AS entries FROM personal_hub.companion_runs WHERE run_id = ${one.run.run_id}`;
    assert.equal(Number(runRow.accepted_buckets), 1, 'envelopes of one run accumulate on run_id');
    assert.equal(Number(runRow.entries), 2);
    const [codexSource] = await sql`SELECT coverage FROM personal_hub.telemetry_sources WHERE id = (SELECT source_id FROM personal_hub.companion_bindings WHERE id = ${codexId})`;
    assert.equal((codexSource.coverage as { unavailable_roots: number }).unavailable_roots, 1, 'v1-shaped coverage on the binding source row');

    // Rejection rules are per record and never fail the envelope.
    const foreign = request(randomUUID());
    const browserAdapter = request(bindingId, 'claude_browser', 'msg-b', 'browser_session');
    const mismatch = request(codexId, 'claude_execution', 'msg-m');
    const rules = await store.ingestUsage(current, envelope({ records: [foreign, browserAdapter, mismatch] }));
    assert.deepEqual(reasons(rules, [foreign, browserAdapter, mismatch]), ['binding_not_owned', 'adapter_not_allowed_for_install', 'adapter_provider_mismatch']);
    await store.updateInstall({ id: install.id, action: 'binding_disable', binding_id: codexId });
    const disabledReading = reading(codexId, 'codex_execution', 'local_file', 'embedded', '2026-09-02T03:30:00.000Z');
    assert.deepEqual(reasons(await store.ingestUsage(current, envelope({ records: [disabledReading] })), [disabledReading]), ['binding_not_enabled']);
    await store.updateInstall({ id: install.id, action: 'binding_enable', binding_id: codexId });

    // Identity: approval clears the hash and refuses records until the install posts the new one.
    await store.updateInstall({ id: install.id, action: 'approve_identity', binding_id: bindingId });
    const afterApproval = request(bindingId, 'claude_execution', 'msg-2');
    assert.deepEqual(reasons(await store.ingestUsage(current, envelope({ records: [afterApproval] })), [afterApproval]), ['identity_changed']);
    const confirmed = await store.confirmIdentity(current, bindingId, { identity_hash: sha('identity-2') });
    assert.equal(confirmed.identity_hash, sha('identity-2'));
    await assert.rejects(store.confirmIdentity(current, bindingId, { identity_hash: sha('identity-3') }), /approve/);
    assert.equal((await store.ingestUsage(current, envelope({ records: [afterApproval] }))).accepted.records, 1);

    // A browser install may submit readings from browser adapters only.
    const issuedBrowser = await store.issuePairingCode({ machine_label: 'Chrome', kind: 'browser' });
    const pairedBrowser = await store.pairInstall({ code: issuedBrowser.code, machine_label: 'Chrome', kind: 'browser', platform: 'darwin', arch: 'unknown' }, '203.0.113.6');
    const browser = await store.companionInstall(bearer(pairedBrowser.key));
    const browserBinding = (await store.createBinding(browser, { account_id: account, provider: 'claude', account_label: 'Claude test', identity_hash: null })).binding.binding_id;
    const browserRequest = request(browserBinding, 'claude_browser', 'msg-web', 'browser_session');
    const browserReading = reading(browserBinding, 'claude_browser', 'browser_session', 'web_backend');
    const companionAdapter = reading(browserBinding, 'claude_execution', 'hook_snapshot', 'statusline', '2026-09-02T03:21:00.000Z');
    const browserResult = await store.ingestUsage(browser, envelope({ buckets: [{ binding_id: browserBinding, bucket }], records: [browserRequest, browserReading, companionAdapter] }));
    assert.equal(browserResult.accepted.buckets, 0, 'a browser install cannot submit buckets');
    assert.equal(browserResult.accepted.records, 1);
    assert.deepEqual(reasons(browserResult, [browserRequest, browserReading, companionAdapter]), ['record_type_not_allowed_for_install', 'accepted', 'adapter_not_allowed_for_install']);

    // v1 and v2 buckets for the same session deduplicate; a more complete revision from either wins.
    const v1Source = randomUUID();
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash) VALUES (${v1Source}, ${account}, 'v1 mac', 'local', ${sha(randomUUID())})`;
    const v1Row = (b: typeof bucket) => ({ id: randomUUID(), account_id: account, source_id: v1Source, observed_at: '2026-09-02T04:10:00Z', content_hash: sha(stableJson(b)), ...b });
    assert.equal((await sql`INSERT INTO personal_hub.token_bucket_revisions ${sql(v1Row(bucket))} ON CONFLICT DO NOTHING RETURNING id`).length, 0, 'identical v1 bucket is a duplicate');
    const fuller = { ...bucket, output_tokens: 30, total_tokens: 63, calls: 3 };
    assert.equal((await sql`INSERT INTO personal_hub.token_bucket_revisions ${sql(v1Row(fuller))} ON CONFLICT DO NOTHING RETURNING id`).length, 1);
    const canonical = await sql`WITH canonical AS (SELECT DISTINCT ON (t.account_id, t.session_hash, t.hour, t.model) t.*
        FROM personal_hub.token_bucket_revisions t JOIN personal_hub.telemetry_sources s ON s.id = t.source_id AND NOT s.disabled
        WHERE t.account_id = ${account} ORDER BY t.account_id, t.session_hash, t.hour, t.model, t.calls DESC, t.total_tokens DESC, t.observed_at DESC, t.received_at DESC)
      SELECT calls, total_tokens FROM canonical`;
    assert.equal(canonical.length, 1); assert.equal(Number(canonical[0].calls), 3);

    // The compatibility view unions both ledgers and hides disabled sources and bindings.
    await sql`INSERT INTO personal_hub.quota_samples (id, account_id, source_id, content_hash, window_key, label, observed_at, used_percent, resets_at, window_minutes)
      VALUES (${randomUUID()}, ${account}, ${v1Source}, ${sha('q1')}, 'five_hour', 'Claude · 5h', '2026-09-02T03:00:00Z', 10, '2026-09-02T05:00:00Z', 300)`;
    const view = async (id: string) => sql`SELECT origin, reader, used_percent, source_id FROM personal_hub.allowance_percent_view WHERE account_id = ${id} ORDER BY observed_at`;
    assert.deepEqual((await view(account)).map(r => [r.origin, r.reader]), [['quota_samples', 'v1'], ['allowance_readings', 'web_backend']]);
    assert.deepEqual((await view(codexAccount)).map(r => r.reader), ['embedded']);
    await sql`UPDATE personal_hub.telemetry_sources SET disabled = true WHERE id = ${v1Source}`;
    await store.updateInstall({ id: browser.id, action: 'binding_disable', binding_id: browserBinding });
    assert.equal((await view(account)).length, 0, 'disabled sources and bindings leave the view');
    await store.updateInstall({ id: codex.binding.binding_id === codexId ? install.id : install.id, action: 'binding_disable', binding_id: codexId });
    assert.equal((await view(codexAccount)).length, 0);
    await store.updateInstall({ id: install.id, action: 'binding_enable', binding_id: codexId });

    // Reads for the pages, and reconciliation as a labeled query.
    const list = await store.listInstalls();
    const mine = list.installs.find(i => i.id === install.id)!;
    assert.equal(mine.bindings.length, 2); assert.equal(mine.applied_settings_version, 1); assert.ok(mine.latest_run);
    assert.equal(mine.bindings.find(b => b.id === bindingId)?.identity_state, 'confirmed');
    const reconciled = await store.reconcile(account, '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z');
    assert.equal(reconciled.covered_requests.requests, 2);
    assert.equal(reconciled.unattributed.total, null, 'no provider aggregate means no remainder, never a zero');

    // The release check keeps the previous value on failure and stores a semver on success.
    const failing = await store.syncCompanionRelease((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
    assert.equal('cached' in failing || ('ok' in failing && failing.ok === false), true);
    await sql`UPDATE personal_hub.collection_settings SET latest_companion_checked_at = NULL WHERE id = 1`;
    const body = JSON.stringify([{ tag_name: 'observatory-v2.1.0', draft: false, prerelease: false }, { tag_name: 'observatory-v2.2.0', draft: true }, { tag_name: 'agentlint-v9.0.0' }]);
    const ok = await store.syncCompanionRelease((async () => new Response(body, { status: 200, headers: { etag: '"abc"' } })) as unknown as typeof fetch);
    assert.deepEqual(ok, { ok: true, latest_companion_version: '2.1.0' });
    assert.equal((await store.listInstalls()).installs.find(i => i.id === install.id)?.update_available, true);
  } finally { await sql.end({ timeout: 1 }); }
});

maybe('the application role can append to every ledger but never update or delete one', async () => {
  const app = postgres(url!, { ...options, username: 'personal_hub_app' });
  try {
    for (const table of ['activity_requests', 'account_usage_buckets', 'allowance_readings', 'money_entries']) {
      await assert.rejects(app.unsafe(`UPDATE personal_hub.${table} SET content_hash = content_hash WHERE false`), /permission denied/, `${table} update`);
      await assert.rejects(app.unsafe(`DELETE FROM personal_hub.${table} WHERE false`), /permission denied/, `${table} delete`);
    }
    for (const [table, column] of [['collection_settings', 'settings_version = settings_version'], ['companion_installs', 'paused = paused'], ['companion_bindings', 'enabled = enabled'], ['companion_pairing_codes', 'used_at = used_at']]) {
      await app.unsafe(`UPDATE personal_hub.${table} SET ${column} WHERE false`);
      await assert.rejects(app.unsafe(`DELETE FROM personal_hub.${table} WHERE false`), /permission denied/, `${table} delete`);
    }
    await app`SELECT count(*) FROM personal_hub.allowance_percent_view`;
    await app`SELECT count(*) FROM personal_hub.token_bucket_revisions`;
  } finally { await app.end({ timeout: 1 }); }
});
