import { requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import { parseUsageQuery, usageQuery } from '@/lib/usage-query';
export const maxDuration = 60;

/** One filtered usage read for every Tokens card (USG-012): scope, headline, series, breakdowns, coverage, and historical fallback. */
export async function GET(request: Request) {
  try {
    await requireSession(); const started = performance.now();
    const params = parseUsageQuery(new URL(request.url).searchParams);
    const data = await usageQuery(params);
    return Response.json(data, { headers: { ...privateHeaders, 'Server-Timing': `data;dur=${(performance.now() - started).toFixed(1)}` } });
  } catch (error) { return failure(error); }
}
