import { readJson, RequestError } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';
import { parseRoutingEventBatch } from '@/lib/routing-event-contract';
import { routingStore } from '@/lib/routing-store';
import { telemetrySource } from '@/lib/telemetry-store';

export async function POST(request: Request) {
  try {
    const source = await telemetrySource(request);
    const input = parseRoutingEventBatch(await readJson(request, 256_000));
    return Response.json(await routingStore.append(source, input), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}

export async function GET(request: Request) {
  try {
    const source = await telemetrySource(request);
    const taskId = new URL(request.url).searchParams.get('task_id');
    if (!taskId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) throw new RequestError('A valid task_id is required');
    const events = await routingStore.eventsForTask(source, taskId);
    return Response.json({ schema_version: 1, account_id: source.account_id, provider: source.provider, task_id: taskId, events }, { headers: privateHeaders });
  } catch (error) { return failure(error); }
}
