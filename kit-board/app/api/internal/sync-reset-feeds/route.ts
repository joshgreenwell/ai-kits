import { safeEqual } from '@/lib/crypto';
import { syncResetFeeds } from '@/lib/reset-feed-store';
import { failure, privateHeaders } from '@/lib/http';
import { RequestError } from '@/lib/contracts';
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    if (!process.env.CRON_SECRET || !safeEqual(request.headers.get('authorization') ?? '', `Bearer ${process.env.CRON_SECRET}`)) throw new RequestError('Unauthorized', 401);
    const results = await syncResetFeeds();
    return Response.json({ results }, { status: results.some(r => 'ok' in r && !r.ok) ? 503 : 200, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
