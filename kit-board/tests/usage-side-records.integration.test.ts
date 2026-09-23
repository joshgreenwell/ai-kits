import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { usageEnvelopeSchema, usageResponseSchema, labelText, LABEL_MAX_CHARS, PROJECT_NAME_MAX_CHARS, type UsageEnvelope } from '../lib/usage-contract';

/**
 * Server half of the app-project and readable-name work (spec sections 3, 5, 6 and 8.2): ingest of the
 * three side record types (I1, I2, I6), the md5-to-uuid parity (I3), the projection grants (I4, I5), the
 * DB CHECKs under both collations (C2), and the reads that resolve projects, agent groups and nested tool
 * calls (Q1 to Q4). Every name, key and machine label here is synthetic.
 */
const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
const hname = (seed: string) => `h:${sha(seed).slice(0, 16)}`;
const bearer = (key: string) => new Request('http://localhost/api/v1/usage', { headers: { authorization: `Bearer ${key}` } });
const NOW = Date.parse('2026-09-14T20:30:00Z');
const SEPTEMBER = { preset: 'custom', start: '2026-09-01T05:00:00Z', end: '2026-09-14T20:30:00Z' };

const run = () => ({ run_id: randomUUID(), started_at: '2026-09-02T04:00:00.000Z', finished_at: '2026-09-02T04:00:02.500Z', companion_version: '2.2.0', platform: 'linux', arch: 'amd64', settings_version: 1 });
const envelope = (records: unknown[]) => usageEnvelopeSchema.parse({ schema_version: 2, run: run(), buckets: [], records, coverage: [] }) as UsageEnvelope;
const header = (binding_id: string, adapter = 'codex_execution', observed_at = '2026-09-02T03:20:00.000Z') => ({ record_id: randomUUID(), binding_id, adapter, observed_at, parser_version: '2.2.0' });
const catalog = (binding: string, key: string, name: string, observed_at?: string, state = 'active') =>
  ({ ...header(binding, 'codex_execution', observed_at), record_type: 'project.catalog', app: 'codex_desktop', project_key: key, name, position: 0, state });
const membership = (binding: string, member_kind: string, member_key: string, project_key: string | null, resolution: string, observed_at?: string) =>
  ({ ...header(binding, 'codex_execution', observed_at), record_type: 'project.membership', member_kind, member_key, project_key, resolution });
const label = (binding: string, kind: string, key: string, text: string, observed_at?: string, role: string | null = null, parent_key: string | null = null) =>
  ({ ...header(binding, 'codex_execution', observed_at), record_type: 'name.label', kind, key, label: text, role, parent_key });
const request = (binding_id: string, seed: string, adapter = 'claude_execution') => ({ ...header(binding_id, adapter), channel: 'local_file', basis: 'exact', parser_version: '2.0.0', record_type: 'activity.request',
  semantic_key: sha(seed), product: 'claude_code', surface: 'cli', execution_host: 'local', session_hash: sha(`session:${seed}`), session_identity: 'provider', parent_session_hash: null,
  model_requested: null, model_actual: 'fixture-model', started_at: null, ended_at: null,
  tokens: { input_fresh: 10, input_cached: 0, input_cache_write: 0, output: 5, reasoning: null }, tool_calls: null, project_hash: null, client_version: null, latency_ms: null, outcome: 'completed' });
const toolEvent = (binding_id: string, invocation: string, parent: string | null) => ({ ...header(binding_id, 'claude_execution'), channel: 'local_file', basis: 'exact', parser_version: '2.0.0',
  record_type: 'tool.event', semantic_key: sha(`tool:${invocation}`), invocation_key: sha(`tool:${invocation}`), event_kind: 'invocation', session_hash: sha('session'),
  caller_request_key: null, caller_agent_key: null, parent_invocation_key: parent, tool: { name: 'Read', namespace: null, class: 'builtin' }, outcome: 'unknown' });

async function pairedInstall(store: Awaited<ReturnType<typeof storeFor>>, machine: string) {
  const issued = await store.issuePairingCode({ machine_label: machine });
  const paired = await store.pairInstall({ code: issued.code, machine_label: machine, kind: 'companion', platform: 'linux', arch: 'amd64' }, '203.0.113.20');
  return { install: await store.companionInstall(bearer(paired.key)), key: paired.key };
}
async function storeFor(sql: ReturnType<typeof postgres>) {
  const { createUsageStore } = await import('../lib/usage-store');
  return createUsageStore(() => sql);
}

