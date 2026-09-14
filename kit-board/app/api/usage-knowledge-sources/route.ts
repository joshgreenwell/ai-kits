import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';

export const maxDuration = 15;

export async function GET() {
  try {
    await requireSession();
    return Response.json(await usageStore.listKnowledgeSources(), { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: Request) {
  try {
    await requireSession();
    requireSameOrigin(request);
    return Response.json(await usageStore.updateKnowledgeSources(await readJson(request, 16_384)), { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
