import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { parseUsageEnvelope } from '@/lib/usage-contract';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 30;
/** Envelope v2. The body limit is measured while streaming; validation is per record. */
export async function POST(request: Request) {
  try {
    const install = await usageStore.companionInstall(request);
    const { envelope, invalid } = parseUsageEnvelope(await readJson(request, 2_000_000));
    return Response.json(await usageStore.ingestUsage(install, envelope, invalid), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
