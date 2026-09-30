import { z } from 'zod';
import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { addWatchInput, parsePullRequestUrl, prWatchKinds } from '@/lib/pr-watch-contract';
import { prWatchStore } from '@/lib/pr-watch-store';

export const maxDuration = 15;

/** One kind's queue: ?kind=review (the default) or ?kind=address. */
export async function GET(request: Request) {
  try {
    await requireSession();
    const kind = z.enum(prWatchKinds).default('review').parse(new URL(request.url).searchParams.get('kind') ?? undefined);
    return Response.json(await prWatchStore.list(kind), { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireSession();
    requireSameOrigin(request);
    const { url, kind } = addWatchInput.parse(await readJson(request, 2_048));
    const result = await prWatchStore.add(parsePullRequestUrl(url), kind);
    return Response.json(result, { status: result.duplicate ? 200 : 201, headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
