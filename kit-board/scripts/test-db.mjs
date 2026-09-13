#!/usr/bin/env node
// Disposable-PostgreSQL integration runner: applies every migration in order, then runs the
// contract tests and every tests/*.integration.test.ts against the fresh cluster.
// Uses local `initdb`/`pg_ctl` when they are on PATH (CI), else a `postgres:17-alpine` Docker
// container bound to loopback (developer machines without PostgreSQL tools).
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
  for (const migration of migrations) await db.file(join(root, 'supabase/migrations', migration));
  await db.end({ timeout: 1 });
  console.log(`Applied ${migrations.length} migrations.`);
  const tests = (await readdir(join(root, 'tests'))).filter(file => file.endsWith('.integration.test.ts') || file.endsWith('-contract.test.ts')).sort().map(file => `tests/${file}`);
  await command(process.execPath, ['--import', 'tsx', '--test', ...tests], { env: {
    ...process.env, ...env,
    ROUTING_TEST_DATABASE_URL: env.TEST_DATABASE_URL, ...(env.TEST_DATABASE_HOST ? { ROUTING_TEST_DATABASE_HOST: env.TEST_DATABASE_HOST, ROUTING_TEST_DATABASE_PORT: env.TEST_DATABASE_PORT } : {}),
  }, stdio: 'inherit' });
  console.log('Database integration passed.');
} finally {
  await backend.stop();
}
