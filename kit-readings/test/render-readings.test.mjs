import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const kit = fileURLToPath(new URL('..', import.meta.url));
const renderer = join(kit, 'render-readings.mjs');

function render(input) {
  const directory = mkdtempSync(join(tmpdir(), 'kit-readings-'));
  const source = join(directory, 'source.json');
  const output = join(directory, 'report.html');
  writeFileSync(source, JSON.stringify(input));
  execFileSync(process.execPath, [renderer, '--file', source, '--output', output]);
  return readFileSync(output, 'utf8');
}

test('readings renderer preserves sections and only makes HTTPS links clickable', () => {
  const html = render({
    source: 'Example scheduled task',
    markdown: 'Daily readings — 2026-09-07\n\nExecutive Snapshot\n• *Important* <https://example.com/path|safe link>\n\nWatchlist\nA [markdown link](https://example.org) and <http://unsafe.example|unsafe link>.\n',
  });
  assert.match(html, /href="#executive-snapshot"/);
  assert.match(html, /id="watchlist"/);
  assert.match(html, /href="https:\/\/example\.com\/path" target="_blank"/);
  assert.match(html, /href="https:\/\/example\.org\/" target="_blank"/);
  assert.doesNotMatch(html, /href="http:\/\/unsafe/);
  assert.match(html, /&lt;http:\/\/unsafe\.example\|unsafe link&gt;/);
});

test('readings renderer reads the standard markdown that the Mac task publishes', () => {
  const html = render({
    markdown: '# Daily Tech / AI / Crypto Snapshot — 2026-09-23\nEmail checked: Yes\nWeb checked: Yes\n## Worth Looking At\n**[AI] A release — Lab**\nLink: [Notes](https://example.com/notes)\nSummary: Uses *care*, `a_b_c`, and snake_case_name.\n',
  });
  assert.match(html, /<h1>Daily Tech \/ AI \/ Crypto Snapshot — 2026-09-23<\/h1>/);
  assert.match(html, /Email checked: Yes<br>Web checked: Yes/);
  assert.match(html, /<p><strong>\[AI\] A release — Lab<\/strong><br>Link: <a href="https:\/\/example\.com\/notes"/);
  assert.match(html, /Uses <em>care<\/em>, <code>a_b_c<\/code>, and snake_case_name\./);
});

test('every valid payload renders, since the renderer reads the same file the publisher posts', () => {
  const directory = join(kit, 'fixtures/valid');
  const files = readdirSync(directory).filter(name => name.endsWith('.json'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const { payload } = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    const html = render(payload);
    assert.match(html, /^<!doctype html>/, name);
    assert.match(html, /<h1>[^<]+<\/h1>/, name);
    assert.doesNotMatch(html, /<script/i, name);
  }
});

test('readings renderer refuses a blank edition and wrong arguments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kit-readings-'));
  const source = join(directory, 'source.json');
  writeFileSync(source, JSON.stringify({ markdown: '  \n' }));
  const blank = spawnSync(process.execPath, [renderer, '--file', source, '--output', join(directory, 'report.html')], { encoding: 'utf8' });
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /non-empty markdown/);
  const usage = spawnSync(process.execPath, [renderer, '--file', source], { encoding: 'utf8' });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Usage: node render-readings\.mjs/);
});
