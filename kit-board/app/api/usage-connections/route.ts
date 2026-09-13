import { requireSameOrigin, requireSession } from '@/lib/auth';
import { readJson, RequestError } from '@/lib/contracts';
import { database } from '@/lib/db';
import { failure, privateHeaders } from '@/lib/http';
export async function POST(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    return Response.json({ error: 'Legacy collectors are retired. Pair a companion instead.' }, { status: 410, headers: privateHeaders });
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
