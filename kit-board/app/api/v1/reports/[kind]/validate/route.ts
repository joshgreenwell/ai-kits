import { kinds, readJson } from '@/lib/contracts';
import { requireProducer, requireSameOrigin, requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import { validateReport } from '@/lib/report-contracts';

/**
 * Checks a report the way POST /api/v1/reports/:kind would, and stores nothing. A producer sends its
 * key, as for a real post; the /kits page sends the signed-in session. Either way it authenticates
 * before reading the body.
 */
export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  try {
    const { kind } = await context.params;
    const reportKind = kinds.find(value => value === kind);
    if (!reportKind) return Response.json({ error: 'Unknown report type' }, { status: 404, headers: privateHeaders });
    if (reportKind === 'usage') return Response.json({ error: 'Monthly usage envelopes use /api/reports' }, { status: 400, headers: privateHeaders });
    if (request.headers.has('authorization')) requireProducer(request, reportKind);
    else { await requireSession(); requireSameOrigin(request); }
    return Response.json(validateReport(reportKind, await readJson(request)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
