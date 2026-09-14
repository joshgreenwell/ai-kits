import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledgeSourceMutationSchema } from '../lib/knowledge-source-registry';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';

test('knowledge source registry accepts create, rename, multi-map, and unmap operations', () => {
  assert.deepEqual(knowledgeSourceMutationSchema.parse({ action: 'create', label: '  Primary vault  ' }),
    { action: 'create', label: 'Primary vault' });
  assert.deepEqual(knowledgeSourceMutationSchema.parse({ action: 'rename', source_id: a, label: 'Reference vault' }),
    { action: 'rename', source_id: a, label: 'Reference vault' });
  assert.deepEqual(knowledgeSourceMutationSchema.parse({ action: 'map', source_id: a, identity_ids: [a, b] }),
    { action: 'map', source_id: a, identity_ids: [a, b] });
  assert.deepEqual(knowledgeSourceMutationSchema.parse({ action: 'unmap', identity_ids: [b] }),
    { action: 'unmap', identity_ids: [b] });
});

test('knowledge source registry rejects blank labels, duplicate identities, and unknown fields', () => {
  assert.throws(() => knowledgeSourceMutationSchema.parse({ action: 'create', label: '   ' }));
  assert.throws(() => knowledgeSourceMutationSchema.parse({ action: 'create', label: 'x'.repeat(81) }));
  assert.throws(() => knowledgeSourceMutationSchema.parse({ action: 'map', source_id: a, identity_ids: [b, b] }));
  assert.throws(() => knowledgeSourceMutationSchema.parse({ action: 'map', source_id: a, identity_ids: [] }));
  assert.throws(() => knowledgeSourceMutationSchema.parse({ action: 'unmap', identity_ids: [b], path: '/private' }));
  assert.throws(() => knowledgeSourceMutationSchema.parse({ action: 'create', label: 'Vault', roots: ['/private/vault'] }),
    'a mutation can never name a root');
  assert.throws(() => knowledgeSourceMutationSchema.parse({ action: 'map', source_id: a, identity_ids: [b], connectors: ['mcp:vault'] }),
    'a mutation can never name a connector');
});
