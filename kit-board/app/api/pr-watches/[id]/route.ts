import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { watchActionInput } from '@/lib/pr-watch-contract';
import { prWatchStore } from '@/lib/pr-watch-store';

export const maxDuration = 15;

/** Stop a watch, or ask the runner to review it on its next tick. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
    requireSameOrigin(request);
    const { action } = watchActionInput.parse(await readJson(request, 1_024));
    return Response.json({ watch: await prWatchStore.act((await params).id, action) }, { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
