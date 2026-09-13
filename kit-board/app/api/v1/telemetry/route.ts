import { readJson } from '@/lib/contracts';
import { telemetrySchema } from '@/lib/telemetry-contract';
import { ingestBrowserQuotas, telemetrySource } from '@/lib/telemetry-store';
import { failure, privateHeaders } from '@/lib/http';

// The local collector scripts are retired in favour of the companion. The browser quota
// extension keeps publishing allowance readings here until the v2 browser collector exists.
export async function POST(request: Request) {
  try {
    const source = await telemetrySource(request);
    if (source.mode !== 'browser') {
      return Response.json({ error: 'Legacy telemetry ingestion is retired. Install the companion.' }, { status: 410, headers: privateHeaders });
    }
    const input = telemetrySchema.parse(await readJson(request, 750_000));
    return Response.json(await ingestBrowserQuotas(source, input), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
