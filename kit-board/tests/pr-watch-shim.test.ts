import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// The runner and its own tests live in kit-pr-watch/. This checks only that the old path still runs it.
test('scripts/pr-watch.mjs runs the PR watch kit\'s runner with its arguments and exit status', () => {
  const unknown = spawnSync(process.execPath, ['scripts/pr-watch.mjs', 'unknown-command'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Commands: tick, check, keygen, install, uninstall, status/);
  const check = spawnSync(process.execPath, ['scripts/pr-watch.mjs', 'check', 'not-a-link'], { encoding: 'utf8' });
  assert.equal(check.status, 1);
  assert.match(check.stdout, /Usage: node pr-watch\.mjs check/);
});
