import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { RequestError, stableJson } from '../lib/contracts';
import { telemetrySchema } from '../lib/telemetry-contract';
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
const agent = (seed = 'child', parent: string | null = 'main', depth = 1) => ({ key: sha(`agent:${seed}`), identity_basis: 'provider',
  parent_key: parent ? sha(`agent:${parent}`) : null, parent_identity_basis: parent ? 'provider' : 'none',
  class: depth === 0 ? 'main' : 'builtin', name: depth === 0 ? null : 'Explore', depth });
const agentEvent = (binding_id: string, seed: string, event_kind = 'start', outcome = 'succeeded') => ({ ...header('claude_execution', 'local_file', binding_id),
  record_type: 'agent.event', semantic_key: sha(`agent-event:${seed}`), event_kind, session_hash: sha('sess'), agent: agent(seed),
  tool_invocation_key: null, outcome });
const toolEvent = (binding_id: string, seed: string, invocation: string, event_kind = 'invocation', outcome = 'unknown') => ({
  ...header('claude_execution', 'local_file', binding_id), record_type: 'tool.event',
  semantic_key: event_kind === 'invocation' ? sha(`tool:${invocation}`) : sha(`tool-result:${seed}`), invocation_key: sha(`tool:${invocation}`),
  event_kind, session_hash: sha('sess'), caller_request_key: sha('detail-request'), caller_agent_key: sha('agent:child'), parent_invocation_key: null,
  tool: { name: 'Read', namespace: null, class: 'builtin' }, outcome });
const resourceAccess = (binding_id: string, seed: string, resource_key = 'obsidian.primary') => ({ ...header('claude_execution', 'local_file', binding_id),
  record_type: 'resource.access', semantic_key: sha(`resource:${seed}`), invocation_key: sha('tool:read'), resource_key,
  configuration_version: 'resources.v1', access_kind: 'read', evidence_basis: 'explicit_argument', outcome: 'succeeded' });
const providerBucket = (binding_id: string, pricing?: Record<string, unknown>) => ({ ...header('claude_account', 'provider_api', binding_id), basis: 'reported',
  record_type: 'account.usage_bucket', report_source: 'claude_usage', bucket_start: '2026-09-02T03:00:00.000Z', bucket_end: '2026-09-02T04:00:00.000Z',
  provider_timezone: null, dimensions: { model: 'claude-sonnet-4', product: 'claude_code', client: null, user_ref: null, workspace_ref: null, api_key_ref: null,
    ...(pricing === undefined ? {} : { pricing }) },
  measures: { requests: 1, input_tokens: 100, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 50, reasoning_tokens: null, total_tokens: 150 },
  token_accounting: { reported_total: 150, unclassified: 0, composition_state: 'complete' },
  provider_event_id: 'synthetic-provider-event', provider_refreshed_at: '2026-09-02T04:01:00.000Z' });
