import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageEnvelopeSchema } from '@/lib/usage-contract';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 30;
/** Envelope v2. The body limit is measured while streaming; validation is per record. */
export async function POST(request: Request) {
  try {
    const install = await usageStore.companionInstall(request);
    const envelope = usageEnvelopeSchema.parse(await readJson(request, 2_000_000));
    return Response.json(await usageStore.ingestUsage(install, envelope), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
