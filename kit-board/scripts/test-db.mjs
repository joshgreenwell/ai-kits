#!/usr/bin/env node
// Disposable-PostgreSQL integration runner: applies every migration in order, then runs the
// contract tests and every tests/*.integration.test.ts against the fresh cluster.
// Uses local `initdb`/`pg_ctl` when they are on PATH (CI), else a `postgres:17-alpine` Docker
// container bound to loopback (developer machines without PostgreSQL tools).
//
// supabase/migrations/ holds one file since the September 22, 2026 squash: the baseline that
// recreates the whole schema. The seventeen files it replaced are in
// supabase/migrations-archive/ with their own README. The upgrade fixtures below are keyed to
// the archived filename each one belongs before, so they seed nothing against the baseline and
// still work if that sequence is ever applied through this runner; the two tests that read
// them skip themselves when they are absent.
//
// One row is not an upgrade fixture and is seeded either way: the synthetic companion install.
// It was buried in the usage-detail fixture, but tests/usage-store.integration.test.ts needs it
// as the `install_id` its grant test points the two identity tables at, and that test asserts a
// property of the schema, not of an upgrade. Leaving it inside the fixture made the baseline run
// fail on a foreign key. See seedSharedInstall.
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';

const run = promisify(execFile);
const root = process.cwd();
const port = String(55440 + Math.floor(Math.random() * 100));
const databaseName = 'personal_hub_test';
// Archived filename -> the fixture that must exist before it applies. See migrations-archive/README.md.
const upgradeFixtures = new Map([
  ['20260913230451_extend_usage_detail_contract.sql', seedUsageDetailUpgradeFixture],
  ['20260914003000_knowledge_source_registry.sql', seedKnowledgeSourceUpgradeFixture],
  ['20260914010000_allowance_basis_and_run_counts.sql', seedAllowanceBasisUpgradeFixture],
  ['20260921090000_request_ledger_revision_uniqueness.sql', seedRequestLedgerReplayFixture],
]);

// The shared synthetic install. Every upgrade fixture hangs off it and so does the grant test in
// tests/usage-store.integration.test.ts, which runs against whatever supabase/migrations/ built.
// Seeded before the first upgrade fixture when the archived sequence is replayed, and after the
// migrations otherwise; idempotent so both paths can call it.
async function seedSharedInstall(db) {
  await db.unsafe(`
    INSERT INTO personal_hub.companion_installs
      (id, machine_label, kind, platform, arch, key_hash)
      VALUES ('00000000-0000-4000-8000-000000000302', 'Synthetic upgrade fixture',
        'companion', 'linux', 'amd64', repeat('2', 64))
      ON CONFLICT (id) DO NOTHING;
  `);
}

async function seedUsageDetailUpgradeFixture(db) {
  // Synthetic row accepted by the original bucket schema. Its reasoning count is
  // intentionally above output so the next migration must preserve it without
  // weakening enforcement for subsequent writes. The install these rows hang off is
  // seeded separately by seedSharedInstall.
  await db.unsafe(`
    INSERT INTO personal_hub.usage_accounts (id, provider, label)
      VALUES ('migration-upgrade-legacy', 'claude', 'Migration upgrade legacy fixture');
    INSERT INTO personal_hub.telemetry_sources
      (id, account_id, machine_label, mode, key_hash)
      VALUES ('00000000-0000-4000-8000-000000000301', 'migration-upgrade-legacy',
        'Synthetic upgrade fixture', 'companion', repeat('1', 64));
    INSERT INTO personal_hub.companion_bindings
      (id, install_id, account_id, source_id, provider, identity_hash)
      VALUES ('00000000-0000-4000-8000-000000000303',
        '00000000-0000-4000-8000-000000000302', 'migration-upgrade-legacy',
        '00000000-0000-4000-8000-000000000301', 'claude', repeat('3', 64));
    INSERT INTO personal_hub.account_usage_buckets
      (id, account_id, binding_id, provider, adapter, report_source,
       bucket_start, bucket_end, provider_timezone, model, product, client,
       user_ref, workspace_ref, api_key_ref, dimensions_hash, requests,
       input_tokens, cached_tokens, cache_write_tokens, output_tokens,
       reasoning_tokens, total_tokens, provider_event_id, provider_refreshed_at,
       basis, observed_at, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000304', 'migration-upgrade-legacy',
        '00000000-0000-4000-8000-000000000303', 'claude', 'claude_account',
        'migration_upgrade_probe', '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z',
        'UTC', 'synthetic-model', 'claude_code', NULL, NULL, NULL, NULL,
        repeat('4', 64), 1, 0, 0, 0, 1, 2, 1, 'legacy-reasoning-above-output',
        '2026-09-01T01:01:00Z', 'reported', '2026-09-01T01:01:00Z', repeat('5', 64));
    INSERT INTO personal_hub.activity_requests
      (id, account_id, binding_id, provider, adapter, channel, record_id,
       semantic_key, product, surface, execution_host, session_hash,
       session_identity, model_actual, observed_at, input_fresh_tokens,
       input_cached_tokens, input_cache_write_tokens, output_tokens,
       reasoning_tokens, basis, project_hash, outcome, parser_version, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000330', 'migration-upgrade-legacy',
        '00000000-0000-4000-8000-000000000303', 'claude', 'claude_execution',
        'local_file', '00000000-0000-4000-8000-000000000331', repeat('a', 64),
        'claude_code', 'cli', 'local', repeat('b', 64), 'provider', 'synthetic-model',
        '2026-09-01T01:02:00Z', 1, 0, 0, 1, NULL, 'exact', repeat('c', 64),
        'completed', '1.0.0', repeat('d', 64));
  `);
}

