import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson, RequestError } from '@/lib/contracts';
import { database } from '@/lib/db';
import { failure, privateHeaders } from '@/lib/http';
import { telemetryStore } from '@/lib/telemetry-store';

// Browser connections are the last v1 collectors still in service (the quota extension
// has no v2 replacement yet). Local-script connections stay retired. Each source reports
// its last contact separately from the newest reading it observed and delivered.
export async function GET() {
  try {
    await requireSession();
    return Response.json(await telemetryStore.browserConnections(), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    return Response.json({ error: 'Legacy collectors are retired. Pair a companion instead.' }, { status: 410, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    const { id, disabled } = await readJson(request, 1024) as { id: string; disabled: boolean };
    if (!/^[a-f0-9-]{36}$/.test(id) || typeof disabled !== 'boolean') throw new RequestError('Invalid connection');
    const rows = await database()`UPDATE personal_hub.telemetry_sources SET disabled = ${disabled} WHERE id = ${id} AND mode = 'browser' RETURNING id`;
    if (!rows.length) throw new RequestError('Only browser connections can be resumed', 404);
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    const { id } = await readJson(request, 1024) as { id: string };
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new RequestError('Invalid connection');
    await database()`UPDATE personal_hub.telemetry_sources SET disabled = true WHERE id = ${id}`;
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
