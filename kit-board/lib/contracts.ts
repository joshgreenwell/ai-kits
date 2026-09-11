import { z } from 'zod';

export const kinds = ['usage', 'tasks', 'standup', 'readings', 'audit'] as const;
export type ReportKind = typeof kinds[number];
const key = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:@+-]+$/);
export const reportSchema = z.object({
  schema_version: z.literal(1),
  period_key: z.string().regex(/^\d{4}-\d{2}(?:-\d{2})?$/),
  subject_key: key,
  idempotency_key: key,
  title: z.string().trim().min(1).max(200),
  produced_at: z.iso.datetime({ offset: true }),
  status: z.enum(['complete', 'partial', 'failed']),
  coverage: z.record(z.string(), z.unknown()).default({}),
  payload: z.record(z.string(), z.unknown()),
  html: z.string().max(3_500_000).optional(),
}).strict().superRefine((data, ctx) => {
  if (Date.parse(data.produced_at) > Date.now() + 300_000) {
    ctx.addIssue({ code: 'custom', path: ['produced_at'], message: 'Observation time cannot be in the future' });
  }
  const date = data.period_key.length === 7 ? data.period_key + '-01' : data.period_key;
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    ctx.addIssue({ code: 'custom', path: ['period_key'], message: 'Invalid calendar date' });
  }
});
export type ReportInput = z.infer<typeof reportSchema>;
export type StoredReport = ReportInput & {
  id: string; kind: ReportKind; producer_id: string; received_at: string; content_hash: string;
};
export class RequestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function readJson(request: Request, maximum = 4_000_000): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new RequestError('Expected application/json', 415);
  if (Number(request.headers.get('content-length')) > maximum) throw new RequestError('Report is too large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError('A request body is required');
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximum) { await reader.cancel(); throw new RequestError('Report is too large', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError('Invalid JSON'); }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stableJson(v)).join(',') + '}';
  }
  return JSON.stringify(value);
}
