import { kinds, readJson, reportSchema } from '@/lib/contracts';
import { requireProducer } from '@/lib/auth';
import { storeReport } from '@/lib/db';
import { failure, privateHeaders } from '@/lib/http';
import { checkReportContract } from '@/lib/report-contracts';

export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    const { kind } = await context.params;
    const reportKind = kinds.find(value => value === kind);
    if (!reportKind) return Response.json({ error: 'Unknown report type' }, { status: 404 });
    if (reportKind === 'usage') return Response.json({ error: 'Monthly usage envelopes use /api/reports' }, { status: 400 });
    const producer = requireProducer(request, reportKind);
    const report = reportSchema.parse(await readJson(request));
    // Observe mode stores an envelope-valid report whatever its payload; enforce mode refuses a mismatch.
    const contract = checkReportContract(reportKind, report);
    if (!contract.valid && contract.enforcement === 'enforce') return Response.json({ error: `The payload does not match ${contract.id}`, contract }, { status: 422, headers: privateHeaders });
    const receipt = await storeReport(reportKind, producer, report);
    return Response.json({ ok: true, ...receipt, contract }, { status: receipt.duplicate ? 200 : 201, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
