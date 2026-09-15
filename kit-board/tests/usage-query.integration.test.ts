import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { RequestError, stableJson } from '../lib/contracts';

const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
const hashOf = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const NOW = Date.parse('2026-09-14T20:30:00Z');   // 15:30 in Chicago
const SEPTEMBER = { preset: 'custom' as const, start: '2026-09-01T05:00:00Z', end: '2026-09-14T20:30:00Z' };

maybe('the filtered usage query reconciles every breakdown to one selected scope', async () => {
  const { createUsageQuery, parseUsageQuery } = await import('../lib/usage-query');
  const sql = postgres(url!, options);
  const layer = createUsageQuery(() => sql);
  const suffix = randomUUID().slice(0, 8);
  const claude = `q-claude-${suffix}`, codex = `q-codex-${suffix}`;
  const v1Source = randomUUID(), claudeSource = randomUUID(), codexSource = randomUUID(), install = randomUUID(), claudeBinding = randomUUID(), codexBinding = randomUUID();
  const subject = `legacy-box-${suffix}`, otherSubject = `other-box-${suffix}`;
  const mainKey = sha(`agent:main:${suffix}`), childKey = sha(`agent:child:${suffix}`), projectKey = sha(`project:${suffix}`);
  try {
    await sql`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${claude}, 'claude', 'Claude fixture'), (${codex}, 'codex', 'Codex fixture')`;
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash, last_seen_at, disabled) VALUES
      (${v1Source}, ${claude}, 'retired host', 'local', ${sha(randomUUID())}, '2026-09-13T05:00:00Z', true),
      (${claudeSource}, ${claude}, 'companion host', 'companion', ${sha(randomUUID())}, '2026-09-14T20:10:00Z', false),
      (${codexSource}, ${codex}, 'companion host', 'companion', ${sha(randomUUID())}, '2026-09-14T20:10:00Z', false)`;
    await sql`INSERT INTO personal_hub.companion_installs (id, machine_label, kind, platform, arch, key_hash) VALUES (${install}, 'companion host', 'companion', 'linux', 'amd64', ${sha(randomUUID())})`;
    await sql`INSERT INTO personal_hub.companion_bindings (id, install_id, account_id, source_id, provider, identity_hash) VALUES
      (${claudeBinding}, ${install}, ${claude}, ${claudeSource}, 'claude', ${sha('id-claude')}), (${codexBinding}, ${install}, ${codex}, ${codexSource}, 'codex', ${sha('id-codex')})`;

    // Hourly buckets: a v1 and a companion revision of one key (the companion saw more), plus keys before the range and in the current hour.
    const bucket = (account: string, source: string, session: string, hour: string, model: string, calls: number, total: number, cached = 0) => {
      const b = { session_hash: sha(`${session}:${suffix}`), hour, model, input_tokens: total - cached, cached_tokens: cached, cache_write_tokens: 0, output_tokens: 0, total_tokens: total, calls };
      return sql`INSERT INTO personal_hub.token_bucket_revisions ${sql({ id: randomUUID(), account_id: account, source_id: source, observed_at: hour, content_hash: hashOf(b), ...b })}`;
    };
    await bucket(claude, v1Source, 'a1', '2026-09-02T14:00:00Z', 'm1', 2, 100);
    await bucket(claude, claudeSource, 'a1', '2026-09-02T14:00:00Z', 'm1', 3, 170, 20);
    await bucket(claude, claudeSource, 'a2', '2026-09-03T14:00:00Z', 'm2', 1, 40);
    await bucket(codex, codexSource, 'b1', '2026-09-03T15:00:00Z', 'm3', 4, 400);
    await bucket(codex, codexSource, 'b0', '2026-08-31T14:00:00Z', 'm3', 1, 10);
    await bucket(claude, claudeSource, 'a3', '2026-09-14T20:00:00Z', 'm1', 1, 5);

    // Project registry: one mapped working-directory identity; knowledge registry: one mapped vault.
    const projectId = randomUUID(), identityId = randomUUID(), vaultId = randomUUID(), vaultIdentity = randomUUID();
    await sql`INSERT INTO personal_hub.usage_projects (id, label) VALUES (${projectId}, 'Fixture project')`;
    await sql`INSERT INTO personal_hub.usage_project_identities (id, basis, evidence_key, install_id, first_seen, last_seen) VALUES (${identityId}, 'working_directory', ${projectKey}, ${install}, '2026-09-02T14:10:00Z', '2026-09-02T14:20:00Z')`;
    await sql`INSERT INTO personal_hub.usage_project_mapping_revisions (id, identity_id, project_id) VALUES (${randomUUID()}, ${identityId}, ${projectId})`;
    await sql`INSERT INTO personal_hub.usage_knowledge_sources (id, label) VALUES (${vaultId}, 'Fixture vault')`;
    await sql`INSERT INTO personal_hub.usage_knowledge_source_identities (id, install_id, resource_key, configuration_version, first_seen, last_seen) VALUES (${vaultIdentity}, ${install}, ${`vault.${suffix}`}, 'cfg:1', '2026-09-02T14:10:00Z', '2026-09-02T14:10:00Z')`;
    await sql`INSERT INTO personal_hub.usage_knowledge_source_mapping_revisions (id, identity_id, source_id) VALUES (${randomUUID()}, ${vaultIdentity}, ${vaultId})`;

    // Requests: main and child in one conversation on the project, a desktop request with no project, and a second revision of the first request.
    const request = (semantic: string, session: string, at: string, model: string, tokens: [number, number, number, number], extra: Record<string, unknown>) =>
      sql`INSERT INTO personal_hub.activity_requests ${sql({ id: randomUUID(), account_id: claude, binding_id: claudeBinding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file',
        record_id: randomUUID(), semantic_key: sha(`${semantic}:${suffix}`), product: 'claude_code', surface: 'cli', execution_host: 'local', session_hash: sha(`${session}:${suffix}`), session_identity: 'provider',
        model_actual: model, observed_at: at, input_fresh_tokens: tokens[0], input_cached_tokens: tokens[1], input_cache_write_tokens: tokens[2], output_tokens: tokens[3],
        basis: 'exact', outcome: 'completed', parser_version: '2.0.0', content_hash: sha(randomUUID()), ...extra })}`;
    const main = { agent_key: mainKey, agent_identity_basis: 'provider', parent_agent_identity_basis: 'none', agent_class: 'main', agent_depth: 0 };
    const child = { agent_key: childKey, agent_identity_basis: 'provider', parent_agent_key: mainKey, parent_agent_identity_basis: 'provider', agent_class: 'builtin', agent_name: 'Explore', agent_depth: 1 };
    const onProject = { project_basis: 'working_directory', project_key: projectKey, project_hash: projectKey };
    await request('r1', 'a1', '2026-09-02T14:10:00Z', 'm1', [100, 0, 0, 50], { reasoning_effort: 'high', ...main, ...onProject });
    await request('r1', 'a1', '2026-09-02T14:11:00Z', 'm1', [100, 0, 0, 50], { reasoning_effort: 'high', ...main, ...onProject, client_version: 'later' });
    await request('r2', 'a1', '2026-09-02T14:20:00Z', 'm1', [10, 0, 0, 10], { ...child, ...onProject });
    await request('r3', 'a2', '2026-09-03T14:05:00Z', 'm2', [30, 0, 0, 10], { reasoning_effort: 'low', surface: 'desktop', project_basis: 'none', channel: 'app_server' });
    // A lower-ranked, later revision of r3 that could not read the model: never canonical, so never a match for Unknown.
    await request('r3', 'a2', '2026-09-03T14:06:00Z', null as unknown as string, [30, 0, 0, 10], { reasoning_effort: 'low', surface: 'desktop', project_basis: 'none' });

    // Lifecycle and tool evidence: one spawn, one started child, two invocations (one with a result and a duplicate revision), one vault access.
    const event = (kind: string, seed: string, agent: Record<string, unknown>, outcome = 'succeeded') =>
      sql`INSERT INTO personal_hub.agent_events ${sql({ id: randomUUID(), account_id: claude, binding_id: claudeBinding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file', record_id: randomUUID(),
        semantic_key: sha(`${seed}:${suffix}`), event_kind: kind, session_hash: sha(`a1:${suffix}`), outcome, basis: 'exact', observed_at: '2026-09-02T14:15:00Z', parser_version: '2.0.0', content_hash: sha(randomUUID()), ...agent })}`;
    await event('spawn', 'spawn-1', { agent_key: childKey, agent_identity_basis: 'provider', parent_agent_key: mainKey, parent_agent_identity_basis: 'provider', agent_class: 'builtin', agent_name: 'Explore', agent_depth: 1 });
    await event('start', 'start-1', { agent_key: childKey, agent_identity_basis: 'provider', parent_agent_key: mainKey, parent_agent_identity_basis: 'provider', agent_class: 'builtin', agent_name: 'Explore', agent_depth: 1 });
    const tool = (kind: string, invocation: string, seed: string, caller: string, agent: string | null, name: string, outcome: string, at: string) =>
      sql`INSERT INTO personal_hub.tool_events ${sql({ id: randomUUID(), account_id: claude, binding_id: claudeBinding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file', record_id: randomUUID(),
        semantic_key: kind === 'invocation' ? sha(`tool:${invocation}:${suffix}`) : sha(`${seed}:${suffix}`), invocation_key: sha(`tool:${invocation}:${suffix}`), event_kind: kind, session_hash: sha(`a1:${suffix}`),
        caller_request_key: sha(`${caller}:${suffix}`), caller_agent_key: agent, tool_name: name, tool_class: 'builtin', outcome, basis: 'exact', observed_at: at, parser_version: '2.0.0', content_hash: sha(randomUUID()) })}`;
    await tool('invocation', 't1', 't1', 'r1', mainKey, 'Read', 'unknown', '2026-09-02T14:12:00Z');
    await tool('invocation', 't1', 't1', 'r1', mainKey, 'Read', 'unknown', '2026-09-02T14:12:30Z');
    await tool('result', 't1', 't1-result', 'r1', mainKey, 'Read', 'succeeded', '2026-09-02T14:12:40Z');
    await tool('invocation', 't2', 't2', 'r2', childKey, 'Bash', 'unknown', '2026-09-02T14:21:00Z');
    await sql`INSERT INTO personal_hub.resource_accesses ${sql({ id: randomUUID(), account_id: claude, binding_id: claudeBinding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file', record_id: randomUUID(),
      semantic_key: sha(`access:${suffix}`), invocation_key: sha(`tool:t1:${suffix}`), resource_key: `vault.${suffix}`, configuration_version: 'cfg:1', access_kind: 'read', evidence_basis: 'explicit_argument',
      outcome: 'succeeded', basis: 'exact', observed_at: '2026-09-02T14:12:00Z', parser_version: '2.0.0', content_hash: sha(randomUUID()) })}`;

    // Monthly snapshots: July for two subjects, September partial for the mapped one.
    const snapshot = (subjectKey: string, month: string, status: string, total: number, calls: number, daily: { date: string; total_tokens: number; calls: number }[], produced: string) =>
      sql`INSERT INTO personal_hub.report_revisions (id, kind, period_key, subject_key, producer_id, idempotency_key, title, produced_at, status, schema_version, coverage, payload, content_hash)
        VALUES (${randomUUID()}, 'usage', ${month}, ${subjectKey}, 'fixture', ${sha(randomUUID())}, ${`${subjectKey} · ${month}`}, ${produced}, ${status}, 1, '{}'::jsonb,
          ${sql.json({ machine_id: subjectKey, machine_name: 'Legacy box', report: { generated_at_local: produced, current: { month, totals: { total_tokens: total, calls, threads: 2 },
            exclusive_composition: { cached_input_tokens: 100, uncached_input_tokens: total - 300, reasoning_output_tokens: 50, nonreasoning_output_tokens: 150, unclassified_total_only_tokens: 0 }, daily } } })}, ${sha(randomUUID())})`;
    await snapshot(subject, '2026-07', 'partial', 900, 9, [{ date: '2026-07-10', total_tokens: 600, calls: 6 }], '2026-07-20T12:00:00Z');
    await snapshot(subject, '2026-07', 'complete', 1000, 10, [{ date: '2026-07-10', total_tokens: 600, calls: 6 }, { date: '2026-07-20', total_tokens: 400, calls: 4 }], '2026-08-01T12:00:00Z');
    await snapshot(otherSubject, '2026-07', 'complete', 500, 5, [], '2026-08-01T12:00:00Z');
    await snapshot(subject, '2026-09', 'partial', 300, 3, [{ date: '2026-09-05', total_tokens: 300, calls: 3 }], '2026-09-10T12:00:00Z');
    await layer.updateReportSubject({ subject_key: subject, account_id: claude, source_timezone: 'America/Chicago' });
    await assert.rejects(layer.updateReportSubject({ subject_key: `missing-${suffix}`, account_id: claude, source_timezone: null }), (e: unknown) => e instanceof RequestError && e.status === 404);
    await assert.rejects(layer.updateReportSubject({ subject_key: subject, account_id: 'no-such-account', source_timezone: null }), (e: unknown) => e instanceof RequestError && e.status === 404);
    const subjects = await layer.listReportSubjects();
    assert.deepEqual(subjects.subjects.filter(s => s.subject_key === subject).map(s => [s.account_id, s.source_timezone, s.revisions, s.first_month, s.last_month]), [[claude, 'America/Chicago', 3, '2026-07', '2026-09']]);

    const query = (extra: Record<string, unknown> = {}) => layer.usageQuery(parseUsageQuery(new URLSearchParams(Object.entries({ ...SEPTEMBER, accounts: `${claude},${codex}`, ...extra }).map(([k, v]) => [k, String(v)]))), { now: NOW });

    // 1. Unfiltered: buckets are the headline; request detail, projects, agents, tools, and knowledge describe their covered subset.
    const all = await query();
    assert.deepEqual([all.headline.total_tokens, all.headline.calls, all.headline.conversations, all.headline.basis, all.headline.unfilterable_tokens], [615, 9, 4, 'buckets', 0]);
    assert.deepEqual(all.headline.composition, { input_fresh: 595, input_cached: 20, input_cache_write: 0, output: 0, reasoning: null, unclassified: 0 });
    assert.equal(all.headline.last_observation, '2026-09-14T20:00:00.000Z');
    assert.deepEqual(all.by_model.map(m => [m.model, m.total_tokens, m.calls, m.basis]), [['m3', 400, 4, 'buckets'], ['m1', 175, 4, 'buckets'], ['m2', 40, 1, 'buckets']]);
    assert.equal(all.by_model.reduce((n, m) => n + m.total_tokens, 0), all.headline.total_tokens, 'models reconcile to the headline');
    assert.equal(all.series.points.length, 14);
    const day = (date: string) => all.series.points.find(p => p.start === date)!;
    assert.deepEqual([day('2026-09-02T05:00:00.000Z').total_tokens, day('2026-09-02T05:00:00.000Z').state, day('2026-09-02T05:00:00.000Z').sources], [170, 'observed', ['buckets']]);
    assert.deepEqual([day('2026-09-03T05:00:00.000Z').total_tokens, day('2026-09-04T05:00:00.000Z').state, day('2026-09-14T05:00:00.000Z').state], [440, 'zero', 'partial']);
    assert.equal(all.series.points.reduce((n, p) => n + p.total_tokens, 0), all.headline.total_tokens, 'the series reconciles to the headline');
    assert.deepEqual(all.model_series.find(m => m.model === 'm1')!.points.map(p => [p.start, p.total_tokens]), [['2026-09-02T05:00:00.000Z', 170], ['2026-09-14T05:00:00.000Z', 5]]);
    assert.deepEqual(all.request_detail, { covered_tokens: 210, covered_calls: 3, coverage: { unit: 'tokens', headline: 615, eligible: 615, classified: 210, applicable: 1, complete: 210 / 615, note: all.request_detail.coverage.note } });
    assert.deepEqual(all.projects.rows.map(r => [r.state, r.label, r.total_tokens, r.calls, r.conversations]), [['project', 'Fixture project', 170, 2, 1], ['no_project', null, 40, 1, 1]]);
    assert.deepEqual([all.projects.coverage.headline, all.projects.coverage.eligible, all.projects.coverage.classified, all.projects.registry.eligible, all.projects.registry.classified], [615, 210, 210, 170, 170]);
    assert.deepEqual(all.agents.summary, { main_tokens: 150, subagent_tokens: 20, unattributed_tokens: 40, observed_children: 1, spawns: 1, by_class: { main: 150, builtin: 20, unknown: 40 } });
    assert.equal(all.agents.rows.find(r => r.agent_key === childKey)?.parent_agent_key, mainKey);
    assert.deepEqual([all.tools.invocations, all.tools.by_outcome, all.tools.by_tool.map(t => [t.name, t.invocations])], [2, { succeeded: 1, unknown: 1 }, [['Bash', 1], ['Read', 1]]]);
    assert.deepEqual([all.tools.caller_coverage.classified, all.tools.outcome_coverage.classified], [2, 1]);
    assert.deepEqual(all.knowledge.rows.map(r => [r.label, r.accesses, r.distinct_invocations, r.distinct_sessions, r.by_access_kind.read]), [['Fixture vault', 1, 1, 1, 1]]);
    assert.deepEqual(all.pricing_inputs.rows.map(r => [r.model, r.reasoning_effort, r.total_tokens]), [['m1', 'high', 150], ['m2', 'low', 40], ['m1', null, 20]]);
    assert.deepEqual([all.pricing_inputs.coverage.eligible, all.pricing_inputs.coverage.classified], [210, 210]);
    assert.deepEqual(all.environmental_inputs.cohorts.map(c => [c.account_id, c.month, c.calls, c.raw_tokens, c.basis]), [[claude, '2026-09', 5, 215, 'buckets'], [codex, '2026-09', 4, 400, 'buckets']]);
    assert.deepEqual(all.historical.snapshots.map(s => [s.subject_key, s.month, s.status, s.merged, s.reason]), [[subject, '2026-09', 'partial', 'none', 'hourly_ledger_covers_month']]);

    // 2. A project filter narrows the headline to request detail and discloses what buckets alone cannot examine.
    const project = await query({ projects: projectId });
    assert.deepEqual([project.headline.total_tokens, project.headline.calls, project.headline.conversations, project.headline.basis, project.headline.unfilterable_tokens, project.headline.unfilterable_calls], [170, 2, 1, 'requests', 405, 6]);
    assert.deepEqual(project.scope.detail_filters, ['projects']);
    assert.deepEqual(project.by_model.map(m => [m.model, m.total_tokens, m.basis]), [['m1', 170, 'requests']]);
    assert.equal(project.series.points.find(p => p.start === '2026-09-02T05:00:00.000Z')?.total_tokens, 170);
    assert.deepEqual(project.projects.rows.map(r => [r.state, r.total_tokens, r.share]), [['project', 170, 1]]);
    assert.deepEqual([project.agents.summary.main_tokens, project.agents.summary.subagent_tokens, project.agents.summary.unattributed_tokens], [150, 20, 0]);
    assert.equal(project.tools.invocations, 2, 'tools follow their calling requests through the project filter');
    assert.equal((await query({ projects: 'no_project' })).headline.total_tokens, 40);
    assert.equal((await query({ projects: `${projectId},no_project` })).headline.total_tokens, 210, 'values within one dimension are ORed');

    // 3. Unknown is explicit and selectable; named values exclude it.
    assert.equal((await query({ efforts: 'unknown' })).headline.total_tokens, 20);
    assert.equal((await query({ efforts: 'high' })).headline.total_tokens, 150);
    assert.equal((await query({ efforts: 'high,unknown' })).headline.total_tokens, 170);
    assert.equal((await query({ surfaces: 'desktop' })).headline.total_tokens, 40);
    assert.equal((await query({ agent_scope: 'subagent' })).headline.total_tokens, 20);
    assert.equal((await query({ agents: childKey })).headline.total_tokens, 20);
    assert.equal((await query({ agents: childKey })).tools.invocations, 1);

    // 4. Bucket-level filters keep the bucket basis; dimensions AND together.
    const model = await query({ models: 'm1' });
    assert.deepEqual([model.headline.total_tokens, model.headline.calls, model.headline.basis, model.request_detail.covered_tokens], [175, 4, 'buckets', 170]);
    const both = await query({ models: 'm1', projects: projectId });
    assert.deepEqual([both.headline.total_tokens, both.headline.basis, both.headline.unfilterable_tokens], [170, 'requests', 5]);
    assert.deepEqual([(await query({ accounts: codex })).headline.total_tokens, (await query({ providers: 'claude' })).headline.total_tokens], [400, 215], 'accounts and providers intersect');
    assert.equal((await query({ machines: claudeSource })).headline.total_tokens, 215, 'a machine filter selects the observing collector of the canonical row');
    await assert.rejects(query({ accounts: 'nobody' }), (e: unknown) => e instanceof RequestError && e.status === 404);
    await assert.rejects(query({ resolution: 'hour', preset: 'custom', start: '2026-08-01T05:00:00Z', end: '2026-09-14T20:30:00Z' }), /up to 14 days/);
    assert.equal((await query({ preset: 'custom', start: '2026-09-02T00:00:00Z', end: '2026-09-04T00:00:00Z', resolution: 'hour' })).series.points.length, 48);
    const hourly = await query({ preset: 'custom', start: '2026-09-02T00:00:00Z', end: '2026-09-04T00:00:00Z', resolution: 'hour', projects: projectId });
    assert.deepEqual([hourly.headline.total_tokens, hourly.series.points.reduce((n, p) => n + p.total_tokens, 0), hourly.series.points.find(p => p.start === '2026-09-02T14:00:00.000Z')?.total_tokens], [170, 170, 170],
      'an hourly series under a detail filter reconciles to its headline');
    assert.deepEqual([(await query({ models: 'unknown' })).headline.total_tokens, (await query({ models: 'unknown', projects: 'no_project' })).headline.total_tokens], [0, 0],
      'a filter never promotes a non-canonical revision');
    assert.equal((await query({ models: 'm2', projects: 'no_project' })).headline.total_tokens, 40);

    // 5. Historical fallback: a mapped subject fills only months the hourly ledger never covered.
    const july = await query({ preset: 'custom', start: '2026-07-01T05:00:00Z', end: '2026-08-01T05:00:00Z' });
    assert.deepEqual([july.headline.total_tokens, july.headline.calls, july.headline.snapshot_tokens, july.series.excludes_snapshot_tokens], [1000, 10, 1000, 0]);
    assert.deepEqual(july.historical.snapshots.map(s => [s.subject_key, s.status, s.merged, s.reason, s.merged_tokens]), [[subject, 'complete', 'days', null, 1000], [otherSubject, 'complete', 'none', 'subject_not_mapped', 0]],
      'the complete revision wins for a closed month and an unmapped subject is listed, not counted');
    assert.deepEqual(july.series.points.filter(p => p.total_tokens > 0).map(p => [p.start, p.total_tokens, p.sources]), [['2026-07-10T05:00:00.000Z', 600, ['snapshot']], ['2026-07-20T05:00:00.000Z', 400, ['snapshot']]]);
    assert.deepEqual(july.environmental_inputs.cohorts.map(c => [c.account_id, c.month, c.calls, c.basis]), [[claude, '2026-07', 10, 'snapshot']]);
    const half = await query({ preset: 'custom', start: '2026-07-15T05:00:00Z', end: '2026-08-01T05:00:00Z' });
    assert.deepEqual([half.headline.total_tokens, half.historical.snapshots[0].merged, half.historical.snapshots[0].merged_tokens], [400, 'days', 400], 'a partial month places whole source days only');
    await layer.updateReportSubject({ subject_key: subject, account_id: claude, source_timezone: null });
    const wholeOnly = await query({ preset: 'custom', start: '2026-07-01T05:00:00Z', end: '2026-08-01T05:00:00Z' });
    assert.deepEqual([wholeOnly.headline.total_tokens, wholeOnly.historical.snapshots[0].merged, wholeOnly.series.excludes_snapshot_tokens], [1000, 'month', 1000], 'without a source zone the month is a whole-period fact');
    await layer.updateReportSubject({ subject_key: subject, account_id: claude, source_timezone: 'Europe/Berlin' });
    const otherZone = await query({ preset: 'custom', start: '2026-07-15T05:00:00Z', end: '2026-08-01T05:00:00Z' });
    assert.deepEqual([otherZone.headline.total_tokens, otherZone.historical.snapshots[0].reason], [0, 'source_timezone_differs_from_display'], 'source days place only on matching display days');
    await layer.updateReportSubject({ subject_key: subject, account_id: claude, source_timezone: null });
    const halfUnknownZone = await query({ preset: 'custom', start: '2026-07-15T05:00:00Z', end: '2026-08-01T05:00:00Z' });
    assert.deepEqual([halfUnknownZone.headline.total_tokens, halfUnknownZone.historical.snapshots[0].reason], [0, 'source_timezone_unknown_whole_month_only']);
    assert.equal((await query({ preset: 'custom', start: '2026-07-01T05:00:00Z', end: '2026-08-01T05:00:00Z', models: 'm1' })).historical.snapshots[0].reason, 'filters_unsupported_by_snapshot');

    // 6. Presets anchor to now and mark the interval still being observed.
    const mtd = await query({ preset: 'month_to_date', start: '', end: '' });
    assert.deepEqual([mtd.scope.range.start, mtd.scope.range.end, mtd.scope.range.anchored_to_now, mtd.headline.total_tokens], ['2026-09-01T05:00:00.000Z', '2026-09-14T20:30:00.000Z', true, 615]);
    assert.equal(mtd.series.points.at(-1)?.state, 'partial');
  } finally {
    await sql.end({ timeout: 1 });
  }
});
