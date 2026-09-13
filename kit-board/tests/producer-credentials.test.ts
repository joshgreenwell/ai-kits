import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../lib/crypto';
import { producerForToken } from '../lib/producer-credentials';

const credential = (token: string, kinds: string[]) => ({ hash: digest(token), kinds });

test('primary producer credentials retain report-kind scoping', () => {
  const primary = JSON.stringify({
    monthly: credential('usage-key', ['usage']),
    tasks: credential('tasks-key', ['tasks']),
  });

  assert.equal(producerForToken('usage-key', 'usage', primary), 'monthly');
  assert.equal(producerForToken('tasks-key', 'tasks', primary), 'tasks');
  assert.equal(producerForToken('tasks-key', 'usage', primary), undefined);
});

test('additive credentials authorize usage reports only', () => {
  const supplemental = JSON.stringify({ recovery: credential('recovery-key', ['usage', 'tasks']) });

  assert.equal(producerForToken('recovery-key', 'usage', '{}', supplemental), 'recovery');
  assert.equal(producerForToken('recovery-key', 'tasks', '{}', supplemental), undefined);
});

test('key rotation can retain the producer identity while both usage keys work', () => {
  const primary = JSON.stringify({ monthly: credential('old-key', ['usage']) });
  const supplemental = JSON.stringify({ monthly: credential('new-key', ['usage']) });

  assert.equal(producerForToken('old-key', 'usage', primary, supplemental), 'monthly');
  assert.equal(producerForToken('new-key', 'usage', primary, supplemental), 'monthly');
});

test('invalid credential entries are ignored without weakening valid entries', () => {
  const primary = JSON.stringify({
    missingHash: { kinds: ['usage'] },
    wrongKinds: { hash: digest('wrong'), kinds: 'usage' },
    valid: credential('valid-key', ['usage']),
  });

  assert.equal(producerForToken('valid-key', 'usage', primary), 'valid');
  assert.equal(producerForToken('wrong', 'usage', primary), undefined);
});
