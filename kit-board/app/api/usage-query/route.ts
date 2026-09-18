import { requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import { parseUsageQuery, usageQuery } from '@/lib/usage-query';
export const maxDuration = 60;

/** Filtered usage read for Tokens. `section=overview|requests|tools` skips tables other cards own; omit it for the full document. */
export async function GET(request: Request) {
  try {
    await requireSession(); const started = performance.now();
    const params = parseUsageQuery(new URL(request.url).searchParams);
    const data = await usageQuery(params);
    return Response.json(data, { headers: { ...privateHeaders, 'Server-Timing': `data;dur=${(performance.now() - started).toFixed(1)}` } });
  } catch (error) { return failure(error); }
}
