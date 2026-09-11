import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultReport } from '../lib/report-selection';
import type { StoredReport } from '../lib/contracts';

const report = (id: string, status: 'complete' | 'partial' | 'failed', full = false) => ({ id, status, coverage: full ? { presentation: 'full-audit' } : {} }) as StoredReport;

test('a later condensed supplement does not displace a full audit assessment', () => {
  const full = report('full', 'partial', true);
  assert.equal(defaultReport('audit', [report('summary', 'complete'), full]), full);
  const next = report('next', 'partial', true);
  assert.equal(defaultReport('audit', [report('failed', 'failed', true), next, full]), next);
});

test('other report histories keep the newest nonfailed revision and empty histories work', () => {
  const current = report('current', 'complete');
  assert.equal(defaultReport('tasks', [report('failed', 'failed'), current, report('old', 'complete', true)]), current);
  assert.equal(defaultReport('audit', []), undefined);
});
