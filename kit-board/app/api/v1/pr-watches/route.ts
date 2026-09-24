import { requireProducer } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import { runnerHeartbeat } from '@/lib/pr-watch-contract';
import { prWatchStore } from '@/lib/pr-watch-store';

export const maxDuration = 15;

/**
 * The local runner's tick (scripts/pr-watch.mjs). Asking for work is the heartbeat, so the page can
 * tell a quiet queue from a runner that is not running.
 */
export async function GET(request: Request) {
  try {
    const producer = requireProducer(request, 'pr-watch');
    const params = new URL(request.url).searchParams;
    const heartbeat = runnerHeartbeat.parse({
      ...(params.get('machine') ? { machine_label: params.get('machine') } : {}),
      ...(params.get('version') ? { version: params.get('version') } : {}),
    });
    return Response.json({ watches: await prWatchStore.runnerWork(producer, heartbeat) }, { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