async function seedKnowledgeSourceUpgradeFixture(db) {
  // Two retained resource accesses for one key on the synthetic install, accepted
  // before the registry existed. The row received last carries the newer
  // configuration but the older observation, so the backfill must take the
  // version by receipt order and the sighting bounds by observation.
  await db.unsafe(`
    INSERT INTO personal_hub.resource_accesses
      (id, account_id, binding_id, provider, adapter, channel, record_id,
       semantic_key, invocation_key, resource_key, configuration_version,
       access_kind, evidence_basis, outcome, basis, observed_at, parser_version,
       received_at, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000340', 'migration-upgrade-legacy',
        '00000000-0000-4000-8000-000000000303', 'claude', 'claude_execution',
        'local_file', '00000000-0000-4000-8000-000000000341', repeat('e', 64),
        repeat('1', 64), 'legacy.vault', 'legacy.v1', 'read', 'explicit_argument',
        'succeeded', 'exact', '2026-09-01T01:02:00Z', '1.0.0', '2026-09-01T01:05:00Z',
        repeat('3', 64));
    INSERT INTO personal_hub.resource_accesses
      (id, account_id, binding_id, provider, adapter, channel, record_id,
       semantic_key, invocation_key, resource_key, configuration_version,
       access_kind, evidence_basis, outcome, basis, observed_at, parser_version,
       received_at, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000342', 'migration-upgrade-legacy',
        '00000000-0000-4000-8000-000000000303', 'claude', 'claude_execution',
        'local_file', '00000000-0000-4000-8000-000000000343', repeat('f', 64),
        repeat('2', 64), 'legacy.vault', 'legacy.v0', 'search', 'indirect_shell',
        'unknown', 'exact', '2026-09-01T01:04:00Z', '1.0.0', '2026-09-01T01:03:00Z',
        repeat('4', 64));
  `);
}

async function seedAllowanceBasisUpgradeFixture(db) {
  // A percent reading and a run accepted before the readings ledger kept `basis` and runs
  // counted uploads per type. The migration must surface the reading as reported through
  // the recreated view and leave the run's per-type counts empty rather than invented.
  await db.unsafe(`
    INSERT INTO personal_hub.allowance_readings
      (id, account_id, binding_id, provider, adapter, reader, meter_key, label, kind,
       value, unit, capacity, window_minutes, window_started_at, resets_at, raw_window_id,
       observed_at, received_at, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000350', 'migration-upgrade-legacy',
        '00000000-0000-4000-8000-000000000303', 'claude', 'claude_execution', 'statusline',
        'five_hour', 'Claude · 5h', 'percent_used', 30, 'percent', NULL, 300, NULL,
        '2026-09-01T05:00:00Z', 'five_hour', '2026-09-01T01:06:00Z', '2026-09-01T01:07:00Z',
        repeat('5', 64));
    INSERT INTO personal_hub.companion_runs
      (id, install_id, run_id, started_at, finished_at, companion_version, settings_version,
       coverage, accepted_buckets, accepted_records, rejected_records, received_at)
      VALUES ('00000000-0000-4000-8000-000000000351', '00000000-0000-4000-8000-000000000302',
        '00000000-0000-4000-8000-000000000352', '2026-09-01T01:05:00Z', '2026-09-01T01:07:00Z',
        '1.0.0', 1, '[]'::jsonb, 0, 1, 0, '2026-09-01T01:07:00Z');
  `);
}

