import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson, RequestError } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** Issues a one-time pairing code; the code is returned once and stored hashed. */
export async function POST(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    return Response.json(await usageStore.issuePairingCode(await readJson(request, 2048)), { status: 201, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
/** Pause, resume, disable, per-install override, binding enable or disable, identity approval. */
export async function PATCH(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    return Response.json(await usageStore.updateInstall(await readJson(request, 16_384)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
/** Disables an install: its key stops authenticating and its bindings leave the dashboards. */
export async function DELETE(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    const { id } = await readJson(request, 1024) as { id?: unknown };
    if (typeof id !== 'string') throw new RequestError('Invalid install');
    return Response.json(await usageStore.updateInstall({ id, action: 'disable' }), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
