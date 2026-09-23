import { requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';

export const maxDuration = 60;

/** Settings > Projects: per app project counts, removed projects, and requests in no project by reason. Read-only. */
export async function GET() {
  try {
    await requireSession();
    return Response.json(await usageStore.listProjectStats(), { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
