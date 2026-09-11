import { requireSameOrigin, requireSession } from '@/lib/auth';
import { telemetrySource } from '@/lib/telemetry-store';
import { resetFeedDashboard, syncResetFeeds } from '@/lib/reset-feed-store';
import { failure, privateHeaders } from '@/lib/http';
import { RequestError } from '@/lib/contracts';
export const maxDuration = 60;
export async function GET() {
  try { await requireSession(); return Response.json({ feeds: await resetFeedDashboard() }, { headers: privateHeaders }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.has('authorization')) {
      const source = await telemetrySource(request);
      if (source.mode !== 'local') throw new RequestError('Unauthorized', 403);
    } else { await requireSession(); requireSameOrigin(request); }
    return Response.json({ results: await syncResetFeeds(), feeds: await resetFeedDashboard() }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
