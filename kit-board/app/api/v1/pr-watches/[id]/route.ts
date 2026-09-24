import { requireProducer } from '@/lib/auth';
import { readJson } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { runnerReport } from '@/lib/pr-watch-contract';
import { prWatchStore } from '@/lib/pr-watch-store';

export const maxDuration = 15;

/** What the runner saw on one watch this tick, and what it did about it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireProducer(request, 'pr-watch');
    const report = runnerReport.parse(await readJson(request, 8_192));
    return Response.json({ ok: true, watch: await prWatchStore.report((await params).id, report) }, { headers: privateHeaders });
  } catch (error) {
    return failure(error);
  }
}
