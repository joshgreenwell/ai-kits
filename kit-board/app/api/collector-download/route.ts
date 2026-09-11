import { requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
import bundles from '@/lib/generated/collector-bundles.json';
export async function GET(request: Request) {
  try {
    await requireSession();
    const kind = new URL(request.url).searchParams.get('kind');
    if (kind !== 'local' && kind !== 'browser') return Response.json({ error: 'Unknown collector' }, { status: 400, headers: privateHeaders });
    return new Response(Buffer.from(bundles[kind], 'base64'), { headers: { ...privateHeaders,
      'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="observatory-${kind}-collector.zip"` } });
  } catch (error) { return failure(error); }
}
