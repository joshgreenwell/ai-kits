import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The renderer and its own tests live in kit-readings/. This checks only that the old path still forwards.
test('scripts/render-readings.mjs forwards its arguments and exit status to the readings kit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readings-shim-'));
  const source = join(directory, 'source.json');
  const output = join(directory, 'report.html');
  writeFileSync(source, JSON.stringify({ markdown: '# Daily readings — 2026-09-28\n\nWatchlist\n• <https://example.com/a|A link>\n' }));
  const rendered = spawnSync(process.execPath, ['scripts/render-readings.mjs', '--file', source, '--output', output], { encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(readFileSync(output, 'utf8'), /<h1>Daily readings — 2026-09-28<\/h1>/);

  writeFileSync(source, JSON.stringify({ markdown: ' ' }));
  const blank = spawnSync(process.execPath, ['scripts/render-readings.mjs', '--file', source, '--output', output], { encoding: 'utf8' });
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /non-empty markdown/);
});
