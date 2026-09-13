import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** Creates a binding for this install (idempotent on install and account). 201 on create, 200 when it existed. */
export async function POST(request: Request) {
  try {
    const install = await usageStore.companionInstall(request);
    const { created, binding } = await usageStore.createBinding(install, await readJson(request, 4096));
    return Response.json(binding, { status: created ? 201 : 200, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
