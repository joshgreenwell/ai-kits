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
  const { refreshCanonicalProjections } = await import('../lib/usage-canonical');
  const { appProjectId } = await import('../lib/usage-app-projects');
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
    await bucket(codex, codexSource, 'sol1', '2026-08-31T14:00:00Z', 'gpt-5.6-sol', 2, 1_000_000);
    await bucket(claude, claudeSource, 'a3', '2026-09-14T20:00:00Z', 'm1', 1, 5);

    // App projects: one app project whose root holds the fixture folder, so the folder's membership places
    // its requests; the install has reported project data. Knowledge registry: one mapped vault.
    const projectName = `Fixture project ${suffix}`, projectId = appProjectId(projectName), appProjectKey = sha(`app-project:${suffix}`);
    const vaultId = randomUUID(), vaultIdentity = randomUUID();
    await sql`INSERT INTO personal_hub.usage_projects (id, label) VALUES (${projectId}, ${projectName})`;
    await sql`INSERT INTO personal_hub.usage_app_projects (install_id, project_key, app, name, position, state, project_id, observed_at)
      VALUES (${install}, ${appProjectKey}, 'codex_desktop', ${projectName}, 0, 'active', ${projectId}, '2026-09-02T00:00:00Z')`;
    await sql`INSERT INTO personal_hub.usage_project_memberships (install_id, member_kind, member_key, project_key, resolution, observed_at)
      VALUES (${install}, 'working_directory', ${projectKey}, ${appProjectKey}, 'root_prefix', '2026-09-02T00:00:00Z')`;
    await sql`INSERT INTO personal_hub.usage_project_reports (install_id) VALUES (${install})`;
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
    // Codex requests outside September: the long-context boundary on the OpenAI threshold and a rate-period boundary event.
    const onCodex = { account_id: codex, binding_id: codexBinding, provider: 'codex', adapter: 'codex_execution', product: 'codex_cli', service_tier: 'standard' };
    await request('c1', 'b2', '2026-08-31T14:30:00Z', 'gpt-5.6-sol', [272_000, 0, 0, 0], onCodex);
    await request('c2', 'b2', '2026-08-31T14:35:00Z', 'gpt-5.6-sol', [272_001, 0, 0, 0], onCodex);
    await request('c3', 'b3', '2026-07-30T03:00:00Z', 'gpt-5.6-sol', [100_000, 0, 0, 0], { ...onCodex, service_tier: 'priority' });
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
    // The analyzer's stored estimate for the complete July revision: ten calls under the heavy class, so the stored class is provably kept.
    const storedJuly = { kind: 'inference_equivalent_scenario_estimate', methodology_version: '2026-08-20.1', confidence: 'low',
      basis: { model_calls: 10, raw_tokens: 1000, average_raw_tokens_per_call: 100, planning_workload_class: 'reasoning_heavy', planning_wh_per_call: 4.32 },
      energy_kwh: { efficient_production_floor: 0.0024, planning: 0.0432, long_context_upper: 0.33 }, direct_water_liters: { efficient_production_floor: 0.0026, planning: 0.01296, long_context_upper: 0.627 },
      operational_co2_kg: { clean_energy_floor: 0.0003, planning_us_grid: 0.0170208, long_context_us_grid: 0.13002 } };
    const snapshot = (subjectKey: string, month: string, status: string, total: number, calls: number, daily: { date: string; total_tokens: number; calls: number }[], produced: string, extra: Record<string, unknown> = {}) =>
      sql`INSERT INTO personal_hub.report_revisions (id, kind, period_key, subject_key, producer_id, idempotency_key, title, produced_at, status, schema_version, coverage, payload, content_hash)
        VALUES (${randomUUID()}, 'usage', ${month}, ${subjectKey}, 'fixture', ${sha(randomUUID())}, ${`${subjectKey} · ${month}`}, ${produced}, ${status}, 1, '{}'::jsonb,
          ${sql.json({ machine_id: subjectKey, machine_name: 'Legacy box', report: { generated_at_local: produced, current: { month, totals: { total_tokens: total, calls, threads: 2 },
            exclusive_composition: { cached_input_tokens: 100, uncached_input_tokens: total - 300, reasoning_output_tokens: 50, nonreasoning_output_tokens: 150, unclassified_total_only_tokens: 0 }, daily, ...extra } } })}, ${sha(randomUUID())})`;
    await snapshot(subject, '2026-07', 'partial', 900, 9, [{ date: '2026-07-10', total_tokens: 600, calls: 6 }], '2026-07-20T12:00:00Z');
    await snapshot(subject, '2026-07', 'complete', 1000, 10, [{ date: '2026-07-10', total_tokens: 600, calls: 6 }, { date: '2026-07-20', total_tokens: 400, calls: 4 }], '2026-08-01T12:00:00Z', { environmental_estimate: storedJuly });
    await snapshot(otherSubject, '2026-07', 'complete', 500, 5, [], '2026-08-01T12:00:00Z');
    await snapshot(subject, '2026-09', 'partial', 300, 3, [{ date: '2026-09-05', total_tokens: 300, calls: 3 }], '2026-09-10T12:00:00Z');
    await layer.updateReportSubject({ subject_key: subject, account_id: claude, source_timezone: 'America/Chicago' });
    await assert.rejects(layer.updateReportSubject({ subject_key: `missing-${suffix}`, account_id: claude, source_timezone: null }), (e: unknown) => e instanceof RequestError && e.status === 404);
    await assert.rejects(layer.updateReportSubject({ subject_key: subject, account_id: 'no-such-account', source_timezone: null }), (e: unknown) => e instanceof RequestError && e.status === 404);
    const subjects = await layer.listReportSubjects();
    assert.deepEqual(subjects.subjects.filter(s => s.subject_key === subject).map(s => [s.account_id, s.source_timezone, s.revisions, s.first_month, s.last_month]), [[claude, 'America/Chicago', 3, '2026-07', '2026-09']]);

    // These fixtures write personal_hub.activity_requests directly rather than through `ingestUsage`,
    // so nothing has maintained the canonical projections the reads now use. Refreshing it here is the
    // same rule production follows: any path that writes the ledger outside ingest rebuilds after it.
    await refreshCanonicalProjections(sql);
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
    // Effort is request detail only, so it speaks for the 210 covered request tokens, not the 615-token headline.
    assert.deepEqual(all.effort_series.rows.map(r => [r.model, r.effort, r.points.reduce((n, p) => n + p.total_tokens, 0)]), [['m1', 'high', 150], ['m1', 'unknown', 20], ['m2', 'low', 40]]);
    assert.deepEqual([all.effort_series.coverage.eligible, all.effort_series.coverage.classified], [210, 210]);
    assert.deepEqual(all.request_detail, { covered_tokens: 210, covered_calls: 3, coverage: { unit: 'tokens', headline: 615, eligible: 615, classified: 210, applicable: 1, complete: 210 / 615, note: all.request_detail.coverage.note } });
    assert.deepEqual(all.projects.rows.map(r => [r.state, r.label, r.total_tokens, r.calls, r.conversations]), [['project', projectName, 170, 2, 1], ['no_project', null, 40, 1, 1]]);
    assert.deepEqual([all.projects.coverage.headline, all.projects.coverage.eligible, all.projects.coverage.classified, all.projects.registry.eligible, all.projects.registry.classified], [615, 210, 210, 170, 170]);
    assert.deepEqual(all.agents.summary, { main_tokens: 150, subagent_tokens: 20, unattributed_tokens: 40, observed_children: 1, spawns: 1, by_class: { main: 150, builtin: 20, unattributed: 40 } });
    assert.deepEqual(all.agents.rows.map(r => [r.provider, r.role, r.name, r.builtin, r.instances, r.sessions, r.total_tokens]).sort(),
      [['claude', 'main', 'main', false, 1, 1, 150], ['claude', 'subagent', 'Explore', true, 1, 1, 20], ['claude', 'unattributed', 'unattributed', false, 0, 1, 40]].sort());
    const groupOf = (name: string) => all.agents.rows.find(r => r.name === name)!.group_id;
    const childGroup = groupOf('Explore'), mainGroup = groupOf('main');
    assert.match(childGroup, /^[a-f0-9]{64}$/, 'a group id is an opaque sha256');
    assert.deepEqual([all.tools.invocations, all.tools.by_outcome, all.tools.by_tool.map(t => [t.name, t.invocations])], [2, { succeeded: 1, unknown: 1 }, [['Bash', 1], ['Read', 1]]]);
    assert.deepEqual([all.tools.caller_coverage.classified, all.tools.outcome_coverage.classified], [2, 1]);
    assert.deepEqual(all.knowledge.rows.map(r => [r.label, r.accesses, r.distinct_invocations, r.distinct_sessions, r.by_access_kind.read]), [['Fixture vault', 1, 1, 1, 1]]);
    assert.deepEqual([all.knowledge.unsupported_filters, all.tools.unsupported_filters], [[], []]);
    assert.deepEqual(all.pricing_inputs.rows.map(r => [r.model, r.service_tier, r.context_band, r.rate_date, r.total_tokens]),
      [['m3', null, 'short', '2026-09-03', 400], ['m1', null, 'short', '2026-09-02', 170], ['m2', null, 'short', '2026-09-03', 40], ['m1', null, 'short', '2026-09-14', 5]],
      'hourly buckets price without waiting for request-level tier or effort');
    assert.deepEqual([all.pricing_inputs.coverage.eligible, all.pricing_inputs.coverage.classified], [615, 615]);
    assert.deepEqual(all.environmental_inputs.cohorts.map(c => [c.account_id, c.month, c.selected.calls, c.selected.raw_tokens, c.population.calls, c.basis, c.month_closed]).sort(), [[claude, '2026-09', 5, 215, 5, 'buckets', false], [codex, '2026-09', 4, 400, 4, 'buckets', false]]);
    assert.deepEqual([all.cost.unpriced_reasons, all.cost.estimated_cost_usd, all.cost.pricing_catalog.versions.openai], [{ model_not_in_catalog: 615 }, 0, '2026-09-22'], 'fixture models are unpriced with their reason, never free');
    assert.deepEqual([all.environment.basis.model_calls, all.environment.energy_kwh.planning, all.environment.coverage.calls_headline, all.environment.methodology_versions], [9, 0.00306, 9, ['2026-08-20.1']]);
    assert.deepEqual(all.historical.snapshots.map(s => [s.subject_key, s.month, s.status, s.merged, s.reason]), [[subject, '2026-09', 'partial', 'none', 'hourly_ledger_covers_month']]);

    // 2. A project filter narrows the headline to request detail and discloses what buckets alone cannot examine.
    const project = await query({ projects: projectId });
    assert.deepEqual([project.headline.total_tokens, project.headline.calls, project.headline.conversations, project.headline.basis, project.headline.unfilterable_tokens, project.headline.unfilterable_calls], [170, 2, 1, 'requests', 405, 6]);
    assert.deepEqual(project.scope.detail_filters, ['projects']);
    assert.deepEqual(project.by_model.map(m => [m.model, m.total_tokens, m.basis]), [['m1', 170, 'requests']]);
    assert.equal(project.series.points.find(p => p.start === '2026-09-02T05:00:00.000Z')?.total_tokens, 170);
    assert.deepEqual(project.projects.rows.map(r => [r.state, r.total_tokens, r.share]), [['project', 170, 1]]);
    assert.deepEqual([project.agents.summary.main_tokens, project.agents.summary.subagent_tokens, project.agents.summary.unattributed_tokens], [150, 20, 0]);
    assert.deepEqual([project.environment.basis.model_calls, project.environment.basis.cohorts[0].population.calls, project.environment.energy_kwh.planning], [2, 5, 0.00068], 'a filter sums selected calls under the whole cohort class');
    assert.equal(project.tools.invocations, 2, 'tools follow their calling requests through the project filter');
    assert.equal((await query({ projects: 'no_project' })).headline.total_tokens, 40);
    assert.equal((await query({ projects: `${projectId},no_project` })).headline.total_tokens, 210, 'values within one dimension are ORed');

    // 3. Unknown is explicit and selectable; named values exclude it.
    assert.equal((await query({ efforts: 'unknown' })).headline.total_tokens, 20);
    assert.equal((await query({ efforts: 'high' })).headline.total_tokens, 150);
    assert.equal((await query({ efforts: 'high,unknown' })).headline.total_tokens, 170);
    assert.equal((await query({ surfaces: 'desktop' })).headline.total_tokens, 40);
    assert.equal((await query({ agent_scope: 'subagent' })).headline.total_tokens, 20);
    assert.equal((await query({ agents: childGroup })).headline.total_tokens, 20);
    const childOnly = await query({ agents: childGroup });
    assert.equal(childOnly.tools.invocations, 1);
    assert.deepEqual([childOnly.knowledge.rows, childOnly.knowledge.distinct_invocations, childOnly.agents.summary.spawns], [[], 0, 1], 'the vault access came from the main agent, so the agent filter leaves no access; the child\'s spawn stays');
    assert.deepEqual((await query({ agents: mainGroup })).knowledge.rows.map(r => [r.label, r.accesses]), [['Fixture vault', 1]]);
    assert.equal((await query({ agents: childKey })).headline.total_tokens, 0, 'an agent key is not a group id: an old bookmarked key matches nothing');

    // 4. Bucket-level filters keep the bucket basis; dimensions AND together.
    const model = await query({ models: 'm1' });
    assert.deepEqual([model.headline.total_tokens, model.headline.calls, model.headline.basis, model.request_detail.covered_tokens], [175, 4, 'buckets', 170]);
    assert.deepEqual([model.knowledge.unsupported_filters, model.tools.unsupported_filters, model.knowledge.rows.length], [['models'], ['models'], 1], 'a model filter alone is reported, not applied, by both areas');
    assert.match(model.knowledge.note, /model filter is not applied/);
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
    assert.deepEqual(july.environmental_inputs.cohorts.map(c => [c.account_id, c.month, c.subject_key, c.selected.calls, c.population.calls, c.basis, c.stored?.methodology_version, c.stored?.planning_workload_class]),
      [[claude, '2026-07', subject, 10, 10, 'snapshot', '2026-08-20.1', 'reasoning_heavy']], 'the stored estimate is parsed from the envelope');
    assert.deepEqual([july.environment.basis.model_calls, july.environment.basis.cohorts[0].classification.source, july.environment.basis.cohorts[0].classification.workload_class, july.environment.energy_kwh.planning],
      [10, 'stored', 'high_context_per_call', 0.0432], 'a wholly selected legacy month carries the analyzer\'s numbers');
    // Two subjects mapped to one account in one month stay two cohorts and both count.
    await layer.updateReportSubject({ subject_key: otherSubject, account_id: claude, source_timezone: null });
    const twoSubjects = await query({ preset: 'custom', start: '2026-07-01T05:00:00Z', end: '2026-08-01T05:00:00Z' });
    assert.deepEqual([twoSubjects.headline.total_tokens, twoSubjects.headline.calls, twoSubjects.environment.basis.model_calls, twoSubjects.environment.coverage.calls_without_class], [1500, 15, 15, 0]);
    assert.deepEqual(twoSubjects.environmental_inputs.cohorts.map(c => [c.subject_key, c.selected.calls]).sort(), [[subject, 10], [otherSubject, 5]].sort());
    assert.equal(twoSubjects.environment.energy_kwh.planning, 0.0449, 'the stored heavy month plus five computed light calls');
    await layer.updateReportSubject({ subject_key: otherSubject, account_id: null, source_timezone: null });
    const half = await query({ preset: 'custom', start: '2026-07-15T05:00:00Z', end: '2026-08-01T05:00:00Z' });
    assert.deepEqual([half.headline.total_tokens, half.historical.snapshots[0].merged, half.historical.snapshots[0].merged_tokens], [400, 'days', 400], 'a partial month places whole source days only');
    assert.deepEqual([half.environment.basis.cohorts[0].classification.source, half.environment.basis.cohorts[0].classification.workload_class, half.environment.energy_kwh.planning, half.environment.basis.cohorts[0].methodology_version],
      ['stored_class', 'high_context_per_call', 0.01728, '2026-08-20.1'], 'a partly selected legacy month keeps its stored class for its selected calls');
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

    // 6. Hourly buckets estimate from model, Chicago date, and composition; missing tier is Standard and the band is short.
    const bucketPriced = await query({ preset: 'custom', start: '2026-08-31T05:00:00Z', end: '2026-09-01T05:00:00Z', accounts: codex, models: 'gpt-5.6-sol' });
    assert.equal(bucketPriced.headline.basis, 'buckets');
    assert.deepEqual(bucketPriced.pricing_inputs.rows.map(r => [r.provider, r.model, r.service_tier, r.context_band, r.rate_date, r.total_tokens, r.calls]),
      [['codex', 'gpt-5.6-sol', null, 'short', '2026-08-31', 1_000_000, 2]]);
    assert.deepEqual([bucketPriced.cost.estimated_cost_usd, bucketPriced.cost.missing_service_tier_calls_assumed_standard, bucketPriced.cost.unpriced_tokens], [5, 2, 0]);
    assert.deepEqual(bucketPriced.cost.series.map(r => [r.rate_date, r.model, r.estimated_cost_usd, r.total_tokens]), [['2026-08-31', 'gpt-5.6-sol', 5, 1_000_000]],
      'bucket hours become the daily cost series rate date');
    // Request-level long/short band and dated Priority still apply when a detail filter makes requests the headline.
    const august = await query({ preset: 'custom', start: '2026-08-31T05:00:00Z', end: '2026-09-01T05:00:00Z', accounts: codex, surfaces: 'cli', models: 'gpt-5.6-sol' });
    assert.deepEqual(august.pricing_inputs.rows.map(r => [r.provider, r.model, r.context_band, r.rate_date, r.total_tokens]), [['codex', 'gpt-5.6-sol', 'long', '2026-08-31', 272_001], ['codex', 'gpt-5.6-sol', 'short', '2026-08-31', 272_000]]);
    assert.deepEqual([august.cost.estimated_cost_usd, august.cost.by_model[0].long_context_calls, august.cost.unpriced_tokens], [4.08001, 1, 0], 'exactly the threshold is short, one over is long');
    assert.deepEqual(august.cost.series.map(r => [r.rate_date, r.model, r.estimated_cost_usd, r.total_tokens]), [['2026-08-31', 'gpt-5.6-sol', 4.08001, 544_001]],
      'the daily cost series reconciles its model and source price date');
    const boundary = await query({ preset: 'custom', start: '2026-07-29T00:00:00Z', end: '2026-08-01T00:00:00Z', accounts: codex, timezone: 'UTC', surfaces: 'cli' });
    assert.deepEqual([boundary.pricing_inputs.rows[0].rate_date, boundary.cost.by_model_effort_service_tier[0].pricing_service_tiers, boundary.cost.estimated_cost_usd], ['2026-07-29', ['priority'], 1.25],
      'a 03:00Z event on July 30 is July 29 in America/Chicago whatever the display zone, so it prices in the launch Priority period');

    // 7. Presets anchor to now and mark the interval still being observed.
    const mtd = await query({ preset: 'month_to_date', start: '', end: '' });
    assert.deepEqual([mtd.scope.range.start, mtd.scope.range.end, mtd.scope.range.anchored_to_now, mtd.headline.total_tokens], ['2026-09-01T05:00:00.000Z', '2026-09-14T20:30:00.000Z', true, 615]);
    assert.equal(mtd.series.points.at(-1)?.state, 'partial');

    // 8. Sectioned reads skip tables other cards own and stay inside the selected range.
    const overview = await query({ section: 'overview' });
    assert.equal(overview.headline.total_tokens, 615);
    assert.equal(overview.tools.invocations, 0, 'overview does not scan tool events');
    assert.deepEqual(overview.projects.rows, []);
    assert.deepEqual(overview.effort_series.rows, []);
    const requestsOnly = await query({ section: 'requests' });
    assert.deepEqual(requestsOnly.projects.rows.map(r => [r.state, r.total_tokens]), [['project', 170], ['no_project', 40]]);
    assert.equal(requestsOnly.tools.invocations, 0);
    const toolsOnly = await query({ section: 'tools' });
    assert.equal(toolsOnly.tools.invocations, 2);
    assert.equal(toolsOnly.headline.total_tokens, 0, 'tools does not rescan the hourly ledger');
    assert.deepEqual(toolsOnly.knowledge.rows, [], 'tools does not wait on knowledge-source resolution');
    const knowledgeOnly = await query({ section: 'knowledge' });
    assert.deepEqual(knowledgeOnly.knowledge.rows.map(r => [r.label, r.accesses]), [['Fixture vault', 1]]);
    assert.equal(knowledgeOnly.tools.invocations, 0, 'knowledge does not rescan tool invocations');
    const projectOverview = await query({ projects: projectId, section: 'overview' });
    assert.deepEqual([projectOverview.headline.total_tokens, projectOverview.headline.basis, projectOverview.projects.rows], [170, 'requests', []],
      'detail filters still switch the overview headline without waiting on project rows');
  } finally {
    await sql.end({ timeout: 1 });
  }
});

