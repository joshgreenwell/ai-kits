#!/usr/bin/env node
// The readings renderer lives in kit-readings/render-readings.mjs. This forwarder keeps a schedule that
// still runs the old path working; remove it once the readings task runs the kit's copy.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('../../kit-readings/render-readings.mjs', import.meta.url));
const { status, error } = spawnSync(process.execPath, [renderer, ...process.argv.slice(2)], { stdio: 'inherit' });
if (error) throw error;
process.exit(status ?? 1);
