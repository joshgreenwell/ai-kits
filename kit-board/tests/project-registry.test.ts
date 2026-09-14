import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRegistryMutationSchema } from '../lib/project-registry';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';

test('project registry accepts create, rename, multi-map, and unmap operations', () => {
  assert.deepEqual(projectRegistryMutationSchema.parse({ action: 'create', label: '  Observatory  ' }),
    { action: 'create', label: 'Observatory' });
  assert.deepEqual(projectRegistryMutationSchema.parse({ action: 'rename', project_id: a, label: 'Kit Board' }),
    { action: 'rename', project_id: a, label: 'Kit Board' });
  assert.deepEqual(projectRegistryMutationSchema.parse({ action: 'map', project_id: a, identity_ids: [a, b] }),
    { action: 'map', project_id: a, identity_ids: [a, b] });
  assert.deepEqual(projectRegistryMutationSchema.parse({ action: 'unmap', identity_ids: [b] }),
    { action: 'unmap', identity_ids: [b] });
});

test('project registry rejects blank labels, duplicate identities, and unknown fields', () => {
  assert.throws(() => projectRegistryMutationSchema.parse({ action: 'create', label: '   ' }));
  assert.throws(() => projectRegistryMutationSchema.parse({ action: 'map', project_id: a, identity_ids: [b, b] }));
  assert.throws(() => projectRegistryMutationSchema.parse({ action: 'unmap', identity_ids: [b], path: '/private' }));
});
