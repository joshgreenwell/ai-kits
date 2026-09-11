import { readJson } from '@/lib/contracts';
import { telemetrySchema } from '@/lib/telemetry-contract';
import { ingestTelemetry, telemetrySource } from '@/lib/telemetry-store';
import { failure, privateHeaders } from '@/lib/http';
export async function POST(request: Request) {
  try {
    const source = await telemetrySource(request);
    const input = telemetrySchema.parse(await readJson(request, 750_000));
    return Response.json(await ingestTelemetry(source, input), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
