import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredReport } from '@/lib/contracts';
import { parseReadings } from '@/lib/readings';
import { InlineMarkdown } from '@/components/kit';
import { ReadingsView } from '@/components/readings-view';

// Synthetic markdown in the shape the scheduled task publishes today; no real report text.
const CURRENT = [
  '# Daily Tech / AI / Crypto Snapshot — 2026-09-23',
  'Email checked: Yes',
  'Web checked: Yes',
  'Coverage window: 2026-09-22 07:00 to 2026-09-23 07:00 CT',
  'Overall read: A quiet day with one **notable** release.',
  '',
  '## Worth Looking At (1/2)',
  '**[AI/Security] A synthetic release — Example Lab**',
  'Link: [Release notes](https://example.com/notes) / [Paper](https://example.org/paper)',
  'Evidence: Strong evidence (official, confirmed)',
  'Summary: The lab shipped a synthetic thing.',
  '- **What changed:** A new flag.',
  '  - A nested detail.',
  '- **Why it matters:** Less toil.',
  '- An unlabeled point.',
  '',
  '## Executive Snapshot',
  '- First snapshot point with [a link](https://example.com/one).',
  '- Second snapshot point.',
  '',
  '## Worth Looking At (2/2)',
  '**[Research] A second item — arXiv 2609.00001**',
  'Link: https://example.net/abs',
  'Evidence: Medium',
  'Summary: A preprint.',
  '',
  '## Crypto/Security Lane',
  '**[Security] A lane item — Example Blog**',
  'Link: [Post](https://example.com/post)',
  'Evidence: Speculative',
  'Summary: A lane summary.',
  '- A lane point.',
  '',
  '## Watchlist',
  '- **A watched claim** with context ([Source](https://example.com/w)). On watch: wait for confirmation.',
  '',
  '## Skipped As Noise Or Marketing',
  '- A skipped item, mostly marketing.',
  '',
  '## Actions',
  '- **Try the flag:** on a test repo.',
].join('\n');

const report = (markdown: string, html?: string): StoredReport => ({
  schema_version: 1, period_key: '2026-09-23', subject_key: 'readings', idempotency_key: 'synthetic', title: 'Synthetic readings',
  produced_at: '2026-09-23T12:00:00Z', status: 'complete', coverage: {}, payload: { markdown }, html,
  id: 'r1', kind: 'readings', producer_id: 'p1', received_at: '2026-09-23T12:00:01Z', content_hash: 'h1',
});

test('parses the current format into meta, snapshot, items, lanes and bullet sections', () => {
  const readings = parseReadings(CURRENT);
  assert.equal(readings.title, 'Daily Tech / AI / Crypto Snapshot — 2026-09-23');
  assert.deepEqual(readings.meta, [
    { label: 'Email checked', value: 'Yes' },
    { label: 'Web checked', value: 'Yes' },
    { label: 'Coverage window', value: '2026-09-22 07:00 to 2026-09-23 07:00 CT' },
  ]);
  assert.equal(readings.overall, 'A quiet day with one **notable** release.');
  assert.deepEqual(readings.snapshot, ['First snapshot point with [a link](https://example.com/one).', 'Second snapshot point.']);
  assert.equal(readings.recognized, true);
  // "(1/2)" and "(2/2)" merge into one section in first-seen order.
  assert.deepEqual(readings.sections.map(section => [section.id, section.kind]), [
    ['worth-looking-at', 'worth'], ['executive-snapshot', 'snapshot'], ['crypto-security-lane', 'lane'],
    ['watchlist', 'watchlist'], ['skipped-as-noise-or-marketing', 'skipped'], ['actions', 'actions'],
  ]);

  const [worth, , lane, watchlist, skipped, actions] = readings.sections;
  assert.equal(worth.items.length, 2);
  const [first, second] = worth.items;
  assert.equal(first.tag, 'AI/Security');
  assert.equal(first.title, 'A synthetic release');
  assert.equal(first.source, 'Example Lab');
  assert.equal(first.link, 'https://example.com/notes');
  assert.deepEqual(first.links, [{ label: 'Release notes', href: 'https://example.com/notes' }, { label: 'Paper', href: 'https://example.org/paper' }]);
  assert.equal(first.evidence, 'strong');
  assert.equal(first.evidenceLabel, 'Strong evidence (official, confirmed)');
  assert.equal(first.summary, 'The lab shipped a synthetic thing.');
  assert.deepEqual(first.points, [
    { label: 'What changed', text: 'A new flag.', children: ['A nested detail.'] },
    { label: 'Why it matters', text: 'Less toil.', children: [] },
    { label: null, text: 'An unlabeled point.', children: [] },
  ]);
  assert.deepEqual(first.notes, []);
  assert.equal(second.source, 'arXiv 2609.00001');
  assert.equal(second.link, 'https://example.net/abs');
  assert.equal(second.evidence, 'medium');

  assert.equal(lane.items[0].evidence, 'weak');
  assert.equal(lane.items[0].points[0].text, 'A lane point.');
  assert.deepEqual(watchlist.bullets, [{ lead: 'A watched claim', text: 'with context ([Source](https://example.com/w)).', note: 'wait for confirmation.', children: [] }]);
  assert.equal(skipped.bullets.length, 1);
  assert.deepEqual(actions.bullets, [{ lead: 'Try the flag', text: 'on a test repo.', note: null, children: [] }]);
});

