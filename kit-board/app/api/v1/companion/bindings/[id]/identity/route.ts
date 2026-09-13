import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** Re-confirms a binding's identity after the Observatory approved a re-confirmation. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const install = await usageStore.companionInstall(request);
    const { id } = await context.params;
    return Response.json(await usageStore.confirmIdentity(install, id, await readJson(request, 1024)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