maybe('I1 I6: a mixed envelope applies what it can, defers one failing row, and rejects nothing', async () => {
  // Run as the application role, so every grant and RLS policy the side tables need is exercised.
  const app = postgres(url!, { ...options, username: 'personal_hub_app' });
  const admin = postgres(url!, options);
  const store = await storeFor(app);
  const suffix = randomUUID().slice(0, 8);
  const failingKey = hname(`failing:${suffix}`);
  try {
    const { install } = await pairedInstall(store, `side-host-${suffix}`);
    const codex = (await store.createBinding(install, { account_id: `codex-side-${suffix}`, provider: 'codex', account_label: 'Side codex', identity_hash: null })).binding.binding_id;
    const claude = (await store.createBinding(install, { account_id: `claude-side-${suffix}`, provider: 'claude', account_label: 'Side claude', identity_hash: null })).binding.binding_id;

    // I6 first: an envelope with ledger records only answers with exactly the bytes an older companion expects.
    const plain = await store.ingestUsage(install, envelope([request(claude, `plain:${suffix}`)]));
    assert.deepEqual(Object.keys(plain), ['ok', 'schema_version', 'run_id', 'accepted', 'duplicates', 'rejected'], 'no deferred_record_ids key when nothing was deferred');
    assert.equal(usageResponseSchema.safeParse(plain).success, true);

    // One label this test makes the database refuse, so the batch fails and the row-by-row retry must isolate it.
    await admin.unsafe(`ALTER TABLE personal_hub.usage_name_labels ADD CONSTRAINT test_injected_failure CHECK (key <> '${failingKey}')`);
    const keyA = sha(`app-project:a:${suffix}`), keyB = sha(`app-project:b:${suffix}`), unknownProject = sha(`app-project:unknown:${suffix}`);
    const toolKey = hname(`tool:${suffix}`);
    const newer = label(codex, 'tool', toolKey, 'Newer name', '2026-09-02T03:30:00.000Z');
    const older = label(codex, 'tool', toolKey, 'Older name', '2026-09-02T03:10:00.000Z');
    const failing = label(codex, 'tool_namespace', failingKey, 'Refused name');
    const records = [
      request(claude, `ledger-a:${suffix}`), request(claude, `ledger-b:${suffix}`),
      newer, older, failing,
      catalog(codex, keyA, `Fixture Alpha ${suffix}`), catalog(codex, keyB, `fixture alpha ${suffix}`),
      membership(codex, 'working_directory', sha(`folder:${suffix}`), unknownProject, 'root_prefix'),
      membership(codex, 'session', sha(`session:${suffix}`), null, 'projectless'),
    ];
    const receipt = await store.ingestUsage(install, envelope(records));
    assert.equal(receipt.ok, true);
    assert.deepEqual([receipt.accepted.records, receipt.duplicates, receipt.rejected], [2, 0, []], 'the ledger records are accepted exactly as they would be alone, and nothing is rejected');
    assert.deepEqual((receipt as { deferred_record_ids?: string[] }).deferred_record_ids, [failing.record_id], 'only the refused label is deferred');
    assert.equal(usageResponseSchema.safeParse(receipt).success, true);

    const labels = await admin`SELECT kind, key, label FROM personal_hub.usage_name_labels WHERE install_id = ${install.id} ORDER BY kind, key`;
    assert.deepEqual(labels.map(r => [r.kind, r.key, r.label]), [['tool', toolKey, 'Newer name']], 'duplicate keys collapse to the newest observation');
    const projects = await admin`SELECT project_key, name, project_id FROM personal_hub.usage_app_projects WHERE install_id = ${install.id} ORDER BY name`;
    assert.equal(projects.length, 2, 'both app projects are stored');
    assert.equal(projects[0].project_id, projects[1].project_id, 'names that differ only in case merge into one project');
    assert.equal(Number((await admin`SELECT count(*) FROM personal_hub.usage_projects WHERE id = ${projects[0].project_id}`)[0].count), 1);
    const members = await admin`SELECT member_kind, project_key, resolution FROM personal_hub.usage_project_memberships WHERE install_id = ${install.id} ORDER BY member_kind`;
    assert.deepEqual(members.map(r => [r.member_kind, r.project_key, r.resolution]), [['session', null, 'projectless'], ['working_directory', unknownProject, 'root_prefix']],
      'a membership naming a project the server has not seen is kept');
    const [deferral] = await admin`SELECT record_type, target_key, occurrences, reason FROM personal_hub.usage_side_record_deferrals WHERE install_id = ${install.id}`;
    assert.deepEqual([deferral.record_type, deferral.target_key, deferral.occurrences], ['name.label', `tool_namespace:${failingKey}`, 1]);
    assert.match(deferral.reason as string, /^23514: /, 'the reason names the SQLSTATE');
    assert.ok((await admin`SELECT 1 FROM personal_hub.usage_project_reports WHERE install_id = ${install.id}`).length, 'the install is marked as reporting projects');
    const [runRow] = await admin`SELECT accepted_by_type FROM personal_hub.companion_runs WHERE install_id = ${install.id} ORDER BY received_at DESC LIMIT 1`;
    const byType = runRow.accepted_by_type as Record<string, Record<string, number>>;
    assert.deepEqual([byType['name.label'].accepted, byType['name.label'].duplicate, byType['name.label'].deferred], [1, 1, 1]);
    assert.deepEqual([byType['project.catalog'].accepted, byType['project.membership'].accepted, byType['activity.request'].accepted], [2, 2, 2]);

    // A replay writes nothing new and defers the refused row again; an older observation never overwrites a newer one.
    const replay = await store.ingestUsage(install, envelope([{ ...newer, record_id: randomUUID() }, { ...failing }]));
    assert.deepEqual((replay as { deferred_record_ids?: string[] }).deferred_record_ids, [failing.record_id]);
    assert.equal(Number((await admin`SELECT occurrences FROM personal_hub.usage_side_record_deferrals WHERE install_id = ${install.id}`)[0].occurrences), 2);
    await store.ingestUsage(install, envelope([label(codex, 'tool', toolKey, 'Stale name', '2026-09-01T00:00:00.000Z')]));
    assert.equal((await admin`SELECT label FROM personal_hub.usage_name_labels WHERE install_id = ${install.id} AND key = ${toolKey}`)[0].label, 'Newer name');
    await store.ingestUsage(install, envelope([label(codex, 'tool', toolKey, 'Renamed', '2026-09-03T00:00:00.000Z')]));
    assert.equal((await admin`SELECT label FROM personal_hub.usage_name_labels WHERE install_id = ${install.id} AND key = ${toolKey}`)[0].label, 'Renamed', 'a newer observation replaces the label');
    const installs = await store.listInstalls();
    assert.deepEqual(installs.installs.find(entry => entry.id === install.id)!.names, { labels: 'needs_update', deferrals_8d: 1 },
      'Settings > Companion counts deferrals; a build that has not reported the labels feature still needs 2.2.0');
  } finally {
    await admin.unsafe('ALTER TABLE personal_hub.usage_name_labels DROP CONSTRAINT IF EXISTS test_injected_failure');
    await app.end({ timeout: 1 }); await admin.end({ timeout: 1 });
  }
});