async function seedRequestLedgerReplayFixture(db) {
  // The Cursor replay shape accepted before the ledger collapsed sightings: one record re-emitted by
  // three hourly runs with identical content and only observed_at/ended_at (and so content_hash)
  // moving, plus a fourth row of the same record whose content differs (a real revision), and a
  // Claude pair differing only in ended_at that the migration must leave alone. The earliest
  // sighting arrived last so the rule is visibly observed_at, not receipt order. The Cursor rows carry
  // the buggy reader's own parser version, which the migration requires: a row from the fixed reader
  // must survive a rerun even when its content matches a collapsed sighting.
  await db.unsafe(`
    INSERT INTO personal_hub.activity_requests
      (id, account_id, binding_id, provider, adapter, channel, record_id, semantic_key, product, surface,
       execution_host, session_hash, session_identity, model_actual, started_at, ended_at, observed_at,
       input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens, reasoning_tokens,
       basis, outcome, parser_version, received_at, content_hash)
    SELECT ('00000000-0000-4000-8000-0000000003' || suffix)::uuid, 'migration-upgrade-legacy',
      '00000000-0000-4000-8000-000000000303'::uuid, 'cursor', 'cursor_execution', 'local_db',
      '00000000-0000-4000-8000-000000000361'::uuid, repeat('1', 64), 'cursor', 'ide', 'local', repeat('2', 64),
      'derived', model, NULL, at, at, 0, 0, 0, 0, NULL, 'exact', 'completed', '2.0.0+cursor-local1', received, hash
    FROM (VALUES
      ('62', NULL, '2026-09-03T01:00:00Z'::timestamptz, '2026-09-03T03:05:00Z'::timestamptz, repeat('6', 64)),
      ('63', NULL, '2026-09-03T02:00:00Z'::timestamptz, '2026-09-03T02:05:00Z'::timestamptz, repeat('7', 64)),
      ('64', NULL, '2026-09-03T03:00:00Z'::timestamptz, '2026-09-03T01:05:00Z'::timestamptz, repeat('8', 64)),
      ('65', 'cursor-synthetic-model', '2026-09-03T04:00:00Z'::timestamptz, '2026-09-03T04:05:00Z'::timestamptz, repeat('9', 64))
    ) AS replay(suffix, model, at, received, hash);
    INSERT INTO personal_hub.activity_requests
      (id, account_id, binding_id, provider, adapter, channel, record_id, semantic_key, product, surface,
       execution_host, session_hash, session_identity, model_actual, started_at, ended_at, observed_at,
       input_fresh_tokens, input_cached_tokens, input_cache_write_tokens, output_tokens, reasoning_tokens,
       basis, outcome, parser_version, received_at, content_hash)
    SELECT ('00000000-0000-4000-8000-0000000003' || suffix)::uuid, 'migration-upgrade-legacy',
      '00000000-0000-4000-8000-000000000303'::uuid, 'claude', 'claude_execution', 'local_file',
      '00000000-0000-4000-8000-000000000366'::uuid, repeat('3', 64), 'claude_code', 'cli', 'local', repeat('4', 64),
      'provider', 'synthetic-model', NULL, ended, '2026-09-03T01:02:00Z'::timestamptz, 1, 0, 0, 1, NULL, 'exact', 'completed',
      '1.0.0', '2026-09-03T01:05:00Z'::timestamptz, hash
    FROM (VALUES
      ('67', '2026-09-03T01:00:00Z'::timestamptz, repeat('e', 64)),
      ('68', '2026-09-03T02:00:00Z'::timestamptz, repeat('f', 64))
    ) AS pair(suffix, ended, hash);
  `);
}

