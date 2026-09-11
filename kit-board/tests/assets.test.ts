import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetDescriptor, assetKeyForHref, assetPathFromHref, rewriteAssetLinks } from '../lib/assets';

const reportId = '11111111-1111-1111-1111-111111111111';

test('asset paths retain relative audit evidence while rejecting remote and unsafe targets', () => {
  assert.equal(assetPathFromHref('inputs/report-merge-reconciliation.json'), 'inputs/report-merge-reconciliation.json');
  assert.equal(assetPathFromHref('../previous/report.html'), '../previous/report.html');
  assert.equal(assetPathFromHref('https://example.com/evidence.json'), undefined);
  assert.equal(assetPathFromHref('#merged-score'), undefined);
  assert.equal(assetPathFromHref('/private/evidence.json'), undefined);
  assert.equal(assetPathFromHref('evidence.json?download=1'), undefined);
});

test('asset descriptors use a stable path key and a safe downloadable filename', () => {
  const descriptor = assetDescriptor('inputs/report-merge-reconciliation.json');
  assert.equal(descriptor.assetKey, assetKeyForHref('inputs/report-merge-reconciliation.json'));
  assert.equal(descriptor.filename, 'report-merge-reconciliation.json');
  assert.equal(descriptor.mediaType, 'application/json');
  assert.throws(() => assetDescriptor('inputs/unsafe name.json'), /Invalid asset filename/);
  assert.throws(() => assetDescriptor('inputs/evidence.pdf'), /Unsupported asset path/);
});

test('only supported relative file links are rewritten to authenticated download routes', () => {
  const html = '<a href="inputs/evidence.json">Evidence</a><a href="#scores">Scores</a><a href="https://example.com">External</a>';
  const rewritten = rewriteAssetLinks(html, reportId);
  assert.match(rewritten, new RegExp(`/api/artifacts/${reportId}/files/${assetKeyForHref('inputs/evidence.json')}`));
  assert.match(rewritten, /href="#scores"/);
  assert.match(rewritten, /href="https:\/\/example.com"/);
  assert.match(rewritten, /target="_blank" rel="noopener noreferrer">Evidence/);
});