test('parses the older formats: bare headings, • bullets, Slack links and _wrapped_ headings', () => {
  const readings = parseReadings([
    'Daily readings — 2026-09-07',
    '',
    'Executive Snapshot',
    '• *Important* thing with <https://example.com/path|safe link>',
    '• Another point',
    '',
    'Worth Looking At',
    '*[AI] Legacy item — Legacy Source*',
    'Link: <https://example.com/legacy|Legacy notes>',
    'Summary: Old style.',
    '',
    '_Research Papers_',
    '*[cs.SE] A paper — arXiv*',
    'Summary: A legacy paper.',
    '',
    'Watchlist',
    '• _A lead_ — continuing text',
  ].join('\n'));
  assert.equal(readings.title, 'Daily readings — 2026-09-07');
  assert.equal(readings.recognized, true);
  assert.deepEqual(readings.sections.map(section => section.kind), ['snapshot', 'worth', 'other', 'watchlist']);
  assert.deepEqual(readings.snapshot, ['*Important* thing with <https://example.com/path|safe link>', 'Another point']);
  const [, worth, papers, watchlist] = readings.sections;
  assert.equal(worth.items[0].title, 'Legacy item');
  assert.equal(worth.items[0].source, 'Legacy Source');
  assert.deepEqual(worth.items[0].links, [{ label: 'Legacy notes', href: 'https://example.com/legacy' }]);
  assert.equal(papers.title, 'Research Papers');
  assert.equal(papers.items[0].tag, 'cs.SE');
  assert.deepEqual(watchlist.bullets[0], { lead: 'A lead', text: 'continuing text', note: null, children: [] });

  // The Slack link in the snapshot becomes a real anchor in the view.
  const html = renderToStaticMarkup(<InlineMarkdown text={readings.snapshot[0]} />);
  assert.match(html, /<em>Important<\/em>/);
  assert.match(html, /<a href="https:\/\/example\.com\/path" rel="noreferrer noopener" target="_blank"[^>]*>safe link<\/a>/);
});

test('only https URLs become links; http: and javascript: stay visible as text', () => {
  const html = renderToStaticMarkup(
    <InlineMarkdown text="A [bad](javascript:alert(1)), <http://unsafe.example|plain>, [old](http://old.example) and [ok](https://example.com/ok)." />,
  );
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]), ['https://example.com/ok']);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(html, /&lt;http:\/\/unsafe\.example\|plain&gt;/);
  assert.match(html, /\[old\]\(http:\/\/old\.example\)/);

  const unsafe = [
    '# Readings', '', '## Worth Looking At', '**[AI] Unsafe links — Somewhere**',
    'Link: [bad](javascript:alert(1)) / http://plain.example', 'Summary: Nothing to open.',
  ].join('\n');
  const readings = parseReadings(unsafe);
  const [item] = readings.sections[0].items;
  assert.deepEqual(item.links, []);
  assert.equal(item.link, null);
  assert.deepEqual(item.notes, ['[bad](javascript:alert(1)) / http://plain.example']);
  const view = renderToStaticMarkup(<ReadingsView title="Readings" empty="" history={[]} report={report(unsafe)} />);
  assert.doesNotMatch(view, /href="(?:javascript|http):/);
  assert.doesNotMatch(view, /Open source/);
});

test('the view leads with the snapshot and actions, then the remaining sections in order', () => {
  const html = renderToStaticMarkup(<ReadingsView title="Readings" empty="" history={[]} report={report(CURRENT, 'available')} />);
  const at = (id: string) => {
    const index = html.indexOf(`<section id="${id}"`);
    assert.ok(index >= 0, `section ${id} is rendered`);
    return index;
  };
  const order = ['executive-snapshot', 'actions', 'worth-looking-at', 'crypto-security-lane', 'watchlist', 'skipped-as-noise-or-marketing'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // Standard headings read in the site's sentence case, and the page carries its section nav and meta.
  assert.match(html, /id="worth-looking-at-heading"[^>]*>Worth looking at</);
  assert.match(html, /aria-label="Readings sections"/);
  assert.match(html, /href="#executive-snapshot"/);
  assert.match(html, /Coverage/);
  assert.match(html, /Copy markdown/);
  assert.match(html, /A quiet day with one <strong[^>]*>notable<\/strong> release\./);
  // The authored HTML is offered behind a closed disclosure and never inlined into the page.
  assert.match(html, /Original report layout/);
  assert.doesNotMatch(html, /<iframe/);
});

test('unrecognized markdown falls back to the Prose report body', () => {
  const markdown = 'Just some notes.\n\nAnother paragraph with **bold** text.';
  assert.equal(parseReadings(markdown).recognized, false);
  const html = renderToStaticMarkup(<ReadingsView title="Readings" empty="" history={[]} report={report(markdown)} />);
  assert.match(html, /Copy update/);
  assert.match(html, /Another paragraph with <strong[^>]*>bold<\/strong> text\./);
  assert.doesNotMatch(html, /Readings sections/);
  assert.doesNotMatch(html, /Copy markdown/);
});

test('with no report the view shows the empty state', () => {
  const html = renderToStaticMarkup(<ReadingsView title="Readings" empty="Nothing has been published." history={[]} />);
  assert.match(html, /No published reports yet/);
  assert.match(html, /Nothing has been published\./);
});