async function onPath(file) {
  try { await run(process.platform === 'win32' ? 'where' : 'which', [file]); return true; } catch { return false; }
}
async function command(file, args, options = {}) {
  try { return await run(file, args, { cwd: root, ...options }); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Tool ${file} was not found on PATH.`);
    throw error;
  }
}

function localBackend() {
  let temporary, data, socket, started = false;
  return {
    name: 'local PostgreSQL tools',
    async start() {
      temporary = await mkdtemp(join(tmpdir(), 'personal-hub-db-'));
      data = join(temporary, 'data'); socket = join(temporary, 'socket');
      await mkdir(socket);
      await command('initdb', ['-D', data, '-A', 'trust', '--no-locale']);
      await command('pg_ctl', ['-D', data, '-l', join(temporary, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses='' -p ${port}`, '-w', 'start']);
      started = true;
      return { options: { host: socket, port: Number(port) }, env: { TEST_DATABASE_URL: `postgres://localhost/${databaseName}`, TEST_DATABASE_HOST: socket, TEST_DATABASE_PORT: port } };
    },
    async stop() {
      if (started) await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => {});
      if (temporary) await rm(temporary, { recursive: true, force: true });
    },
  };
}

function dockerBackend() {
  const name = `personal-hub-test-${port}`;
  let started = false;
  return {
    name: 'Docker (postgres:17-alpine)',
    async start() {
      await command('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=postgres', '-p', `127.0.0.1:${port}:5432`, 'postgres:17-alpine']);
      started = true;
      const options = { host: '127.0.0.1', port: Number(port), username: 'postgres' };
      for (let attempt = 0; attempt < 60; attempt++) {
        const probe = postgres({ ...options, database: 'postgres', prepare: false, connect_timeout: 2 });
        try { await probe`SELECT 1`; await probe.end({ timeout: 1 }); break; }
        catch { await probe.end({ timeout: 1 }).catch(() => {}); await new Promise(resolve => setTimeout(resolve, 1000)); }
        if (attempt === 59) throw new Error('PostgreSQL container did not become ready');
      }
      return { options, env: { TEST_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/${databaseName}` } };
    },
    async stop() { if (started) await command('docker', ['stop', name]).catch(() => {}); },
  };
}

const backend = (await onPath('initdb') && await onPath('pg_ctl')) ? localBackend() : (await onPath('docker')) ? dockerBackend() : null;
if (!backend) { console.error('Neither local PostgreSQL tools (initdb, pg_ctl) nor docker is available.'); process.exit(1); }
console.log(`Using ${backend.name} on port ${port}.`);
try {
  const { options, env } = await backend.start();
  const admin = postgres({ ...options, database: 'postgres', prepare: false });
  await admin.unsafe('CREATE ROLE anon; CREATE ROLE authenticated;');
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  await admin.end({ timeout: 1 });
  const db = postgres({ ...options, database: databaseName, prepare: false });
  const migrations = (await readdir(join(root, 'supabase/migrations'))).filter(file => file.endsWith('.sql')).sort();
  let seeded = 0;
  for (const migration of migrations) {
    const fixture = upgradeFixtures.get(migration);
    if (fixture) { await seedSharedInstall(db); await fixture(db); seeded++; }
    await db.file(join(root, 'supabase/migrations', migration));
  }
  await seedSharedInstall(db);
  await db.end({ timeout: 1 });
  console.log(`Applied ${migrations.length} migration${migrations.length === 1 ? '' : 's'}`
    + `, ${seeded} upgrade fixture${seeded === 1 ? '' : 's'} seeded.`);
  const tests = (await readdir(join(root, 'tests'))).filter(file => file.endsWith('.integration.test.ts') || file.endsWith('-contract.test.ts')).sort().map(file => `tests/${file}`);
  // One file at a time: the files share one database and its global settings version, so a
  // browser-collector pause running beside the store test made the store's version and ETag
  // assertions race.
  await command(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests], { env: {
    ...process.env, ...env,
    ROUTING_TEST_DATABASE_URL: env.TEST_DATABASE_URL, ...(env.TEST_DATABASE_HOST ? { ROUTING_TEST_DATABASE_HOST: env.TEST_DATABASE_HOST, ROUTING_TEST_DATABASE_PORT: env.TEST_DATABASE_PORT } : {}),
  }, stdio: 'inherit' });
  console.log('Database integration passed.');
} finally {
  await backend.stop();
}
