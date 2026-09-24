import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { addWatchInput, parsePullRequestUrl } from '@/lib/pr-watch-contract';
import { prWatchStore } from '@/lib/pr-watch-store';

export const maxDuration = 15;

export async function GET() {
  try {
    await requireSession();
    return Response.json(await prWatchStore.list(), { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    await requireSession();
    requireSameOrigin(request);
    const { url } = addWatchInput.parse(await readJson(request, 2_048));
    const result = await prWatchStore.add(parsePullRequestUrl(url));
    return Response.json(result, { status: result.duplicate ? 200 : 201, headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
