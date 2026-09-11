import { failure, privateHeaders } from '@/lib/http';
import { routingStore } from '@/lib/routing-store';
import { telemetrySource } from '@/lib/telemetry-store';

export async function GET(request: Request) {
  try {
    const source = await telemetrySource(request);
    return Response.json(await routingStore.quotaState(source), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