maybe('I2: binding state never costs a side record, but a foreign binding and a browser install still do', async () => {
  const sql = postgres(url!, options);
  const store = await storeFor(sql);
  const suffix = randomUUID().slice(0, 8);
  try {
    const { install } = await pairedInstall(store, `state-host-${suffix}`);
    const codex = (await store.createBinding(install, { account_id: `codex-state-${suffix}`, provider: 'codex', account_label: 'State codex', identity_hash: sha(`identity:${suffix}`) })).binding.binding_id;
    const other = await pairedInstall(store, `other-host-${suffix}`);
    const foreign = (await store.createBinding(other.install, { account_id: `codex-foreign-${suffix}`, provider: 'codex', account_label: 'Foreign', identity_hash: null })).binding.binding_id;

    await store.updateInstall({ id: install.id, action: 'binding_disable', binding_id: codex });
    const disabled = label(codex, 'agent', sha(`agent:${suffix}`), 'worker', undefined, 'subagent');
    const onDisabled = await store.ingestUsage(install, envelope([disabled]));
    assert.deepEqual([onDisabled.rejected, (onDisabled as { deferred_record_ids?: string[] }).deferred_record_ids], [[], undefined], 'a disabled binding still carries names');
    await store.updateInstall({ id: install.id, action: 'binding_enable', binding_id: codex });
    await store.updateInstall({ id: install.id, action: 'approve_identity', binding_id: codex });
    const afterReset = catalog(codex, sha(`project:${suffix}`), `Reset project ${suffix}`);
    const ledgerAfterReset = request(codex, `after-reset:${suffix}`, 'codex_execution');
    const reset = await store.ingestUsage(install, envelope([afterReset, ledgerAfterReset]));
    assert.deepEqual(reset.rejected, [{ record_id: ledgerAfterReset.record_id, reason: 'identity_changed' }], 'the identity rule still refuses the ledger record, and only it');
    assert.equal((await sql`SELECT count(*)::int AS n FROM personal_hub.usage_app_projects WHERE install_id = ${install.id}`)[0].n, 1, 'the catalog record is applied');
    assert.equal((await sql`SELECT count(*)::int AS n FROM personal_hub.usage_name_labels WHERE install_id = ${install.id}`)[0].n, 1);

    const stranger = membership(foreign, 'session', sha(`s:${suffix}`), null, 'projectless');
    assert.deepEqual((await store.ingestUsage(install, envelope([stranger]))).rejected, [{ record_id: stranger.record_id, reason: 'binding_not_owned' }]);

    const issued = await store.issuePairingCode({ machine_label: `browser-${suffix}`, kind: 'browser' });
    const pairedBrowser = await store.pairInstall({ code: issued.code, machine_label: `browser-${suffix}`, kind: 'browser', platform: 'linux', arch: 'unknown' }, '203.0.113.21');
    const browser = await store.companionInstall(bearer(pairedBrowser.key));
    const browserBinding = (await store.createBinding(browser, { account_id: `claude-browser-${suffix}`, provider: 'claude', account_label: 'Browser', identity_hash: null })).binding.binding_id;
    const fromBrowser = { ...label(browserBinding, 'tool', hname(`b:${suffix}`), 'Browser tool'), adapter: 'claude_browser' };
    assert.deepEqual((await store.ingestUsage(browser, envelope([fromBrowser]))).rejected, [{ record_id: fromBrowser.record_id, reason: 'record_type_not_allowed_for_install' }]);
  } finally { await sql.end({ timeout: 1 }); }
});

