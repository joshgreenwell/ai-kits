import { privateHeaders } from '@/lib/http';
export async function POST() {
  return Response.json({ error: 'Legacy telemetry ingestion is retired. Install the companion.' }, { status: 410, headers: privateHeaders });
}
