import assert from 'node:assert/strict';
import test from 'node:test';
import { UNKNOWN_MODEL_COLOR, modelLineStyles } from '../lib/model-colors';

test('every model in use has its own line color, whatever else is in scope', () => {
  const models = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8',
    'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'codex-auto-review', 'gpt-5.3-codex-spark',
    'cursor-grok-4.6-xhigh-fast', 'cursor-grok-4.6-high-fast', 'cursor-grok-4.5-high-fast', 'unknown'];
  const styles = modelLineStyles(models);
  const solid = models.map(model => styles.get(model)!);
  assert.ok(solid.every(style => !style.dash), 'lab models under their own names are solid');
  assert.equal(new Set(solid.map(style => style.color)).size, models.length, 'no two models share a color');
  assert.equal(styles.get('gpt-6-astra')!.color, '#3A83F7');
  assert.equal(styles.get('claude-opus-5-5')!.color, '#EB6834');
  assert.equal(styles.get('claude-haiku-4-5-20251001')!.color, '#FBE8DB', 'a dated snapshot id takes its model color');
  assert.equal(styles.get('unknown')!.color, UNKNOWN_MODEL_COLOR);
  assert.deepEqual(modelLineStyles(['gpt-6-sol']).get('gpt-6-sol'), styles.get('gpt-6-sol'), 'a color does not depend on the other models in scope');
});

test('a lab model served through Cursor keeps its lab color, dashed per effort', () => {
  const styles = modelLineStyles(['gpt-5.6-sol', 'gpt-5.6-sol-xhigh-fast', 'gpt-5.6-sol-medium', 'claude-4.5-sonnet']);
  const sol = styles.get('gpt-5.6-sol')!, xhigh = styles.get('gpt-5.6-sol-xhigh-fast')!, medium = styles.get('gpt-5.6-sol-medium')!;
  assert.equal(xhigh.color, sol.color); assert.equal(medium.color, sol.color);
  assert.ok(xhigh.dash && medium.dash && xhigh.dash !== medium.dash, 'two efforts of one model stay apart');
  assert.equal(sol.dash, undefined);
  assert.deepEqual(styles.get('claude-4.5-sonnet'), { color: '#D97757', dash: '6 4' });
});

test('models no rule names get distinct fallback colors in a stable order', () => {
  const styles = modelLineStyles(['zeta-model', 'default', 'alpha-model']);
  assert.equal(new Set([...styles.values()].map(style => style.color)).size, 3);
  assert.deepEqual(modelLineStyles(['alpha-model', 'default', 'zeta-model']), styles, 'input order does not matter');
});
