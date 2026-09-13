import { safeEqual } from '@/lib/crypto';
import { RequestError } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 30;
/** Daily cron: records the newest `observatory-v*` release so Connections can show "update available". */
export async function GET(request: Request) {
  try {
    if (!process.env.CRON_SECRET || !safeEqual(request.headers.get('authorization') ?? '', `Bearer ${process.env.CRON_SECRET}`)) throw new RequestError('Unauthorized', 401);
    const result = await usageStore.syncCompanionRelease();
    return Response.json(result, { status: 'ok' in result && !result.ok ? 503 : 200, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
