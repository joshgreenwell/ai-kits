import { safeEqual } from '@/lib/crypto';
import { RequestError } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { syncLegacyUsage } from '@/lib/legacy-usage';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function bearer(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || !safeEqual(bearer(request), secret)) throw new RequestError('Unauthorized', 401);
    const result = await syncLegacyUsage();
    return Response.json({ ok: true, fetched: result.fetched, inserted: result.inserted, skipped: result.skipped, duplicate: result.duplicate }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
