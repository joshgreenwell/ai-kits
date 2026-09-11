import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('readings renderer preserves sections and only makes HTTPS links clickable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-hub-readings-'));
  const input = join(directory, 'source.json');
  const output = join(directory, 'report.html');
  writeFileSync(input, JSON.stringify({
    source: 'Claude scheduled task',
    markdown: 'Daily readings — 2026-09-07\n\nExecutive Snapshot\n• *Important* <https://example.com/path|safe link>\n\nWatchlist\nA [markdown link](https://example.org) and <http://unsafe.example|unsafe link>.\n',
  }));
  execFileSync(process.execPath, ['scripts/render-readings.mjs', '--file', input, '--output', output], { cwd: process.cwd() });
  const html = readFileSync(output, 'utf8');
  assert.match(html, /href="#executive-snapshot"/);
  assert.match(html, /id="watchlist"/);
  assert.match(html, /href="https:\/\/example\.com\/path" target="_blank"/);
  assert.match(html, /href="https:\/\/example\.org\/" target="_blank"/);
  assert.doesNotMatch(html, /href="http:\/\/unsafe/);
  assert.match(html, /&lt;http:\/\/unsafe\.example\|unsafe link&gt;/);
});