maybe('provider account usage is the Tokens headline for Cursor and Admin API accounts and is not added to local hours', async () => {
  const { createUsageQuery, parseUsageQuery } = await import('../lib/usage-query');
  const { refreshCanonicalProjections } = await import('../lib/usage-canonical');
  const sql = postgres(url!, options);
  const layer = createUsageQuery(() => sql);
  const suffix = randomUUID().slice(0, 8);
  const claude = `q-local-${suffix}`, cursor = `q-cursor-${suffix}`;
  const claudeSource = randomUUID(), cursorSource = randomUUID(), install = randomUUID(), claudeBinding = randomUUID(), cursorBinding = randomUUID();
  try {
    await sql`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${claude}, 'claude', 'Claude local'), (${cursor}, 'cursor', 'Cursor hosted')`;
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash, last_seen_at) VALUES
      (${claudeSource}, ${claude}, 'host', 'companion', ${sha(randomUUID())}, '2026-09-03T00:00:00Z'),
      (${cursorSource}, ${cursor}, 'host', 'companion', ${sha(randomUUID())}, '2026-09-03T00:00:00Z')`;
    await sql`INSERT INTO personal_hub.companion_installs (id, machine_label, kind, platform, arch, key_hash) VALUES (${install}, 'host', 'companion', 'linux', 'amd64', ${sha(randomUUID())})`;
    await sql`INSERT INTO personal_hub.companion_bindings (id, install_id, account_id, source_id, provider, identity_hash) VALUES
      (${claudeBinding}, ${install}, ${claude}, ${claudeSource}, 'claude', ${sha('claude')}),
      (${cursorBinding}, ${install}, ${cursor}, ${cursorSource}, 'cursor', ${sha('cursor')})`;
    const hour = '2026-09-02T14:00:00Z';
    const local = { session_hash: sha(`local:${suffix}`), hour, model: 'm1', input_tokens: 100, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total_tokens: 100, calls: 2 };
    await sql`INSERT INTO personal_hub.token_bucket_revisions ${sql({ id: randomUUID(), account_id: claude, source_id: claudeSource, observed_at: hour, content_hash: hashOf(local), ...local })}`;
    await sql`INSERT INTO personal_hub.account_usage_buckets ${sql({
      id: randomUUID(), account_id: cursor, binding_id: cursorBinding, provider: 'cursor', adapter: 'cursor_account',
      report_source: 'usage_events', bucket_start: hour, bucket_end: '2026-09-02T15:00:00Z', model: 'cursor-small',
      dimensions_hash: sha(`dims:${suffix}`), requests: 3, input_tokens: 80, cached_tokens: 20, cache_write_tokens: 0,
      output_tokens: 10, total_tokens: 110, unclassified_tokens: 0, token_state: 'complete', basis: 'reported',
      observed_at: hour, content_hash: sha(`bucket:${suffix}`),
    })}`;
    await sql`INSERT INTO personal_hub.account_usage_buckets ${sql({
      id: randomUUID(), account_id: cursor, binding_id: cursorBinding, provider: 'cursor', adapter: 'cursor_account',
      report_source: 'cursor_usage_events', bucket_start: '2026-09-03T14:00:00Z', bucket_end: '2026-09-03T15:00:00Z',
      model: 'grok-4.6', dimensions_hash: sha(`dims-grok:${suffix}`), requests: 1, input_tokens: 1000,
      cached_tokens: 0, cache_write_tokens: 0, output_tokens: 100, unclassified_tokens: null,
      token_state: 'complete', basis: 'reported', observed_at: '2026-09-03T14:00:00Z',
      content_hash: sha(`bucket-grok:${suffix}`),
    })}`;
    const query = (accounts: string) => layer.usageQuery(parseUsageQuery(new URLSearchParams({ ...SEPTEMBER, accounts })), { now: NOW });
    const both = await query(`${claude},${cursor}`);
    assert.deepEqual([both.headline.total_tokens, both.headline.calls, both.headline.basis, both.headline.conversations],
      [1310, 6, 'buckets', 1], 'local hours and hosted aggregates sit side by side, including hosted rows that stored no total');
    assert.equal(both.headline.composition.input_fresh, 1180);
    assert.equal(both.headline.composition.input_cached, 20);
    const hosted = await query(cursor);
    assert.deepEqual([hosted.headline.total_tokens, hosted.headline.calls, hosted.headline.conversations], [1210, 4, 0]);
    const grok = hosted.cost.by_model.find(row => row.model === 'grok-4.6');
    const unnamed = hosted.cost.by_model.find(row => row.model === 'cursor-small');
    assert.equal(grok?.estimated_cost_usd, 0.0026);
    assert.deepEqual([unnamed?.total_tokens, unnamed?.unpriced_tokens, unnamed?.estimated_cost_usd], [110, 110, 0]);
    const localOnly = await query(claude);
    assert.deepEqual([localOnly.headline.total_tokens, localOnly.headline.calls, localOnly.headline.conversations], [100, 2, 1]);
    assert.ok(both.notes.some(note => note.includes('Provider-reported account usage')));
  } finally {
    await sql.end({ timeout: 1 });
  }
});

maybe('knowledge accesses and spawn evidence follow the machine, agent, and detail filters the tools area applies', async () => {
  const { createUsageQuery, parseUsageQuery } = await import('../lib/usage-query');
  const { refreshCanonicalProjections } = await import('../lib/usage-canonical');
  const sql = postgres(url!, options);
  const layer = createUsageQuery(() => sql);
  const suffix = randomUUID().slice(0, 8);
  const account = `q-know-${suffix}`;
  // Two companion installs on one account: machine A carries the main agent's vault read, machine B a subagent's vault search.
  const sourceA = randomUUID(), sourceB = randomUUID(), installA = randomUUID(), installB = randomUUID(), bindingA = randomUUID(), bindingB = randomUUID();
  const mainKey = sha(`agent:main:${suffix}`), childKey = sha(`agent:child:${suffix}`), otherChildKey = sha(`agent:other:${suffix}`);
  try {
    await sql`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${account}, 'claude', 'Knowledge fixture')`;
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash, last_seen_at) VALUES
      (${sourceA}, ${account}, 'machine A', 'companion', ${sha(randomUUID())}, '2026-09-14T20:10:00Z'), (${sourceB}, ${account}, 'machine B', 'companion', ${sha(randomUUID())}, '2026-09-14T20:10:00Z')`;
    await sql`INSERT INTO personal_hub.companion_installs (id, machine_label, kind, platform, arch, key_hash) VALUES
      (${installA}, 'machine A', 'companion', 'linux', 'amd64', ${sha(randomUUID())}), (${installB}, 'machine B', 'companion', 'darwin', 'arm64', ${sha(randomUUID())})`;
    await sql`INSERT INTO personal_hub.companion_bindings (id, install_id, account_id, source_id, provider, identity_hash) VALUES
      (${bindingA}, ${installA}, ${account}, ${sourceA}, 'claude', ${sha(`id-a:${suffix}`)}), (${bindingB}, ${installB}, ${account}, ${sourceB}, 'claude', ${sha(`id-b:${suffix}`)})`;
    // One named vault, identified separately on each install (identities are install-scoped) and mapped to the same source.
    const vaultId = randomUUID();
    await sql`INSERT INTO personal_hub.usage_knowledge_sources (id, label) VALUES (${vaultId}, 'Shared vault')`;
    for (const install of [installA, installB]) {
      const identity = randomUUID();
      await sql`INSERT INTO personal_hub.usage_knowledge_source_identities (id, install_id, resource_key, configuration_version, first_seen, last_seen) VALUES (${identity}, ${install}, ${`vault.${suffix}`}, 'cfg:1', '2026-09-02T14:10:00Z', '2026-09-03T14:10:00Z')`;
      await sql`INSERT INTO personal_hub.usage_knowledge_source_mapping_revisions (id, identity_id, source_id) VALUES (${randomUUID()}, ${identity}, ${vaultId})`;
    }
    const request = (binding: string, semantic: string, session: string, at: string, model: string, extra: Record<string, unknown>) =>
      sql`INSERT INTO personal_hub.activity_requests ${sql({ id: randomUUID(), account_id: account, binding_id: binding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file',
        record_id: randomUUID(), semantic_key: sha(`${semantic}:${suffix}`), product: 'claude_code', surface: 'cli', execution_host: 'local', session_hash: sha(`${session}:${suffix}`), session_identity: 'provider',
        model_actual: model, observed_at: at, input_fresh_tokens: 100, input_cached_tokens: 0, input_cache_write_tokens: 0, output_tokens: 10,
        basis: 'exact', outcome: 'completed', parser_version: '2.0.0', content_hash: sha(randomUUID()), ...extra })}`;
    await request(bindingA, 'rA', 'sA', '2026-09-02T14:10:00Z', 'm1', { reasoning_effort: 'high', agent_key: mainKey, agent_identity_basis: 'provider', parent_agent_identity_basis: 'none', agent_class: 'main', agent_depth: 0, project_basis: 'none' });
    await request(bindingB, 'rB', 'sB', '2026-09-03T14:10:00Z', 'm2', { reasoning_effort: 'low', surface: 'desktop', agent_key: childKey, agent_identity_basis: 'provider', parent_agent_key: mainKey, parent_agent_identity_basis: 'provider', agent_class: 'builtin', agent_name: 'Explore', agent_depth: 1 });
    const tool = (binding: string, invocation: string, caller: string, agent: string, session: string, at: string) =>
      sql`INSERT INTO personal_hub.tool_events ${sql({ id: randomUUID(), account_id: account, binding_id: binding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file', record_id: randomUUID(),
        semantic_key: sha(`tool:${invocation}:${suffix}`), invocation_key: sha(`tool:${invocation}:${suffix}`), event_kind: 'invocation', session_hash: sha(`${session}:${suffix}`),
        caller_request_key: sha(`${caller}:${suffix}`), caller_agent_key: agent, tool_name: 'Read', tool_class: 'builtin', outcome: 'unknown', basis: 'exact', observed_at: at, parser_version: '2.0.0', content_hash: sha(randomUUID()) })}`;
    await tool(bindingA, 'tA', 'rA', mainKey, 'sA', '2026-09-02T14:12:00Z');
    await tool(bindingB, 'tB', 'rB', childKey, 'sB', '2026-09-03T14:12:00Z');
    const access = (binding: string, invocation: string, kind: string, at: string) =>
      sql`INSERT INTO personal_hub.resource_accesses ${sql({ id: randomUUID(), account_id: account, binding_id: binding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file', record_id: randomUUID(),
        semantic_key: sha(`access:${invocation}:${suffix}`), invocation_key: sha(`tool:${invocation}:${suffix}`), resource_key: `vault.${suffix}`, configuration_version: 'cfg:1', access_kind: kind, evidence_basis: 'explicit_argument',
        outcome: 'succeeded', basis: 'exact', observed_at: at, parser_version: '2.0.0', content_hash: sha(randomUUID()) })}`;
    await access(bindingA, 'tA', 'read', '2026-09-02T14:12:00Z');
    await access(bindingB, 'tB', 'search', '2026-09-03T14:12:00Z');
    const spawn = (binding: string, seed: string, agent: string, at: string) =>
      sql`INSERT INTO personal_hub.agent_events ${sql({ id: randomUUID(), account_id: account, binding_id: binding, provider: 'claude', adapter: 'claude_execution', channel: 'local_file', record_id: randomUUID(),
        semantic_key: sha(`${seed}:${suffix}`), event_kind: 'spawn', session_hash: sha(`sA:${suffix}`), outcome: 'succeeded', basis: 'exact', observed_at: at, parser_version: '2.0.0', content_hash: sha(randomUUID()),
        agent_key: agent, agent_identity_basis: 'provider', parent_agent_key: mainKey, parent_agent_identity_basis: 'provider', agent_class: 'builtin', agent_name: 'Explore', agent_depth: 1 })}`;
    await spawn(bindingA, 'spawn-a', childKey, '2026-09-02T14:11:00Z');
    await spawn(bindingB, 'spawn-b', otherChildKey, '2026-09-03T14:11:00Z');

    // These fixtures write personal_hub.activity_requests directly rather than through `ingestUsage`,
    // so nothing has maintained the canonical projections the reads now use. Refreshing it here is the
    // same rule production follows: any path that writes the ledger outside ingest rebuilds after it.
    await refreshCanonicalProjections(sql);
    const query = (extra: Record<string, unknown> = {}) => layer.usageQuery(parseUsageQuery(new URLSearchParams(Object.entries({ ...SEPTEMBER, accounts: account, ...extra }).map(([k, v]) => [k, String(v)]))), { now: NOW });
    const vault = (result: Awaited<ReturnType<typeof query>>) => result.knowledge.rows.map(r => [r.label, r.accesses, r.distinct_invocations, r.distinct_sessions, r.distinct_agents, r.by_access_kind.read, r.by_access_kind.search]);

    const all = await query();
    assert.deepEqual(vault(all), [['Shared vault', 2, 2, 2, 2, 1, 1]]);
    const childGroup = all.agents.rows.find(r => r.name === 'Explore')!.group_id, mainGroup = all.agents.rows.find(r => r.name === 'main')!.group_id;
    assert.deepEqual([all.knowledge.distinct_invocations, all.knowledge.unsupported_filters, all.agents.summary.spawns], [2, [], 2]);
    assert.match(all.knowledge.note, /follow the account, machine, and agent filters/);

    // Machine: the access's own binding, without ranking any request.
    const machineA = await query({ machines: sourceA });
    assert.deepEqual([vault(machineA), machineA.knowledge.distinct_invocations, machineA.knowledge.unsupported_filters, machineA.agents.summary.spawns], [[['Shared vault', 1, 1, 1, 1, 1, 0]], 1, [], 1]);
    assert.deepEqual(vault(await query({ machines: sourceB, section: 'knowledge' })), [['Shared vault', 1, 1, 1, 1, 0, 1]], 'the sectioned read applies the same machine filter');
    // Agent: the invocation's caller, and the spawn event's own agent key.
    const child = await query({ agents: childGroup });
    assert.deepEqual([vault(child), child.knowledge.distinct_invocations, child.agents.summary.spawns, child.tools.invocations], [[['Shared vault', 1, 1, 1, 1, 0, 1]], 1, 1, 1], 'knowledge and tools agree on the agent');
    const main = await query({ agents: mainGroup });
    assert.deepEqual([vault(main), main.agents.summary.spawns], [[['Shared vault', 1, 1, 1, 1, 1, 0]], 0], 'the main agent read the vault and spawned under its own key nothing');
    assert.equal((await query({ agents: otherChildKey })).agents.summary.spawns, 0, 'a key that never made a request has no group, so it selects nothing');
    // Detail filters reach accesses through the calling request, exactly as tools apply them.
    assert.deepEqual(vault(await query({ efforts: 'high' })), [['Shared vault', 1, 1, 1, 1, 1, 0]]);
    assert.deepEqual(vault(await query({ surfaces: 'desktop' })), [['Shared vault', 1, 1, 1, 1, 0, 1]]);
    assert.deepEqual(vault(await query({ agent_scope: 'subagent' })), [['Shared vault', 1, 1, 1, 1, 0, 1]]);
    assert.deepEqual(vault(await query({ agent_scope: 'main' })), [['Shared vault', 1, 1, 1, 1, 1, 0]]);
    assert.deepEqual(vault(await query({ projects: 'no_project' })), [['Shared vault', 1, 1, 1, 1, 1, 0]]);
    assert.deepEqual(vault(await query({ machines: sourceB, efforts: 'high' })), [], 'dimensions AND together: machine B\'s only access was a low-effort request');
    const detail = await query({ efforts: 'high' });
    assert.deepEqual([detail.knowledge.unsupported_filters, detail.tools.unsupported_filters], [
      ['detail filters apply through the calling request; invocations without a retained caller request are excluded'],
      ['detail filters apply through the calling request; invocations without a retained caller request are excluded']]);
    assert.match(detail.agents.coverage.note, /the efforts filter does not apply to them/);
    // A model filter alone is reported by both areas rather than applied; with a detail filter it applies through the request.
    const model = await query({ models: 'm2' });
    assert.deepEqual([vault(model), model.knowledge.unsupported_filters, model.tools.unsupported_filters], [[['Shared vault', 2, 2, 2, 2, 1, 1]], ['models'], ['models']]);
    assert.match(model.knowledge.note, /The model filter is not applied to knowledge accesses/);
    assert.deepEqual(vault(await query({ models: 'm2', agent_scope: 'subagent' })), [['Shared vault', 1, 1, 1, 1, 0, 1]]);
    assert.deepEqual(vault(await query({ models: 'm1', agent_scope: 'subagent' })), []);
  } finally {
    await sql.end({ timeout: 1 });
  }
});
