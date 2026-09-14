import test from 'node:test';
import assert from 'node:assert/strict';
import { meterLabel } from '../lib/allowance-meters';

test('Claude meters carry one title whichever reader supplied the label', () => {
  assert.equal(meterLabel('five_hour', '5-hour allowance'), 'Claude · 5h');
  assert.equal(meterLabel('five_hour', 'Claude · 5h'), 'Claude · 5h');
  assert.equal(meterLabel('seven_day', 'Weekly · all models'), 'Claude · weekly');
  assert.equal(meterLabel('seven_day_sonnet', 'Weekly · Sonnet'), 'Claude · weekly · Sonnet');
  assert.equal(meterLabel('seven_day_claude_opus', 'Claude · weekly · Claude Opus'), 'Claude · weekly · Claude Opus');
});

test('unknown keys keep the producer label, including Codex, Spark, and extra usage', () => {
  assert.equal(meterLabel('codex:300', 'Codex · 5h'), 'Codex · 5h');
  assert.equal(meterLabel('codex_spark:10080', 'Codex Spark · weekly'), 'Codex Spark · weekly');
  assert.equal(meterLabel('extra_usage', 'Extra usage'), 'Extra usage');
  assert.equal(meterLabel('seven_day_', 'Weekly · ?'), 'Weekly · ?', 'an empty scope is not a model-scoped meter');
});
