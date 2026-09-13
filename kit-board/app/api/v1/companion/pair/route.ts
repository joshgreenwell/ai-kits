import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** Exchanges a one-time pairing code for an install id and key. No session; rate-limited through login_limits. */
export async function POST(request: Request) {
  try {
    const address = process.env.VERCEL ? (request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown') : 'local';
    return Response.json(await usageStore.pairInstall(await readJson(request, 2048), address), { status: 201, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
