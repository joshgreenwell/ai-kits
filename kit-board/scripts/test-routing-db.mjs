#!/usr/bin/env node
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'personal-hub-routing-'));
const data = join(temporary, 'data');
const socket = join(temporary, 'socket');
const port = '55440';
let started = false;

async function command(file, args, options = {}) {
  try { return await run(file, args, { cwd: root, ...options }); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Local PostgreSQL tool ${file} was not found on PATH.`);
    throw error;
  }
}

try {
  await mkdir(socket);
  await command('initdb', ['-D', data, '-A', 'trust', '--no-locale']);
  await command('pg_ctl', ['-D', data, '-l', join(temporary, 'postgres.log'), '-o', `-k ${socket} -c listen_addresses='' -p ${port}`, '-w', 'start']);
  started = true;
  await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-d', 'postgres', '-c', 'CREATE ROLE anon; CREATE ROLE authenticated;']);
  await command('createdb', ['-h', socket, '-p', port, 'routing_test']);
  for (const migration of (await readdir(join(root, 'supabase/migrations'))).filter(file => file.endsWith('.sql')).sort()) {
    await command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', port, '-d', 'routing_test', '-f', join(root, 'supabase/migrations', migration)]);
  }
  await command(process.execPath, ['--import', 'tsx', '--test', 'tests/routing-contract.test.ts', 'tests/routing-store.integration.test.ts'], { env: {
    ...process.env, ROUTING_TEST_DATABASE_URL: 'postgres://localhost/routing_test', ROUTING_TEST_DATABASE_HOST: socket, ROUTING_TEST_DATABASE_PORT: port,
  } });
  console.log('Routing database integration passed.');
} finally {
  if (started) await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
