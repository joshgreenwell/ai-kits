import { kinds, readJson, reportSchema } from '@/lib/contracts';
import { requireProducer } from '@/lib/auth';
import { storeReport } from '@/lib/db';
import { failure, privateHeaders } from '@/lib/http';

export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    const { kind } = await context.params;
    const reportKind = kinds.find(value => value === kind);
    if (!reportKind) return Response.json({ error: 'Unknown report type' }, { status: 404 });
    if (reportKind === 'usage') return Response.json({ error: 'Monthly usage envelopes use /api/reports' }, { status: 400 });
    const producer = requireProducer(request, reportKind);
    const report = reportSchema.parse(await readJson(request));
    const receipt = await storeReport(reportKind, producer, report);
    return Response.json({ ok: true, ...receipt }, { status: receipt.duplicate ? 200 : 201, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