const reading = (binding_id: string, adapter: string, channel: string, reader: string, observed_at = '2026-09-02T03:20:00.000Z', value = 30) => ({ ...header(adapter, channel, binding_id, observed_at), basis: 'reported',
  record_type: 'allowance.reading', meter_key: 'five_hour', label: 'Claude · 5h', kind: 'percent_used', value, unit: 'percent', capacity: null, window_minutes: 300,
  window_started_at: null, resets_at: '2026-09-02T05:00:00.000Z', reader, raw_window_id: 'five_hour' });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
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
    const duplicateIdentityAccount = `claude-${randomUUID().slice(0, 8)}`;
    await assert.rejects(
      store.createBinding(install, { account_id: duplicateIdentityAccount, provider: 'claude', account_label: 'Duplicate identity', identity_hash: sha('identity') }),
      (error: unknown) => error instanceof RequestError && error.status === 409 && /identity_taken/.test(error.message),
      'initial binding creation cannot assign one observed identity to two accounts',
    );
    assert.equal(Number((await sql`SELECT count(*) FROM personal_hub.companion_bindings WHERE install_id = ${install.id} AND account_id = ${duplicateIdentityAccount}`)[0].count), 0);
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

    // Optional v2 detail blocks and independent event ledgers preserve evidence without inventing joins.
    const projectKey = sha('project:synthetic');
    const worktreeKey = sha('project:synthetic-worktree');
    const sameFolderKey = sha('project:same-folder-name');
    const nativeProjectKey = sha('project:native');
    const legacyProjectKey = sha('project:legacy-hash-only');
    const revisionProjectKey = sha('project:revision-backfill');
    const detailedRequest = { ...request(bindingId, 'claude_execution', 'detail-request'), semantic_key: sha('detail-request'),
      token_accounting: { reported_total: 155, unclassified: 5, composition_state: 'complete' },
      pricing: { reasoning_effort: 'high', service_tier: 'standard', speed: null, context_window_tokens: 200000, cache_write_ttl: '5m' },
      agent: agent('child'), project: { key: projectKey, basis: 'working_directory' }, project_hash: projectKey };
    const zeroRequest = { ...request(bindingId, 'claude_execution', 'zero-request'), semantic_key: sha('zero-request'), model_actual: null,
      tokens: { input_fresh: 0, input_cached: 0, input_cache_write: 0, output: 0, reasoning: 0 },
      token_accounting: { reported_total: 0, unclassified: 0, composition_state: 'complete' },
      project: { key: null, basis: 'none' } };
    const worktreeRequest = { ...request(bindingId, 'claude_execution', 'worktree-request'), semantic_key: sha('worktree-request'),
      project: { key: worktreeKey, basis: 'working_directory' }, project_hash: worktreeKey };
    const sameFolderRequest = { ...request(bindingId, 'claude_execution', 'same-folder-request'), semantic_key: sha('same-folder-request'),
      project: { key: sameFolderKey, basis: 'working_directory' }, project_hash: sameFolderKey };
    const nativeProjectRequest = { ...request(bindingId, 'claude_execution', 'native-project-request'), semantic_key: sha('native-project-request'),
      project: { key: nativeProjectKey, basis: 'native' } };
    const legacyProjectRequest = { ...request(bindingId, 'claude_execution', 'legacy-project-request'), semantic_key: sha('legacy-project-request'),
      project_hash: legacyProjectKey };
    const projectRevisionUnknown = { ...request(bindingId, 'claude_execution', 'project-revision'), semantic_key: sha('project-revision') };
    const projectRevisionKnown = { ...projectRevisionUnknown, record_id: randomUUID(),
      project: { key: revisionProjectKey, basis: 'working_directory' }, project_hash: revisionProjectKey };
    const invocation = toolEvent(bindingId, 'read', 'read');
    const resultA = toolEvent(bindingId, 'read-a', 'read', 'result', 'succeeded');
    const resultB = toolEvent(bindingId, 'read-b', 'read', 'result', 'succeeded');
    const orphanResult = toolEvent(bindingId, 'orphan', 'missing', 'result', 'failed');
    const nullPricing = { reasoning_effort: null, service_tier: null, speed: null, context_window_tokens: null, cache_write_ttl: null };
    const details = envelope({ records: [detailedRequest, zeroRequest, worktreeRequest, sameFolderRequest, nativeProjectRequest,
      legacyProjectRequest, projectRevisionUnknown, projectRevisionKnown,
      agentEvent(bindingId, 'child'), invocation, resultA, resultB, orphanResult,
      resourceAccess(bindingId, 'vault-a'), resourceAccess(bindingId, 'vault-b', 'obsidian.reference'),
      providerBucket(bindingId), providerBucket(bindingId, nullPricing)],
      coverage: [{ ...coverage('claude_execution'), capabilities: [
        { dimension: 'requests', state: 'complete', detail_code: null },
        { dimension: 'agent', state: 'complete', detail_code: null },
        { dimension: 'tool', state: 'complete', detail_code: null },
        { dimension: 'resource', state: 'partial', detail_code: 'indirect_access_unknown' },
      ] }] });
    // A run under an earlier resource configuration arrives first; the next configuration supersedes it.
    const staleAccess = { ...resourceAccess(bindingId, 'vault-a-stale'), invocation_key: sha('tool:stale-read'),
      configuration_version: 'resources.v0', observed_at: '2026-09-02T03:10:00.000Z' };
    assert.equal((await store.ingestUsage(current, envelope({ records: [staleAccess] }))).accepted.records, 1);
    const invalidRecordId = randomUUID();
    const detailFirst = await store.ingestUsage(current, details, [{ record_id: invalidRecordId, reason: 'invalid' }]);
    assert.deepEqual(detailFirst.accepted, { buckets: 0, records: 17 }); assert.equal(detailFirst.duplicates, 0);
    assert.deepEqual(detailFirst.rejected, [{ record_id: invalidRecordId, reason: 'invalid' }]);
    const detailAgain = await store.ingestUsage(current, details);
    assert.equal(detailAgain.accepted.records, 0); assert.equal(detailAgain.duplicates, 17);
    const revisedInvocation = { ...invocation, record_id: randomUUID(), outcome: 'succeeded' };
    assert.equal((await store.ingestUsage(current, envelope({ records: [revisedInvocation] }))).accepted.records, 1, 'same semantic key with changed content is a revision');

    const [storedDetail] = await sql`SELECT reported_total_tokens, unclassified_tokens, token_state, observed_total_tokens,
        reasoning_effort, service_tier, agent_key, project_key, project_basis
      FROM personal_hub.activity_requests WHERE semantic_key = ${sha('detail-request')} ORDER BY received_at DESC LIMIT 1`;
    assert.equal(Number(storedDetail.reported_total_tokens), 155); assert.equal(Number(storedDetail.unclassified_tokens), 5);
    assert.equal(Number(storedDetail.observed_total_tokens), 155); assert.equal(storedDetail.token_state, 'complete');
    assert.equal(storedDetail.agent_key, sha('agent:child')); assert.equal(storedDetail.project_key, projectKey);
    const [storedZero] = await sql`SELECT model_actual, observed_total_tokens, token_state FROM personal_hub.activity_requests WHERE semantic_key = ${sha('zero-request')}`;
    assert.equal(storedZero.model_actual, null); assert.equal(Number(storedZero.observed_total_tokens), 0); assert.equal(storedZero.token_state, 'complete');

    // Project identities are scoped safely, then joined by append-only mappings.
    const issuedSecond = await store.issuePairingCode({ machine_label: 'second-mac' });
    const pairedSecond = await store.pairInstall({ code: issuedSecond.code, machine_label: 'second-mac', kind: 'companion', platform: 'linux', arch: 'amd64' }, '203.0.113.7');
    const secondInstall = await store.companionInstall(bearer(pairedSecond.key));
    const secondBinding = (await store.createBinding(secondInstall,
      { account_id: account, provider: 'claude', account_label: 'Claude test', identity_hash: sha('identity-second') })).binding.binding_id;
    const secondShared = { ...request(secondBinding, 'claude_execution', 'second-shared'), semantic_key: sha('second-shared'),
      project: { key: projectKey, basis: 'working_directory' }, project_hash: projectKey };
    const secondSameFolder = { ...request(secondBinding, 'claude_execution', 'second-same-folder'), semantic_key: sha('second-same-folder'),
      project: { key: sameFolderKey, basis: 'working_directory' }, project_hash: sameFolderKey };
    // The second machine configured the same resource key under its own configuration token.
    const secondInvocation = { ...toolEvent(secondBinding, 'second-read', 'second-read'), session_hash: sha('sess-second'),
      caller_agent_key: sha('agent:second'), tool: { name: 'Grep', namespace: null, class: 'builtin' } };
    const secondAccess = { ...resourceAccess(secondBinding, 'second-vault'), invocation_key: sha('tool:second-read'), configuration_version: 'cfg:second' };
    const secondEnvelope = envelope({ records: [secondShared, secondSameFolder, secondInvocation, secondAccess] });
    assert.equal((await store.ingestUsage(secondInstall, secondEnvelope)).accepted.records, 4);
    assert.equal((await store.ingestUsage(secondInstall, secondEnvelope)).duplicates, 4, 'duplicate replay leaves identities idempotent');

    const registryBefore = await store.listProjects();
    const identity = (key: string, installId: string | null, basis = 'working_directory') => registryBefore.identities.find(item =>
      item.evidence_key === key && item.install_id === installId && item.basis === basis)!;
    const firstSharedIdentity = identity(projectKey, install.id);
    const secondSharedIdentity = identity(projectKey, secondInstall.id);
    const worktreeIdentity = identity(worktreeKey, install.id);
    const firstSameFolderIdentity = identity(sameFolderKey, install.id);
    const secondSameFolderIdentity = identity(sameFolderKey, secondInstall.id);
    const nativeIdentity = identity(nativeProjectKey, null, 'native');
    const legacyIdentity = identity(legacyProjectKey, install.id);
    const revisionIdentity = identity(revisionProjectKey, install.id);
    assert.ok(firstSharedIdentity && secondSharedIdentity && firstSharedIdentity.id !== secondSharedIdentity.id,
      'matching hashes on two machines remain separately scoped identities');
    assert.ok(firstSameFolderIdentity.id !== secondSameFolderIdentity.id,
      'matching folder hashes never imply one logical project');

    const sharedProject = await store.updateProjects({ action: 'create', label: 'Shared observatory project' });
    const folderProjectA = await store.updateProjects({ action: 'create', label: 'Same folder A' });
    const folderProjectB = await store.updateProjects({ action: 'create', label: 'Same folder B' });
    await store.updateProjects({ action: 'map', project_id: sharedProject.project_id,
      identity_ids: [firstSharedIdentity.id, secondSharedIdentity.id, worktreeIdentity.id, nativeIdentity.id,
        legacyIdentity.id, revisionIdentity.id] });
    await store.updateProjects({ action: 'map', project_id: folderProjectA.project_id, identity_ids: [firstSameFolderIdentity.id] });
    await store.updateProjects({ action: 'map', project_id: folderProjectB.project_id, identity_ids: [secondSameFolderIdentity.id] });
    await store.updateProjects({ action: 'rename', project_id: sharedProject.project_id, label: 'Shared project renamed' });

    const resolvedState = async (semanticKey: string) => (await sql`SELECT project_state, project_id, project_label, project_key, project_basis
      FROM personal_hub.activity_request_project_resolution WHERE account_id = ${account} AND semantic_key = ${semanticKey}
      ORDER BY observed_at DESC LIMIT 1`)[0];
    assert.equal((await resolvedState(sha('detail-request'))).project_id, sharedProject.project_id,
      'two machines and a worktree can share one logical project');
    assert.equal((await resolvedState(sha('native-project-request'))).project_label, 'Shared project renamed');
    assert.equal((await resolvedState(sha('same-folder-request'))).project_id, folderProjectA.project_id);
    assert.equal((await resolvedState(sha('second-same-folder'))).project_id, folderProjectB.project_id);
    const legacyResolved = await resolvedState(sha('legacy-project-request'));
    assert.deepEqual([legacyResolved.project_id, legacyResolved.project_basis, legacyResolved.project_key],
      [sharedProject.project_id, 'working_directory', legacyProjectKey], 'legacy hash-only evidence remains assignable');
    const [legacyRaw] = await sql`SELECT project_basis, project_key, project_hash FROM personal_hub.activity_requests
      WHERE account_id = ${account} AND semantic_key = ${sha('legacy-project-request')}`;
    assert.deepEqual([legacyRaw.project_basis, legacyRaw.project_key, legacyRaw.project_hash], [null, null, legacyProjectKey],
      'legacy resolution never rewrites raw facts');
    const canonicalRevision = await sql`SELECT project_state, project_id FROM personal_hub.activity_request_project_resolution
      WHERE account_id = ${account} AND semantic_key = ${sha('project-revision')}`;
    assert.equal(canonicalRevision.length, 1, 'project coverage canonicalizes request revisions');
    assert.deepEqual([canonicalRevision[0].project_state, canonicalRevision[0].project_id], ['project', sharedProject.project_id],
      'a retained richer replay replaces Unknown in project coverage');
    assert.equal((await resolvedState(sha('zero-request'))).project_state, 'no_project');
    assert.equal((await resolvedState(sha('msg'))).project_state, 'unknown');

    const rawBefore = await resolvedState(sha('worktree-request'));
    await store.updateProjects({ action: 'unmap', identity_ids: [worktreeIdentity.id] });
    const unmapped = await resolvedState(sha('worktree-request'));
    assert.equal(unmapped.project_state, 'unassigned');
    assert.deepEqual([unmapped.project_key, unmapped.project_basis], [rawBefore.project_key, rawBefore.project_basis],
      'mapping changes do not edit raw request facts');
    await store.updateProjects({ action: 'map', project_id: sharedProject.project_id, identity_ids: [worktreeIdentity.id] });
    await sql`UPDATE personal_hub.usage_project_mapping_revisions SET changed_at = '2026-09-02T05:00:00Z'
      WHERE identity_id = ${worktreeIdentity.id}`;
    assert.equal((await resolvedState(sha('worktree-request'))).project_id, sharedProject.project_id);
    const mappingHistory = await sql`SELECT revision_order, project_id FROM personal_hub.usage_project_mapping_revisions
      WHERE identity_id = ${worktreeIdentity.id} ORDER BY revision_order`;
    assert.deepEqual(mappingHistory.map(row => row.project_id), [sharedProject.project_id, null, sharedProject.project_id],
      'database revision order preserves rapid map, unmap, and remap writes when audit timestamps collide');

    const registryAfter = await store.listProjects();
    assert.ok(registryAfter.coverage.evidence.with_identity >= 9);
    assert.ok(registryAfter.coverage.mapping.mapped >= 8);
    assert.ok(registryAfter.coverage.evidence.request_observations > registryAfter.coverage.evidence.canonical_requests,
      'raw observation coverage remains distinct from canonical request-state coverage');
    assert.equal(registryAfter.identities.some(item => 'path' in item), false, 'the registry never returns local paths');
    const [eventCounts] = await sql`SELECT
        (SELECT count(*)::int FROM personal_hub.agent_events WHERE account_id = ${account}) AS agents,
        (SELECT count(*)::int FROM personal_hub.tool_events WHERE account_id = ${account}) AS tools,
        (SELECT count(DISTINCT semantic_key)::int FROM personal_hub.tool_events WHERE account_id = ${account} AND event_kind = 'invocation') AS invocations,
        (SELECT count(*)::int FROM personal_hub.resource_accesses WHERE account_id = ${account}) AS resources`;
    assert.equal(Number(eventCounts.agents), 1); assert.equal(Number(eventCounts.tools), 6, 'one invocation revision plus results, an orphan, and the second machine call are retained');
    assert.equal(Number(eventCounts.invocations), 2, 'invocation revisions and results do not inflate the call count');
    assert.equal(Number(eventCounts.resources), 4, 'resource rows overlap for one invocation and keep earlier-configuration evidence');
    const hashes = await sql`SELECT DISTINCT dimensions_hash FROM personal_hub.account_usage_buckets
      WHERE account_id = ${account} AND provider_event_id = 'synthetic-provider-event'`;
    assert.equal(hashes.length, 1, 'an all-null pricing extension preserves the legacy provider dimension identity');

    // Knowledge-source identities are scoped per install, counted under the current configuration, and mapped by append-only revisions.
    const knowledgeBefore = await store.listKnowledgeSources();
    const ownIdentities = (registry: typeof knowledgeBefore) => registry.identities.filter(item => [install.id, secondInstall.id].includes(item.install_id));
    const resourceIdentity = (key: string, installId: string) => knowledgeBefore.identities.find(item => item.resource_key === key && item.install_id === installId)!;
    const firstPrimary = resourceIdentity('obsidian.primary', install.id);
    const secondPrimary = resourceIdentity('obsidian.primary', secondInstall.id);
    const firstReference = resourceIdentity('obsidian.reference', install.id);
    assert.equal(ownIdentities(knowledgeBefore).length, 3, 'duplicate replays never add identities');
    assert.ok(firstPrimary && secondPrimary && firstPrimary.id !== secondPrimary.id, 'one configured key on two machines remains two scoped identities');
    assert.deepEqual([firstPrimary.machine_label, secondPrimary.machine_label], ['test-mac', 'second-mac']);
    assert.deepEqual([firstPrimary.configuration_version, secondPrimary.configuration_version], ['resources.v1', 'cfg:second'],
      'an identity names the configuration the install most recently applied');
    assert.deepEqual([firstPrimary.first_seen, firstPrimary.last_seen], ['2026-09-02T03:10:00.000Z', '2026-09-02T03:20:00.000Z'],
      'sighting bounds span every configuration');
    assert.deepEqual([firstPrimary.accesses, firstPrimary.distinct_invocations, firstPrimary.earlier_configuration_accesses], [1, 1, 1],
      'earlier-configuration rows are disclosed, never counted as current');
    assert.deepEqual([firstReference.accesses, secondPrimary.accesses, secondPrimary.earlier_configuration_accesses], [1, 1, 0]);
    assert.equal(knowledgeBefore.identities.some(item => 'path' in item || 'roots' in item || 'connectors' in item), false,
      'the registry never returns local roots or connectors');
    assert.equal(knowledgeBefore.per_source.some(entry => entry.source_id === null && entry.identity_ids.includes(firstPrimary.id)), true,
      'an unassigned identity is its own bucket');

    const vault = await store.updateKnowledgeSources({ action: 'create', label: 'Primary vault' });
    await store.updateKnowledgeSources({ action: 'map', source_id: vault.source_id, identity_ids: [firstPrimary.id, secondPrimary.id] });
    await store.updateKnowledgeSources({ action: 'rename', source_id: vault.source_id, label: 'Primary vault renamed' });
    await assert.rejects(store.updateKnowledgeSources({ action: 'rename', source_id: randomUUID(), label: 'Missing' }), /Unknown knowledge source/);
    await assert.rejects(store.updateKnowledgeSources({ action: 'map', source_id: vault.source_id, identity_ids: [randomUUID()] }), /Unknown knowledge source identity/);
    await assert.rejects(store.updateKnowledgeSources({ action: 'create', label: 'Vault', roots: ['/private/vault'] }), 'a mutation can never name a root');

    const resolvedAccess = async (semanticKey: string) => (await sql`SELECT source_state, source_id, source_label, identity_id, current_configuration, resource_key
      FROM personal_hub.resource_access_source_resolution WHERE account_id = ${account} AND semantic_key = ${semanticKey}`)[0];
    const vaultA = await resolvedAccess(sha('resource:vault-a'));
    assert.deepEqual([vaultA.source_state, vaultA.source_id, vaultA.source_label, vaultA.identity_id, vaultA.current_configuration],
      ['source', vault.source_id, 'Primary vault renamed', firstPrimary.id, true]);
    assert.equal((await resolvedAccess(sha('resource:second-vault'))).source_id, vault.source_id, 'two machines share one logical knowledge source');
    const staleResolved = await resolvedAccess(sha('resource:vault-a-stale'));
    assert.deepEqual([staleResolved.source_state, staleResolved.source_id, staleResolved.current_configuration], ['source', vault.source_id, false],
      'rows classified under an earlier configuration stay resolvable but are flagged');
    assert.equal((await resolvedAccess(sha('resource:vault-b'))).source_state, 'unassigned');
    const [rawAccess] = await sql`SELECT resource_key, configuration_version FROM personal_hub.resource_accesses WHERE account_id = ${account} AND semantic_key = ${sha('resource:vault-a-stale')}`;
    assert.deepEqual([rawAccess.resource_key, rawAccess.configuration_version], ['obsidian.primary', 'resources.v0'], 'supersession never rewrites raw accesses');
    // The ordinary reconfiguration path: the companion replays and re-emits the same access under
    // a new token. Same semantic key and observed_at, so only receipt order makes it canonical.
    const replayedAccess = { ...resourceAccess(bindingId, 'vault-a'), record_id: randomUUID(), configuration_version: 'cfg:next' };
    assert.equal((await store.ingestUsage(current, envelope({ records: [replayedAccess] }))).accepted.records, 1, 'a re-classified access is a revision');
    const [vaultARevisions] = await sql`SELECT count(*)::int AS rows FROM personal_hub.resource_accesses WHERE account_id = ${account} AND semantic_key = ${sha('resource:vault-a')}`;
    assert.equal(Number(vaultARevisions.rows), 2, 'both revisions stay in the ledger');
    const replayedResolved = await resolvedAccess(sha('resource:vault-a'));
    const [replayedIdentity] = await sql`SELECT configuration_version FROM personal_hub.usage_knowledge_source_identities WHERE id = ${firstPrimary.id}`;
    assert.deepEqual([replayedIdentity.configuration_version, replayedResolved.current_configuration, replayedResolved.source_id],
      ['cfg:next', true, vault.source_id], 'the newest receipt names the current configuration and stays canonical');
    const [replayedCanonical] = await sql`SELECT configuration_version FROM personal_hub.resource_access_source_resolution WHERE account_id = ${account} AND semantic_key = ${sha('resource:vault-a')}`;
    assert.equal(replayedCanonical.configuration_version, 'cfg:next');

    const knowledgeMapped = await store.listKnowledgeSources();
    const primaryVault = knowledgeMapped.per_source.find(entry => entry.source_id === vault.source_id)!;
    assert.deepEqual([primaryVault.label, primaryVault.identity_ids.slice().sort(), primaryVault.accesses, primaryVault.distinct_invocations,
      primaryVault.distinct_sessions, primaryVault.distinct_agents],
      ['Primary vault renamed', [firstPrimary.id, secondPrimary.id].sort(), 2, 2, 2, 2], 'a source sums current rows across machines');
    assert.deepEqual(primaryVault.by_access_kind, { read: 2, search: 0, write: 0, unknown: 0 });
    assert.deepEqual(primaryVault.by_evidence_basis, { explicit_argument: 2, connector: 0, indirect_shell: 0, unknown: 0 });
    assert.deepEqual(primaryVault.by_outcome, { succeeded: 2, failed: 0, denied: 0, cancelled: 0, unknown: 0 });
    assert.deepEqual(primaryVault.top_tools, [{ tool_name: 'Grep', tool_class: 'builtin', invocations: 1 }, { tool_name: 'Read', tool_class: 'builtin', invocations: 1 }]);
    assert.deepEqual([primaryVault.first_observed, primaryVault.last_observed], ['2026-09-02T03:20:00.000Z', '2026-09-02T03:20:00.000Z']);
    const referenceBucket = knowledgeMapped.per_source.find(entry => entry.identity_ids.includes(firstReference.id))!;
    assert.deepEqual([referenceBucket.source_id, referenceBucket.label, referenceBucket.resource_key, referenceBucket.machine_label, referenceBucket.accesses, referenceBucket.distinct_sessions],
      [null, null, 'obsidian.reference', 'test-mac', 1, 1]);
    assert.equal(knowledgeMapped.per_source.some(entry => 'path' in entry || 'roots' in entry), false);
    const ownAccesses = await sql`SELECT count(*)::int AS rows, count(DISTINCT invocation_key)::int AS invocations
      FROM personal_hub.resource_access_source_resolution WHERE account_id = ${account} AND current_configuration`;
    assert.deepEqual([Number(ownAccesses[0].rows), Number(ownAccesses[0].invocations)], [3, 2], 'one invocation touching two sources is two rows and one call');
    assert.ok(knowledgeMapped.coverage.evidence.overlapping_invocations >= 1, 'overlap is disclosed as a count of calls with several rows');
    assert.ok(knowledgeMapped.coverage.evidence.earlier_configuration_accesses >= 1);
    assert.ok(knowledgeMapped.coverage.evidence.access_rows >= knowledgeMapped.coverage.evidence.canonical_accesses);
    assert.equal(knowledgeMapped.coverage.evidence.canonical_accesses,
      knowledgeMapped.coverage.evidence.current_configuration_accesses + knowledgeMapped.coverage.evidence.earlier_configuration_accesses + knowledgeMapped.coverage.resolved.unknown,
      'canonical accesses split into current, earlier, and unknown without remainder');
    assert.deepEqual(knowledgeMapped.coverage.detection.filter(entry => entry.install_id === install.id).map(entry => [entry.adapter, entry.state, entry.detail_code]),
      [['claude_execution', 'partial', 'indirect_access_unknown']], 'detection coverage is the state and code the install last reported');
    assert.equal(knowledgeMapped.coverage.detection.some(entry => entry.install_id === secondInstall.id), false, 'no resource capability reported means no detection claim');

    await store.updateKnowledgeSources({ action: 'unmap', identity_ids: [secondPrimary.id] });
    assert.equal((await resolvedAccess(sha('resource:second-vault'))).source_state, 'unassigned');
    assert.equal((await resolvedAccess(sha('resource:vault-a'))).source_id, vault.source_id, 'unmapping one machine leaves the other mapped');
    const sourceHistory = await sql`SELECT source_id FROM personal_hub.usage_knowledge_source_mapping_revisions
      WHERE identity_id = ${secondPrimary.id} ORDER BY revision_order`;
    assert.deepEqual(sourceHistory.map(row => row.source_id), [vault.source_id, null], 'mapping history is append-only');
    const knowledgeAfter = await store.listKnowledgeSources();
    assert.equal(knowledgeAfter.per_source.find(entry => entry.source_id === vault.source_id)!.accesses, 1);
    assert.deepEqual(ownIdentities(knowledgeAfter).map(item => [item.resource_key, item.install_id, item.source_id]).sort(),
      [['obsidian.primary', install.id, vault.source_id], ['obsidian.primary', secondInstall.id, null], ['obsidian.reference', install.id, null]].sort());

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
    const browserTool = { ...toolEvent(browserBinding, 'browser-tool', 'browser-tool'), adapter: 'claude_browser', channel: 'browser_session' };
    const browserReading = reading(browserBinding, 'claude_browser', 'browser_session', 'web_backend');
    const companionAdapter = reading(browserBinding, 'claude_execution', 'hook_snapshot', 'statusline', '2026-09-02T03:21:00.000Z');
    const browserResult = await store.ingestUsage(browser, envelope({ buckets: [{ binding_id: browserBinding, bucket }], records: [browserRequest, browserTool, browserReading, companionAdapter] }));
    assert.equal(browserResult.accepted.buckets, 0, 'a browser install cannot submit buckets');
    assert.equal(browserResult.accepted.records, 1);
    assert.deepEqual(reasons(browserResult, [browserRequest, browserTool, browserReading, companionAdapter]),
      ['record_type_not_allowed_for_install', 'record_type_not_allowed_for_install', 'accepted', 'adapter_not_allowed_for_install']);

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
    // Eleven canonical requests reached this account through enabled bindings: msg, detail, zero, worktree, same-folder,
    // native, legacy, one project-revision pair, the two second-machine requests, and msg-2; nothing rejected counts.
    const reconciled = await store.reconcile(account, '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z');
    assert.equal(reconciled.covered_requests.requests, 11, 'revisions of one request are one covered request');
    assert.equal(reconciled.unattributed.total, 150 - (155 + 0 + 9 * 150), 'reported account usage stays independent from covered request revisions');

    // Each binding reports the newest evidence in its ledgers separately from collector contact.
    const claudeBinding = mine.bindings.find(b => b.id === bindingId)!, codexBinding = mine.bindings.find(b => b.id === codexId)!;
    assert.deepEqual(claudeBinding.last_observation, { allowance: null, requests: '2026-09-02T03:20:00.000Z' });
    assert.deepEqual(claudeBinding.last_received, { allowance: null });
    assert.deepEqual(codexBinding.last_observation, { allowance: { observed_at: '2026-09-02T03:20:00.000Z', resets_at: '2026-09-02T05:00:00.000Z', reader: 'embedded' }, requests: null });
    assert.ok(codexBinding.last_received.allowance, 'the newest receipt of a reading is reported beside its observation');
    assert.equal(mine.cadence_minutes, 60);
    assert.equal(mine.last_run_at, mine.latest_run!.finished_at);
    assert.deepEqual(mine.accepted_by_type, mine.latest_run!.accepted_by_type);
    assert.equal(mine.latest_run!.accepted_by_type['activity.request'].accepted, 1, 'the latest run counts its accepted uploads per type');

    // The bodies of one run merge their per-type counts key-wise, including records that failed to parse.
    const sharedRun = run();
    const laterReading = reading(codexId, 'codex_execution', 'local_file', 'embedded', '2026-09-02T03:40:00.000Z', 35);
    const foreignReading = reading(randomUUID(), 'codex_execution', 'local_file', 'embedded', '2026-09-02T03:41:00.000Z');
    const bodyOne = await store.ingestUsage(current, envelope({ run: sharedRun, records: [laterReading, foreignReading] }), [{ record_id: randomUUID(), reason: 'invalid' }]);
    assert.deepEqual([bodyOne.accepted.records, bodyOne.rejected.length], [1, 2]);
    const bodyTwo = await store.ingestUsage(current, envelope({ run: sharedRun, records: [laterReading, request(bindingId, 'claude_execution', 'run-two')] }));
    assert.deepEqual([bodyTwo.accepted.records, bodyTwo.duplicates], [1, 1]);
    const [mergedRun] = await sql`SELECT accepted_by_type, accepted_records, rejected_records FROM personal_hub.companion_runs WHERE run_id = ${sharedRun.run_id}`;
    assert.deepEqual(mergedRun.accepted_by_type, {
      'allowance.reading': { accepted: 1, duplicate: 1, rejected: 1 },
      'activity.request': { accepted: 1, duplicate: 0, rejected: 0 },
      invalid: { accepted: 0, duplicate: 0, rejected: 1 },
    }, 'two bodies of one run sum per type');
    assert.deepEqual([Number(mergedRun.accepted_records), Number(mergedRun.rejected_records)], [2, 2]);

    // A coverage-only receipt advances collector contact and nothing else: ledgers and observations stay put.
    await sql`UPDATE personal_hub.telemetry_sources SET last_seen_at = '2026-09-02T04:00:00Z' WHERE id = ${codexBinding.source_id}`;
    await sql`UPDATE personal_hub.companion_installs SET last_seen_at = '2026-09-02T04:00:00Z' WHERE id = ${install.id}`;
    const ledgerCount = async () => Number((await sql`SELECT
        (SELECT count(*) FROM personal_hub.allowance_readings WHERE account_id IN (${account}, ${codexAccount}))
        + (SELECT count(*) FROM personal_hub.activity_requests WHERE account_id = ${account}) AS rows`)[0].rows);
    const ledgerBefore = await ledgerCount();
    const coverageOnly = await store.ingestUsage(current, envelope({ coverage: [coverage('codex_execution'), coverage('claude_execution')] }));
    assert.deepEqual([coverageOnly.accepted, coverageOnly.duplicates], [{ buckets: 0, records: 0 }, 0]);
    assert.equal(await ledgerCount(), ledgerBefore, 'a coverage-only envelope writes no ledger rows');
    const afterCoverage = (await store.listInstalls()).installs.find(i => i.id === install.id)!;
    const codexAfter = afterCoverage.bindings.find(b => b.id === codexId)!;
    assert.deepEqual(codexAfter.last_observation.allowance, { observed_at: '2026-09-02T03:40:00.000Z', resets_at: '2026-09-02T05:00:00.000Z', reader: 'embedded' },
      'the newest observation is the reading accepted before the coverage-only receipt');
    assert.ok(Date.parse(codexAfter.last_seen_at!) > Date.parse('2026-09-02T04:00:00Z'), 'collector contact still advances');
    assert.ok(Date.parse(afterCoverage.last_seen_at!) > Date.parse('2026-09-02T04:00:00Z'));

    // The current reading per meter: newest observation among supported readers, ties by reader rank, unknown readers never winning.
    const weekly = (reader: string, observed_at: string, value: number, basis = 'reported') => ({ ...reading(bindingId, 'claude_execution', 'hook_snapshot', reader, observed_at, value),
      basis, meter_key: 'seven_day', label: reader === 'web_backend' ? 'Weekly · all models' : 'Claude · weekly', window_minutes: 10080, resets_at: inHours(2), raw_window_id: 'seven_day' });
    const tieAt = minutesAgo(125);
    const selection = await store.ingestUsage(current, envelope({ records: [
      weekly('embedded', minutesAgo(130), 39), weekly('statusline', tieAt, 40, 'exact'), weekly('web_backend', tieAt, 41, 'estimated'), weekly('oauth_usage', minutesAgo(100), 60)] }));
    assert.equal(selection.accepted.records, 4);
    const currentMeter = (dashboard: Awaited<ReturnType<typeof store.usageDashboard>>) =>
      (dashboard.allowance as Record<string, unknown>[]).find(row => row.account_id === account && row.meter_key === 'seven_day')!;
    const chosen = currentMeter(await store.usageDashboard());
    assert.deepEqual([chosen.reader, chosen.value, chosen.basis, chosen.observed_at, chosen.raw_window_id, chosen.label, chosen.cadence_minutes, chosen.stale, chosen.stale_reason],
      ['statusline', 40, 'exact', tieAt, 'seven_day', 'Claude · weekly', 60, false, null],
      'an exact tie falls to reader rank, a newer unknown reader never wins, and 125 minutes is fresh at cadence 60');
    assert.equal(chosen.age_minutes, 125);
    const [storedBasis] = await sql`SELECT basis FROM personal_hub.allowance_readings WHERE account_id = ${account} AND meter_key = 'seven_day' AND reader = 'web_backend'`;
    assert.equal(storedBasis.basis, 'estimated', 'the readings ledger keeps the wire basis');
    assert.deepEqual((await sql`SELECT reader, basis FROM personal_hub.allowance_percent_view WHERE account_id = ${account} AND window_key = 'seven_day' ORDER BY reader`).map(r => [r.reader, r.basis]),
      [['embedded', 'reported'], ['oauth_usage', 'reported'], ['statusline', 'exact'], ['web_backend', 'estimated']], 'the compatibility view exposes basis');
    await store.updateInstall({ id: install.id, action: 'override', settings: { cadence_minutes: 15 } });
    const faster = currentMeter(await store.usageDashboard());
    assert.deepEqual([faster.reader, faster.cadence_minutes, faster.stale, faster.stale_reason], ['statusline', 15, true, 'age'],
      'the same reading is stale once the install collects every fifteen minutes');
    assert.equal((await store.listInstalls()).installs.find(i => i.id === install.id)!.cadence_minutes, 15);

    // Recency beats rank: a strictly newer reading from a lower-ranked supported reader is current with its own label
    // and basis, and the statusline is current again only once it is the newest. Ingestion leaves the thirty-second
    // dashboard cache alone, so each read re-applies the override to invalidate it first.
    const readDashboard = async () => { await store.updateInstall({ id: install.id, action: 'override', settings: { cadence_minutes: 15 } }); return store.usageDashboard(); };
    const newerWeb = minutesAgo(90);
    assert.equal((await store.ingestUsage(current, envelope({ records: [weekly('web_backend', newerWeb, 45, 'estimated')] }))).accepted.records, 1);
    const web = currentMeter(await readDashboard());
    assert.deepEqual([web.reader, web.value, web.basis, web.observed_at, web.label, web.raw_window_id, web.stale, web.stale_reason],
      ['web_backend', 45, 'estimated', newerWeb, 'Weekly · all models', 'seven_day', false, null], 'a strictly newer lower-ranked supported reading wins with its own label and basis');
    const newerStatusline = minutesAgo(80);
    assert.equal((await store.ingestUsage(current, envelope({ records: [weekly('statusline', newerStatusline, 46, 'exact')] }))).accepted.records, 1);
    const back = currentMeter(await readDashboard());
    assert.deepEqual([back.reader, back.value, back.basis, back.observed_at, back.label], ['statusline', 46, 'exact', newerStatusline, 'Claude · weekly'],
      'the statusline is current again by recency once the web reading is the older one');

    // Overlapping meters of one account are separate rows: the five-hour and weekly windows of the Claude account, and the
    // Codex Spark weekly window beside the Codex primary window, each keep the producer's label, raw window id, and length.
    const meter = (binding_id: string, adapter: string, reader: string, meter_key: string, label: string, window_minutes: number, raw_window_id: string, value: number, resets_at: string) =>
      ({ ...reading(binding_id, adapter, adapter === 'codex_execution' ? 'local_file' : 'hook_snapshot', reader, minutesAgo(10), value), meter_key, label, window_minutes, raw_window_id, resets_at });
    const overlapping = await store.ingestUsage(current, envelope({ records: [
      meter(bindingId, 'claude_execution', 'statusline', 'five_hour', 'Claude · 5h', 300, 'five_hour', 20, inHours(3)),
      meter(bindingId, 'claude_execution', 'statusline', 'seven_day', 'Claude · weekly', 10080, 'seven_day', 47, inHours(100)),
      meter(codexId, 'codex_execution', 'embedded', 'codex_spark:10080', 'Codex Spark · weekly', 10080, 'secondary', 12, inHours(100)),
    ] }));
    assert.equal(overlapping.accepted.records, 3);
    const currentRows = (await readDashboard()).allowance as Record<string, unknown>[];
    const meters = (id: string) => currentRows.filter(row => row.account_id === id).map(row => [row.meter_key, row.label, row.raw_window_id, row.window_minutes, row.value, row.reader]).sort();
    assert.deepEqual(meters(account), [
      ['five_hour', 'Claude · 5h', 'five_hour', 300, 20, 'statusline'],
      ['seven_day', 'Claude · weekly', 'seven_day', 10080, 47, 'statusline'],
    ], 'one current row per meter key, with the producer label, raw window id, and window length intact');
    assert.deepEqual(meters(codexAccount), [
      ['codex_spark:10080', 'Codex Spark · weekly', 'secondary', 10080, 12, 'embedded'],
      ['five_hour', 'Claude · 5h', 'five_hour', 300, 35, 'embedded'],
    ], 'the Spark window is its own meter beside the primary window');
    const viewMeters = async (id: string) => (await sql`SELECT DISTINCT ON (window_key) window_key, label, window_minutes, used_percent FROM personal_hub.allowance_percent_view
      WHERE account_id = ${id} ORDER BY window_key, observed_at DESC`).map(r => [r.window_key, r.label, Number(r.window_minutes), Number(r.used_percent)]);
    assert.deepEqual(await viewMeters(account), [['five_hour', 'Claude · 5h', 300, 20], ['seven_day', 'Claude · weekly', 10080, 47]], 'the compatibility view keeps overlapping windows apart');
    assert.deepEqual(await viewMeters(codexAccount), [['codex_spark:10080', 'Codex Spark · weekly', 10080, 12], ['five_hour', 'Claude · 5h', 300, 35]]);

    // One identity binds once per install and provider: a sibling binding cannot claim a hash already held.
    const siblingAccount = `claude-${randomUUID().slice(0, 8)}`;
    const sibling = (await store.createBinding(current, { account_id: siblingAccount, provider: 'claude', account_label: 'Claude sibling', identity_hash: null })).binding.binding_id;
    await assert.rejects(store.confirmIdentity(current, sibling, { identity_hash: sha('identity-2') }),
      (error: unknown) => error instanceof RequestError && error.status === 409 && /identity_taken/.test(error.message),
      'the hash the first Claude binding holds is refused with its own reason');
    assert.equal((await sql`SELECT identity_hash FROM personal_hub.companion_bindings WHERE id = ${sibling}`)[0].identity_hash, null);
    assert.equal((await store.confirmIdentity(current, sibling, { identity_hash: sha('identity-sibling') })).identity_hash, sha('identity-sibling'));

    // The install-row lock makes the same rule hold across concurrent server
    // instances: only one of two new accounts may claim a previously unseen hash.
    const racedIdentity = sha('identity-race');
    const racedAccounts = [`claude-${randomUUID().slice(0, 8)}`, `claude-${randomUUID().slice(0, 8)}`];
    const raced = await Promise.allSettled(racedAccounts.map((account_id, index) => store.createBinding(current, {
      account_id, provider: 'claude', account_label: `Claude race ${index + 1}`, identity_hash: racedIdentity,
    })));
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
    const racedRejection = raced.find(result => result.status === 'rejected');
    assert.ok(racedRejection?.status === 'rejected' && racedRejection.reason instanceof RequestError &&
      racedRejection.reason.status === 409 && /identity_taken/.test(racedRejection.reason.message));
    assert.equal(Number((await sql`SELECT count(*) FROM personal_hub.companion_bindings WHERE install_id = ${install.id} AND identity_hash = ${racedIdentity}`)[0].count), 1);

    // A duplicate that predates the refusal is disclosed on every binding that shares its hash with an enabled sibling,
    // so the Observatory can say which binding to re-confirm; a distinct hash clears the flag.
    const duplicates = async () => Object.fromEntries((await store.listInstalls()).installs.flatMap(i => i.bindings.map(b => [b.id, b.duplicate_identity] as const)));
    await sql`UPDATE personal_hub.companion_bindings SET identity_hash = ${sha('identity-2')} WHERE id = ${sibling}`;
    const seeded = await duplicates();
    assert.deepEqual([seeded[bindingId], seeded[sibling], seeded[codexId], seeded[secondBinding]], [true, true, false, false],
      'both Claude bindings of the install share the hash; another provider and another install do not');
    await store.updateInstall({ id: install.id, action: 'binding_disable', binding_id: sibling });
    const oneDisabled = await duplicates();
    assert.deepEqual([oneDisabled[bindingId], oneDisabled[sibling]], [false, true], 'only an enabled sibling makes a binding ambiguous');
    await store.updateInstall({ id: install.id, action: 'binding_enable', binding_id: sibling });
    await sql`UPDATE personal_hub.companion_bindings SET identity_hash = ${sha('identity-sibling')} WHERE id = ${sibling}`;
    const distinct = await duplicates();
    assert.deepEqual([distinct[bindingId], distinct[sibling]], [false, false]);

    // The browser reader: an empty post is contact, not a reading.
    const { createTelemetryStore } = await import('../lib/telemetry-store');
    const telemetry = createTelemetryStore(() => sql);
    const browserKey = randomBytes(32).toString('base64url'), browserSourceId = randomUUID();
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash) VALUES (${browserSourceId}, ${account}, 'Chrome · test', 'browser', ${sha(browserKey)})`;
    const browserSource = await telemetry.telemetrySource(bearer(browserKey));
    assert.deepEqual([browserSource.id, browserSource.mode, browserSource.provider], [browserSourceId, 'browser', 'claude']);
    const post = (quotas: unknown[]) => telemetrySchema.parse({ schema_version: 1, observed_at: '2026-09-02T06:00:00Z', buckets: [], quotas, coverage: { collector_version: 'browser-1.0.0' } });
    const sample = { window_key: 'five_hour', label: '5-hour allowance', observed_at: '2026-09-02T06:00:00Z', used_percent: 12, resets_at: '2026-09-02T08:00:00Z', window_minutes: 300 };
    assert.equal((await telemetry.ingestBrowserQuotas(browserSource, post([sample]))).quotas, 1);
    await assert.rejects(telemetry.ingestBrowserQuotas(browserSource, telemetrySchema.parse({ ...post([]), buckets: [bucket] })), /quota readings only/);
    const browserConnection = async () => (await telemetry.browserConnections()).sources.find(s => s.id === browserSourceId)!;
    const withReading = await browserConnection();
    assert.equal(withReading.last_observation, '2026-09-02T06:00:00.000Z');
    assert.ok(withReading.last_received && withReading.last_seen_at);
    await sql`UPDATE personal_hub.telemetry_sources SET last_seen_at = '2026-09-02T06:30:00Z' WHERE id = ${browserSourceId}`;
    assert.deepEqual((await telemetry.ingestBrowserQuotas(browserSource, post([]))).quotas, 0);
    const afterEmpty = await browserConnection();
    assert.ok(Date.parse(afterEmpty.last_seen_at!) > Date.parse('2026-09-02T06:30:00Z'), 'an empty post advances last contact');
    assert.deepEqual([afterEmpty.last_observation, afterEmpty.last_received], [withReading.last_observation, withReading.last_received], 'but never the reading');
    assert.equal((await telemetry.browserConnections()).cadence_minutes, 60, 'the extension reads hourly');

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
    for (const table of ['activity_requests', 'account_usage_buckets', 'allowance_readings', 'money_entries',
      'agent_events', 'tool_events', 'resource_accesses']) {
      await assert.rejects(app.unsafe(`UPDATE personal_hub.${table} SET content_hash = content_hash WHERE false`), /permission denied/, `${table} update`);
      await assert.rejects(app.unsafe(`DELETE FROM personal_hub.${table} WHERE false`), /permission denied/, `${table} delete`);
    }
    for (const [table, column] of [['usage_project_mapping_revisions', 'project_id = project_id'], ['usage_knowledge_source_mapping_revisions', 'source_id = source_id']]) {
      await assert.rejects(app.unsafe(`UPDATE personal_hub.${table} SET ${column} WHERE false`), /permission denied/, `${table} update`);
      await assert.rejects(app.unsafe(`DELETE FROM personal_hub.${table} WHERE false`), /permission denied/, `${table} delete`);
    }
    for (const [table, column] of [['collection_settings', 'settings_version = settings_version'], ['companion_installs', 'paused = paused'], ['companion_bindings', 'enabled = enabled'], ['companion_pairing_codes', 'used_at = used_at']]) {
      await app.unsafe(`UPDATE personal_hub.${table} SET ${column} WHERE false`);
      await assert.rejects(app.unsafe(`DELETE FROM personal_hub.${table} WHERE false`), /permission denied/, `${table} delete`);
    }
    for (const [table, column] of [['usage_projects', 'label = label'], ['usage_project_identities', 'last_seen = last_seen'],
      ['usage_knowledge_sources', 'label = label, updated_at = updated_at'],
      ['usage_knowledge_source_identities', 'configuration_version = configuration_version, first_seen = first_seen, last_seen = last_seen']]) {
      await app.unsafe(`UPDATE personal_hub.${table} SET ${column} WHERE false`);
      await assert.rejects(app.unsafe(`DELETE FROM personal_hub.${table} WHERE false`), /permission denied/, `${table} delete`);
    }
    await assert.rejects(app`UPDATE personal_hub.usage_project_identities SET evidence_key = evidence_key WHERE false`, /permission denied/,
      'the app can update sighting bounds but cannot rewrite identity evidence');
    for (const column of ['resource_key = resource_key', 'install_id = install_id', 'id = id']) {
      await assert.rejects(app.unsafe(`UPDATE personal_hub.usage_knowledge_source_identities SET ${column} WHERE false`), /permission denied/,
        'the app can update sightings and the configuration version but cannot rewrite a knowledge-source identity');
    }
    await assert.rejects(app`UPDATE personal_hub.usage_knowledge_sources SET created_at = created_at WHERE false`, /permission denied/);
    const writableProject = randomUUID(), writableIdentity = randomUUID();
    await app`INSERT INTO personal_hub.usage_projects (id, label) VALUES (${writableProject}, 'Application role project')`;
    await app`INSERT INTO personal_hub.usage_project_identities
      (id, basis, evidence_key, install_id, first_seen, last_seen)
      VALUES (${writableIdentity}, 'working_directory', ${sha(writableIdentity)}, '00000000-0000-4000-8000-000000000302',
        '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
    const [appendedMapping] = await app`INSERT INTO personal_hub.usage_project_mapping_revisions (id, identity_id, project_id)
      VALUES (${randomUUID()}, ${writableIdentity}, ${writableProject}) RETURNING revision_order`;
    assert.ok(Number(appendedMapping.revision_order) > 0, 'the application role can allocate database mapping order');
    const writableSource = randomUUID(), writableResource = randomUUID();
    await app`INSERT INTO personal_hub.usage_knowledge_sources (id, label) VALUES (${writableSource}, 'Application role source')`;
    await app`INSERT INTO personal_hub.usage_knowledge_source_identities
      (id, install_id, resource_key, configuration_version, first_seen, last_seen)
      VALUES (${writableResource}, '00000000-0000-4000-8000-000000000302', ${`app.${writableResource.slice(0, 8)}`}, 'cfg:0123456789abcdef',
        '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`;
    await app`UPDATE personal_hub.usage_knowledge_source_identities SET configuration_version = 'cfg:fedcba9876543210', last_seen = '2026-09-01T00:01:00Z'
      WHERE id = ${writableResource}`;
    const [appendedSourceMapping] = await app`INSERT INTO personal_hub.usage_knowledge_source_mapping_revisions (id, identity_id, source_id)
      VALUES (${randomUUID()}, ${writableResource}, ${writableSource}) RETURNING revision_order`;
    assert.ok(Number(appendedSourceMapping.revision_order) > 0, 'the application role can allocate knowledge-source mapping order');
    await app`SELECT count(*) FROM personal_hub.allowance_percent_view`;
    await app`SELECT count(*) FROM personal_hub.activity_request_project_resolution`;
    await app`SELECT count(*) FROM personal_hub.resource_access_source_resolution`;
    await app`SELECT count(*) FROM personal_hub.token_bucket_revisions`;
  } finally { await app.end({ timeout: 1 }); }
});
