import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** Stores what this companion build can do (`companionCapabilitiesSchema`); never touches the settings version. */
export async function POST(request: Request) {
  try {
    const install = await usageStore.companionInstall(request);
    return Response.json(await usageStore.reportCapabilities(install, await readJson(request, 32_768)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