maybe('I3: the JS and SQL app-project id derivations agree', async () => {
  const { appProjectId, appProjectIdSql } = await import('../lib/usage-app-projects');
  const sql = postgres(url!, options);
  try {
    const migration = readFileSync('supabase/migrations/20260923090100_usage_app_projects.sql', 'utf8');
    assert.match(migration, /md5\('app-project-name:' \|\| lower\(btrim\(name\)\)\)/, 'the migration documents the same derivation');
    for (const name of ['Fixture Alpha', 'fixture alpha', '  padded name  ', 'Mixed-Case_Name.2', 'Café Numéro Deux', 'Ünïcode Straße', 'Ωmega project', '項目 fixture', 'emoji 🚀 name']) {
      const [row] = await sql.unsafe(`SELECT ${appProjectIdSql('$1::text')}::text AS id`, [name]);
      assert.equal(row.id, appProjectId(name), name);
    }
    assert.equal(appProjectId('Fixture Alpha'), appProjectId('fixture alpha'), 'case folds to one id');
    assert.match(appProjectId('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { await sql.end({ timeout: 1 }); }
});

maybe('I4 I5: every projection column the upserts assign is granted, and a nested tool event lands with its parent', async () => {
  const { TOOL_INVOCATION_COLUMNS, TOOL_RESULT_COLUMNS, PROJECTION_COLUMNS, toolColumnBackfill } = await import('../lib/usage-canonical');
  const admin = postgres(url!, options);
  const app = postgres(url!, { ...options, username: 'personal_hub_app' });
  const suffix = randomUUID().slice(0, 8);
  try {
    const granted = async (table: string) => new Set((await admin`SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = 'personal_hub' AND table_name = ${table} AND grantee = 'personal_hub_app' AND privilege_type = 'UPDATE'`).map(r => r.column_name as string));
    const tool = await granted('canonical_tool_invocations');
    assert.deepEqual([...TOOL_INVOCATION_COLUMNS, ...TOOL_RESULT_COLUMNS, 'updated_at'].filter(column => !tool.has(column)), [], 'an ungranted column fails every tool envelope with 42501');
    const requests = await granted('canonical_requests');
    assert.deepEqual([...PROJECTION_COLUMNS, 'updated_at'].filter(column => !requests.has(column)), []);
    const migration = readFileSync('supabase/migrations/20260923090200_tool_invocation_parent.sql', 'utf8').replace(/\s+/g, ' ');
    assert.ok(migration.includes(toolColumnBackfill().replace(/\s+/g, ' ')), 'the backfill is generated from lib/usage-canonical.ts; regenerate with scripts/generate-canonical-backfill.mjs');
    const nullable = await admin`SELECT p.is_nullable AS projection, s.is_nullable AS source FROM information_schema.columns p
      JOIN information_schema.columns s ON s.table_schema = 'personal_hub' AND s.table_name = 'tool_events' AND s.column_name = p.column_name
      WHERE p.table_schema = 'personal_hub' AND p.table_name = 'canonical_tool_invocations' AND p.column_name = 'parent_invocation_key'`;
    assert.deepEqual(nullable.map(r => [r.projection, r.source]), [['YES', 'YES']], 'the projection column is never stricter than its source');

    // I5, through the application role end to end.
    const store = await storeFor(app);
    const { install } = await pairedInstall(store, `tool-host-${suffix}`);
    const account = `claude-tool-${suffix}`;
    const binding = (await store.createBinding(install, { account_id: account, provider: 'claude', account_label: 'Tool', identity_hash: null })).binding.binding_id;
    const parent = sha(`tool:parent:${suffix}`);
    const receipt = await store.ingestUsage(install, envelope([toolEvent(binding, `parent:${suffix}`, null), toolEvent(binding, `child:${suffix}`, parent)]));
    assert.deepEqual([receipt.accepted.records, receipt.rejected], [2, []]);
    const [row] = await admin`SELECT parent_invocation_key FROM personal_hub.canonical_tool_invocations WHERE account_id = ${account} AND invocation_key = ${sha(`tool:child:${suffix}`)}`;
    assert.equal(row.parent_invocation_key, parent);
    // The recompute step is idempotent: it only writes a row whose column differs.
    await admin`UPDATE personal_hub.canonical_tool_invocations SET parent_invocation_key = NULL WHERE account_id = ${account}`;
    await admin.unsafe(toolColumnBackfill());
    const [repaired] = await admin`SELECT parent_invocation_key FROM personal_hub.canonical_tool_invocations WHERE account_id = ${account} AND invocation_key = ${sha(`tool:child:${suffix}`)}`;
    assert.equal(repaired.parent_invocation_key, parent, 'the backfill repairs a row the pre-deploy code wrote without the column');
  } finally { await app.end({ timeout: 1 }); await admin.end({ timeout: 1 }); }
});

/** A deterministic generator over the characters that make display text hard: controls, format characters, every space, astral text. */
function* candidates(count: number) {
  let seed = 0x5eed;
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const pools = [[0x20, 0x7e], [0x00, 0x1f], [0x7f, 0x9f], [0xa0, 0xff], [0x2000, 0x206f], [0x3000, 0x3003], [0xfeff, 0xfeff], [0x0300, 0x036f],
    [0x4e00, 0x4e40], [0x1f300, 0x1f340], [0xe000, 0xe010], [0xfff0, 0xfffd], [0x0600, 0x0605], [0x180e, 0x180e], [0x2028, 0x2029], [0x85, 0x85], [0xad, 0xad]];
  for (let i = 0; i < count; i++) {
    const length = 1 + (next() % (i % 50 === 0 ? 210 : 12));
    let text = '';
    for (let j = 0; j < length; j++) {
      const [lo, hi] = pools[next() % pools.length];
      text += String.fromCodePoint(lo + (next() % (hi - lo + 1)));
    }
    yield text;
  }
}

maybe('C2: every label and name the contract accepts passes the database CHECKs under ICU and libc collations', async () => {
  const labelCheck = "char_length(label) BETWEEN 1 AND 200 AND label = btrim(label) AND label !~ '[[:cntrl:]]'";
  const nameCheck = "char_length(name) BETWEEN 1 AND 80 AND name = btrim(name) AND name !~ '[[:cntrl:]]'";
  assert.ok(readFileSync('supabase/migrations/20260923090000_usage_name_labels.sql', 'utf8').includes(labelCheck), 'the label CHECK under test is the migration\'s');
  assert.ok(readFileSync('supabase/migrations/20260923090100_usage_app_projects.sql', 'utf8').includes(nameCheck), 'the name CHECK under test is the migration\'s');
  const labelSchema = labelText(LABEL_MAX_CHARS), nameSchema = labelText(PROJECT_NAME_MAX_CHARS);
  const accepted = { labels: [] as string[], names: [] as string[] };
  for (const text of candidates(8_000)) {
    // Trimmed variants too, so the accepted population is not only the texts that happen to start clean.
    for (const value of [text, text.trim(), text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim()]) {
      if (labelSchema.safeParse(value).success) accepted.labels.push(value);
      if (nameSchema.safeParse(value).success) accepted.names.push(value);
    }
  }
  assert.ok(accepted.labels.length > 2_000 && accepted.names.length > 2_000, `the generator reaches accepted text (${accepted.labels.length} labels, ${accepted.names.length} names)`);
  const admin = postgres(url!, { ...options, database: 'postgres' });
  const suffix = randomUUID().slice(0, 8).replaceAll('-', '');
  const databases = [
    { name: `c2_icu_${suffix}`, create: `LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'en_US.utf8'` },
    { name: `c2_libc_${suffix}`, create: `LOCALE_PROVIDER libc LOCALE 'en_US.utf8'` },
  ];
  try {
    for (const database of databases) {
      await admin.unsafe(`CREATE DATABASE ${database.name} TEMPLATE template0 ENCODING 'UTF8' ${database.create}`);
      const db = postgres(url!, { ...options, database: database.name });
      try {
        const [provider] = await db`SELECT datlocprovider AS provider FROM pg_database WHERE datname = current_database()`;
        assert.equal(provider.provider, database.name.includes('icu') ? 'i' : 'c', `${database.name} uses the intended locale provider`);
        const failed = async (check: string, column: string, values: string[]) =>
          (await db.unsafe(`SELECT v FROM unnest($1::text[]) AS t(v) WHERE NOT (${check.replaceAll(column, 'v')})`, [values])).map(row => row.v as string);
        assert.deepEqual(await failed(labelCheck, 'label', accepted.labels), [], `${database.name}: an accepted label fails the label CHECK`);
        assert.deepEqual(await failed(nameCheck, 'name', accepted.names), [], `${database.name}: an accepted name fails the name CHECK`);
      } finally { await db.end({ timeout: 1 }); }
    }
  } finally {
    for (const database of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${database.name}`).catch(() => {});
    await admin.end({ timeout: 1 });
  }
});

/** Seeds one account per provider on an install, with request and tool rows written directly (then projected). */
async function seedReads(sql: ReturnType<typeof postgres>, suffix: string) {
  const { appProjectId } = await import('../lib/usage-app-projects');
  const install = randomUUID(), laggard = randomUUID();
  const accounts = { codex: `rq-codex-${suffix}`, claude: `rq-claude-${suffix}`, cursor: `rq-cursor-${suffix}`, laggard: `rq-lag-${suffix}` };
  const sources = { codex: randomUUID(), claude: randomUUID(), cursor: randomUUID(), laggard: randomUUID() };
  const bindings = { codex: randomUUID(), claude: randomUUID(), cursor: randomUUID(), laggard: randomUUID() };
  await sql`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${accounts.codex}, 'codex', 'Codex fixture'), (${accounts.claude}, 'claude', 'Claude fixture'),
    (${accounts.cursor}, 'cursor', 'Cursor fixture'), (${accounts.laggard}, 'codex', 'Laggard fixture')`;
  await sql`INSERT INTO personal_hub.companion_installs (id, machine_label, kind, platform, arch, key_hash) VALUES
    (${install}, ${`reads-host-${suffix}`}, 'companion', 'linux', 'amd64', ${sha(randomUUID())}), (${laggard}, ${`old-host-${suffix}`}, 'companion', 'darwin', 'arm64', ${sha(randomUUID())})`;
  for (const provider of ['codex', 'claude', 'cursor', 'laggard'] as const) {
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash, last_seen_at) VALUES
      (${sources[provider]}, ${accounts[provider]}, 'host', 'companion', ${sha(randomUUID())}, '2026-09-14T20:10:00Z')`;
    await sql`INSERT INTO personal_hub.companion_bindings (id, install_id, account_id, source_id, provider, identity_hash) VALUES
      (${bindings[provider]}, ${provider === 'laggard' ? laggard : install}, ${accounts[provider]}, ${sources[provider]}, ${provider === 'laggard' ? 'codex' : provider}, ${sha(`id:${provider}:${suffix}`)})`;
  }
  const adapter = { codex: 'codex_execution', claude: 'claude_execution', cursor: 'cursor_execution', laggard: 'codex_execution' };
  const product = { codex: 'codex_cli', claude: 'claude_code', cursor: 'cursor', laggard: 'codex_cli' };
  const request = (provider: keyof typeof accounts, seed: string, tokens: number, extra: Record<string, unknown> = {}) =>
    sql`INSERT INTO personal_hub.activity_requests ${sql({ id: randomUUID(), account_id: accounts[provider], binding_id: bindings[provider], provider: provider === 'laggard' ? 'codex' : provider,
      adapter: adapter[provider], channel: 'local_file', record_id: randomUUID(), semantic_key: sha(`${seed}:${suffix}`), product: product[provider], surface: 'cli', execution_host: 'local',
      session_hash: sha(`session:${seed}:${suffix}`), session_identity: 'provider', model_actual: 'fixture-model', observed_at: '2026-09-03T14:00:00Z',
      input_fresh_tokens: tokens, input_cached_tokens: 0, input_cache_write_tokens: 0, output_tokens: 0, basis: 'exact', outcome: 'completed', parser_version: '2.0.0',
      content_hash: sha(randomUUID()), ...extra })}`;
  const folder = (seed: string) => ({ project_basis: 'working_directory', project_key: sha(`folder:${seed}:${suffix}`), project_hash: sha(`folder:${seed}:${suffix}`) });
  return { install, laggard, accounts, sources, bindings, request, folder, appProjectId,
    session: (seed: string) => sha(`session:${seed}:${suffix}`), folderKey: (seed: string) => sha(`folder:${seed}:${suffix}`) };
}

maybe('Q1 Q2: project states from app catalogs and memberships, session over folder, and a removed project keeps its history', async () => {
  const { createUsageQuery, parseUsageQuery } = await import('../lib/usage-query');
  const { refreshCanonicalProjections } = await import('../lib/usage-canonical');
  const sql = postgres(url!, options);
  const layer = createUsageQuery(() => sql);
  const store = await storeFor(sql);
  const suffix = randomUUID().slice(0, 8);
  try {
    const seed = await seedReads(sql, suffix);
    const nameA = `Fixture Alpha ${suffix}`, nameB = `Fixture Beta ${suffix}`;
    const idA = seed.appProjectId(nameA), idB = seed.appProjectId(nameB);
    const keyA = sha(`app:a:${suffix}`), keyB = sha(`app:b:${suffix}`);
    await sql`INSERT INTO personal_hub.usage_projects (id, label) VALUES (${idA}, ${nameA}), (${idB}, ${nameB})`;
    await sql`INSERT INTO personal_hub.usage_app_projects (install_id, project_key, app, name, position, state, project_id, observed_at) VALUES
      (${seed.install}, ${keyA}, 'codex_desktop', ${nameA}, 0, 'active', ${idA}, '2026-09-02T00:00:00Z'),
      (${seed.install}, ${keyB}, 'codex_desktop', ${nameB}, 1, 'active', ${idB}, '2026-09-02T00:00:00Z')`;
    await sql`INSERT INTO personal_hub.usage_project_reports (install_id) VALUES (${seed.install})`;
    const member = (kind: string, key: string, project: string | null, resolution: string) =>
      sql`INSERT INTO personal_hub.usage_project_memberships (install_id, member_kind, member_key, project_key, resolution, observed_at)
        VALUES (${seed.install}, ${kind}, ${key}, ${project}, ${resolution}, '2026-09-02T00:00:00Z')`;
    // Every row of the section 6.1 table, plus session-over-folder precedence.
    await seed.request('codex', 'none', 1, { project_basis: 'none' });                                   // no_project
    await seed.request('codex', 'by-session', 2, seed.folder('outside'));                                // session says A, folder says outside
    await member('session', seed.session('by-session'), keyA, 'app_assignment');
    await member('working_directory', seed.folderKey('outside'), null, 'outside_roots');
    await seed.request('claude', 'by-folder', 4, seed.folder('inside-a'));                               // folder root_prefix -> A
    await member('working_directory', seed.folderKey('inside-a'), keyA, 'root_prefix');
    await seed.request('codex', 'chat', 8, seed.folder('chat-folder'));                                   // projectless chat
    await member('session', seed.session('chat'), null, 'projectless');
    await seed.request('claude', 'outside', 16, seed.folder('outside'));                                  // unassigned (outside_roots)
    await seed.request('cursor', 'no-folder', 32);                                                       // unassigned (no_folder)
    await member('session', seed.session('no-folder'), null, 'no_folder');
    await seed.request('claude', 'missing', 64, seed.folder('missing'));                                  // unassigned (unknown app project)
    await member('working_directory', seed.folderKey('missing'), sha(`app:missing:${suffix}`), 'root_prefix');
    await seed.request('claude', 'unplaced', 128, seed.folder('unplaced'));                               // unknown (reported install)
    await seed.request('laggard', 'old', 256, seed.folder('old'));                                        // not_reported
    await seed.request('codex', 'beta', 512, seed.folder('inside-b'));                                    // B
    await member('working_directory', seed.folderKey('inside-b'), keyB, 'worktree_root_prefix');
    await refreshCanonicalProjections(sql);

    const accounts = Object.values(seed.accounts).join(',');
    const query = (extra: Record<string, string> = {}) => layer.usageQuery(parseUsageQuery(new URLSearchParams({ ...SEPTEMBER, accounts, ...extra })), { now: NOW });
    const rows = (result: Awaited<ReturnType<typeof query>>) => result.projects.rows.map(r => [r.state, r.label, r.total_tokens]).sort((a, b) => Number(a[2]) - Number(b[2]));
    const all = await query({ section: 'requests' });
    assert.deepEqual(rows(all), [
      ['no_project', null, 1],
      ['project', nameA, 2 + 4],
      ['no_project', 'Chats / no project', 8],
      ['unassigned', null, 16 + 32 + 64],
      ['unknown', null, 128],
      ['not_reported', `old-host-${suffix}: companion update needed`, 256],
      ['project', nameB, 512],
    ], 'every state of the table, with the session membership winning over the folder');
    assert.equal(all.projects.rows.find(r => r.label === nameA)!.project_id, idA);
    assert.equal((await query({ projects: idA })).headline.total_tokens, 6, 'the project filter takes the derived id');
    assert.equal((await query({ projects: 'not_reported' })).headline.total_tokens, 256);
    // Each state row applies a filter value of its own, so selecting a row narrows to exactly that row.
    const valueOf = (label: string | null, state: string) => all.projects.rows.find(r => r.label === label && r.state === state)!.filter_value;
    assert.deepEqual([valueOf(null, 'no_project'), valueOf('Chats / no project', 'no_project'), valueOf(`old-host-${suffix}: companion update needed`, 'not_reported'), valueOf(nameA, 'project')],
      ['no_project', 'projectless', `not_reported:${seed.laggard}`, idA]);
    assert.equal((await query({ projects: 'no_project' })).headline.total_tokens, 1, 'No project is the explicit row only');
    assert.equal((await query({ projects: 'projectless' })).headline.total_tokens, 8, 'Chats / no project has its own filter');
    assert.equal((await query({ projects: `not_reported:${seed.laggard}` })).headline.total_tokens, 256, 'a machine row filters to that machine');
    assert.equal((await query({ projects: `not_reported:${seed.install}` })).headline.total_tokens, 0, 'another machine matches none of it');
    assert.equal((await query({ projects: 'unassigned', machines: seed.sources.claude })).headline.total_tokens, 80, 'the map follows the machine filter');

    const stats = await store.listProjectStats();
    const alpha = stats.projects.find(p => p.id === idA)!;
    assert.deepEqual([alpha.name, alpha.requests, alpha.sessions, alpha.folders, alpha.apps], [nameA, 2, 2, 2, ['codex_desktop']]);
    assert.ok(stats.not_in_project.projectless >= 1 && stats.not_in_project.outside_roots >= 1 && stats.not_in_project.no_folder >= 1
      && stats.not_in_project.missing_project >= 1 && stats.not_in_project.not_reported >= 1 && stats.not_in_project.unknown >= 1 && stats.not_in_project.no_project >= 1,
      'Settings lists every reason a request is in no project');
    assert.ok((await store.listProjects()).projects.some(p => p.id === idA && p.label === nameA), 'the Tokens filter offers the app project');

    // Q2: the app removes B. Its history is kept whole and labelled, and the filter no longer offers it.
    const before = await query();
    await sql`UPDATE personal_hub.usage_app_projects SET state = 'removed', observed_at = '2026-09-10T00:00:00Z' WHERE install_id = ${seed.install} AND project_key = ${keyB}`;
    const after = await query({ section: 'requests' });
    const beta = after.projects.rows.find(r => r.project_id === idB)!;
    assert.deepEqual([beta.label, beta.total_tokens], [`${nameB} (removed)`, 512]);
    assert.deepEqual(after.projects.rows.map(r => r.total_tokens).sort(), before.projects.rows.map(r => r.total_tokens).sort(), 'all-time sums are unchanged');
    const { createUsageStore } = await import('../lib/usage-store');
    const fresh = createUsageStore(() => sql);
    assert.equal((await fresh.listProjects()).projects.some(p => p.id === idB), false);
    assert.ok((await fresh.listProjectStats()).removed.some(p => p.id === idB && p.name === `${nameB} (removed)` && p.requests === 1));
  } finally { await sql.end({ timeout: 1 }); }
});

maybe('Q3: agent groups round-trip whatever their name holds, filter every section, and follow a labelled role', async () => {
  const { createUsageQuery, parseUsageQuery } = await import('../lib/usage-query');
  const { refreshCanonicalProjections } = await import('../lib/usage-canonical');
  const sql = postgres(url!, options);
  const layer = createUsageQuery(() => sql);
  const suffix = randomUUID().slice(0, 8);
  try {
    const seed = await seedReads(sql, suffix);
    const odd = sha(`agent:odd:${suffix}`), guardian = sha(`agent:guardian:${suffix}`), main = sha(`agent:main:${suffix}`);
    const agent = (key: string, klass: string, depth: number, name: string | null = null) => ({ agent_key: key, agent_identity_basis: 'provider', parent_agent_identity_basis: 'none', agent_class: klass, agent_depth: depth, agent_name: name });
    await seed.request('codex', 'main', 100, agent(main, 'main', 0));
    await seed.request('codex', 'odd', 10, { ...agent(odd, 'custom', 1, hname(`odd:${suffix}`)), parent_agent_key: main, parent_agent_identity_basis: 'provider' });
    await seed.request('codex', 'guardian', 1, agent(guardian, 'main', 0));                              // the ledger says main
    await sql`INSERT INTO personal_hub.usage_name_labels (install_id, kind, key, label, role, parent_key, observed_at) VALUES
      (${seed.install}, 'agent_name', ${hname(`odd:${suffix}`)}, 'alpha,beta|gamma', NULL, NULL, now()),
      (${seed.install}, 'agent', ${guardian}, 'guardian', 'subagent', NULL, now())`;
    await sql`INSERT INTO personal_hub.tool_events ${sql({ id: randomUUID(), account_id: seed.accounts.codex, binding_id: seed.bindings.codex, provider: 'codex', adapter: 'codex_execution',
      channel: 'local_file', record_id: randomUUID(), semantic_key: sha(`tool:odd:${suffix}`), invocation_key: sha(`tool:odd:${suffix}`), event_kind: 'invocation', session_hash: seed.session('odd'),
      caller_request_key: sha(`odd:${suffix}`), caller_agent_key: odd, tool_name: 'exec', tool_class: 'builtin', outcome: 'succeeded', basis: 'exact',
      observed_at: '2026-09-03T14:01:00Z', parser_version: '2.0.0', content_hash: sha(randomUUID()) })}`;
    await refreshCanonicalProjections(sql);
    const base = { ...SEPTEMBER, accounts: seed.accounts.codex };
    const query = (params: string) => layer.usageQuery(parseUsageQuery(new URLSearchParams(params)), { now: NOW });
    const all = await layer.usageQuery(parseUsageQuery(new URLSearchParams(base)), { now: NOW });
    const oddRow = all.agents.rows.find(r => r.name === 'alpha,beta|gamma')!;
    assert.deepEqual([oddRow.provider, oddRow.role, oddRow.builtin, oddRow.instances], ['codex', 'subagent', false, 1], 'an agent_name label names a hashed custom agent');
    const guardianRow = all.agents.rows.find(r => r.name === 'guardian')!;
    assert.deepEqual([guardianRow.role, guardianRow.builtin], ['subagent', true], 'an agent label overrides the ledger role, and guardian is a known built-in');
    const filtered = await query(`${new URLSearchParams(base)}&agents=${oddRow.group_id}`);
    assert.deepEqual([filtered.scope.filters.agents, filtered.headline.total_tokens], [[oddRow.group_id], 10], 'a group id is opaque hex, so a comma or | in the name cannot split it');
    for (const section of ['tools', 'knowledge'] as const) {
      const sectioned = await query(`${new URLSearchParams({ ...base, section })}&agents=${oddRow.group_id}`);
      assert.ok(sectioned, `${section} answers under an agent filter`);
    }
    const tools = await query(`${new URLSearchParams({ ...base, section: 'tools' })}&agents=${oddRow.group_id}`);
    assert.deepEqual([tools.tools.invocations, tools.tools.by_caller.map(c => [c.state, c.name])], [1, [['group', 'alpha,beta|gamma']]], 'callers are named by their group');
    const scoped = await query(new URLSearchParams({ ...base, agent_scope: 'subagent' }).toString());
    assert.equal(scoped.headline.total_tokens, 11, 'agent_scope=subagent includes the guardian-labelled row');
    const mainOnly = await query(new URLSearchParams({ ...base, agent_scope: 'main' }).toString());
    assert.equal(mainOnly.headline.total_tokens, 100);
    assert.equal(all.agents.summary.subagent_tokens, 11, 'the summary splits by the displayed role, the same partition as the filter');
  } finally { await sql.end({ timeout: 1 }); }
});

maybe('Q4: nested Codex MCP calls fold under their exec, other parent links stay top-level, and an out-of-range exec keeps its children', async () => {
  const { createUsageQuery, parseUsageQuery } = await import('../lib/usage-query');
  const { refreshCanonicalProjections } = await import('../lib/usage-canonical');
  const sql = postgres(url!, options);
  const layer = createUsageQuery(() => sql);
  const suffix = randomUUID().slice(0, 8);
  try {
    const seed = await seedReads(sql, suffix);
    const tool = (provider: 'codex' | 'claude', invocation: string, name: string, klass: string, at: string, parent: string | null, namespace: string | null = null, outcome = 'succeeded') =>
      sql`INSERT INTO personal_hub.tool_events ${sql({ id: randomUUID(), account_id: seed.accounts[provider], binding_id: seed.bindings[provider], provider, adapter: `${provider}_execution`,
        channel: 'local_file', record_id: randomUUID(), semantic_key: sha(`tool:${invocation}:${suffix}`), invocation_key: sha(`tool:${invocation}:${suffix}`), event_kind: 'invocation',
        session_hash: sha(`s:${suffix}`), caller_request_key: null, caller_agent_key: null, parent_invocation_key: parent ? sha(`tool:${parent}:${suffix}`) : null,
        tool_name: name, tool_namespace: namespace, tool_class: klass, outcome, basis: 'exact', observed_at: at, parser_version: '2.0.0', content_hash: sha(randomUUID()) })}`;
    const db = hname(`ns:db:${suffix}`), connector = hname(`ns:connector:${suffix}`), query_ = hname(`tool:query:${suffix}`);
    // A connector namespace's label is the full `codex_apps:<app>` text: the companion keeps the prefix so
    // the read can tell a connector from an MCP server that happens to share the app's name.
    await sql`INSERT INTO personal_hub.usage_name_labels (install_id, kind, key, label, role, parent_key, observed_at) VALUES
      (${seed.install}, 'tool_namespace', ${db}, 'fixture-db', NULL, NULL, now()),
      (${seed.install}, 'tool_namespace', ${connector}, 'codex_apps:Fixture Sheets', NULL, NULL, now()),
      (${seed.install}, 'tool', ${query_}, 'run_query', NULL, NULL, now())`;
    await tool('codex', 'exec-1', 'exec', 'builtin', '2026-09-03T14:00:00Z', null);
    await tool('codex', 'child-1', query_, 'mcp', '2026-09-03T14:00:05Z', 'exec-1', db);
    await tool('codex', 'child-2', query_, 'mcp', '2026-09-03T14:00:06Z', 'exec-1', db, 'failed');
    await tool('codex', 'child-3', 'list_rows', 'mcp', '2026-09-03T14:00:07Z', 'exec-1', connector);
    await tool('codex', 'exec-old', 'exec', 'builtin', '2026-08-03T14:00:00Z', null);                   // outside the range
    await tool('codex', 'child-old', 'list_rows', 'mcp', '2026-09-03T14:10:00Z', 'exec-old', connector);
    await tool('codex', 'child-lost', 'list_rows', 'mcp', '2026-09-03T14:11:00Z', 'never-arrived', connector);
    await tool('claude', 'task', 'Task', 'builtin', '2026-09-03T14:20:00Z', null);
    await tool('claude', 'claude-child', 'Read', 'builtin', '2026-09-03T14:21:00Z', 'task');             // a parent_tool_use_id link
    const unnamedHash = hname(`tool:unnamed:${suffix}`);
    // A second unlabeled tool whose hash shares the first four hex digits: it shows the same short text but is a different tool.
    const twinHash = `${unnamedHash.slice(0, 6)}${unnamedHash.endsWith('0'.repeat(12)) ? 'f'.repeat(12) : '0'.repeat(12)}`;
    await tool('codex', 'unnamed', unnamedHash, 'custom', '2026-09-03T14:30:00Z', null);
    await tool('codex', 'twin', twinHash, 'custom', '2026-09-03T14:31:00Z', null);
    await refreshCanonicalProjections(sql);
    const result = await layer.usageQuery(parseUsageQuery(new URLSearchParams({ ...SEPTEMBER, accounts: `${seed.accounts.codex},${seed.accounts.claude}`, section: 'tools' })), { now: NOW });
    const byName = (name: string) => result.tools.by_tool.find(r => r.name === name);
    assert.equal(result.tools.invocations, 10, 'every in-range invocation counts once, children included');
    const exec = byName('exec')!;
    assert.deepEqual([exec.invocations, exec.builtin, exec.synthetic], [1, true, false], 'the exec counts itself, not its children');
    assert.deepEqual(exec.children.map(c => [c.namespace, c.name, c.invocations, c.outcomes]), [
      ['fixture-db', 'run_query', 2, { succeeded: 1, failed: 1 }],
      ['Fixture Sheets (connector)', 'list_rows', 1, { succeeded: 1 }],
    ], 'children group by labelled namespace and tool, and a codex_apps namespace reads as a connector');
    const orphan = byName('exec (outside range)')!;
    assert.deepEqual([orphan.invocations, orphan.synthetic, orphan.children.map(c => [c.name, c.invocations])], [0, true, [['list_rows', 2]]],
      'a child whose exec is outside the range or never arrived never vanishes');
    assert.deepEqual([byName('Read')?.invocations, byName('Task')?.invocations], [1, 1], 'a Claude parent link stays top-level');
    assert.equal(result.tools.by_tool.some(r => r.name === 'run_query' || r.name === 'list_rows'), false, 'no child appears at top level');
    const unnamed = result.tools.by_tool.filter(r => r.name?.startsWith('h:'));
    assert.deepEqual(unnamed.map(r => [r.name, r.machine, r.invocations]), [[`${unnamedHash.slice(0, 6)}…`, `reads-host-${suffix}`, 1], [`${unnamedHash.slice(0, 6)}…`, `reads-host-${suffix}`, 1]],
      'an unlabeled hash reads short, with its machine, and two tools sharing the short text stay two rows');
  } finally { await sql.end({ timeout: 1 }); }
});
