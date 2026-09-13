import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** Replaces this install's settings override (`installOverrideSchema`). */
export async function PUT(request: Request) {
  try {
    const install = await usageStore.companionInstall(request);
    return Response.json(await usageStore.updateInstallSettings(install, await readJson(request, 16_384)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
