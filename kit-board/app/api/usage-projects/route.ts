import { requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';

export const maxDuration = 15;

/**
 * The projects the Tokens filter offers: `{ projects: [{ id, label }] }`, one per project with at least
 * one active app project. Projects come from the apps the companion reads; there is nothing to create,
 * rename or map, so PUT is gone (405). Settings > Projects reads `/api/usage-projects/stats`.
 */
export async function GET() {
  try {
    await requireSession();
    return Response.json(await usageStore.listProjects(), { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT() {
  return Response.json({ error: 'Projects come from your apps and cannot be edited here.' },
    { status: 405, headers: { ...privateHeaders, Allow: 'GET' } });
}
