import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { listReportSubjects, updateReportSubject } from '@/lib/usage-query';
export const maxDuration = 15;

/** Monthly report subjects and the account each reports on; the crosswalk the query layer's historical fallback needs. */
export async function GET() {
  try {
    await requireSession();
    return Response.json(await listReportSubjects(), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    return Response.json(await updateReportSubject(await readJson(request, 4_096)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
