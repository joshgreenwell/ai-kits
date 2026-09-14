import { z } from 'zod';

const label = z.string().trim().min(1).max(80);
const identityIds = z.array(z.uuid()).min(1).max(100).superRefine((ids, ctx) => {
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'Identity ids must be unique' });
  }
});

/** Labels and mappings only: a mutation can never carry a root, a connector, or a path. */
export const knowledgeSourceMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), label }).strict(),
  z.object({ action: z.literal('rename'), source_id: z.uuid(), label }).strict(),
  z.object({ action: z.literal('map'), source_id: z.uuid(), identity_ids: identityIds }).strict(),
  z.object({ action: z.literal('unmap'), identity_ids: identityIds }).strict(),
]);

export type KnowledgeSourceMutation = z.infer<typeof knowledgeSourceMutationSchema>;
