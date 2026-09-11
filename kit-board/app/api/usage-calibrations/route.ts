import { z } from 'zod';
import { requireSession, requireSameOrigin } from '@/lib/auth';
import { readJson } from '@/lib/contracts';
import { saveCalibration, revokeCalibration } from '@/lib/cloud-estimate-store';
import { failure, privateHeaders } from '@/lib/http';
export const maxDuration = 15;

export async function POST(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    return Response.json(await saveCalibration(await readJson(request, 2048)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
export async function DELETE(request: Request) {
  try {
    await requireSession(); requireSameOrigin(request);
    const { id } = z.object({ id: z.uuid() }).strict().parse(await readJson(request, 1024));
    await revokeCalibration(id);
    return Response.json({ ok: true }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
