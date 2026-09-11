import { requireProducer } from '@/lib/auth';
import { assetDescriptor, readTextAsset } from '@/lib/assets';
import { storeAsset } from '@/lib/assets-store';
import { kinds } from '@/lib/contracts';
import { reportById } from '@/lib/db';
import { failure, privateHeaders } from '@/lib/http';

export async function POST(request: Request, context: { params: Promise<{ kind: string; id: string }> }) {
  try {
    const { kind, id } = await context.params;
    const reportKind = kinds.find(value => value === kind);
    if (!reportKind) return Response.json({ error: 'Unknown report type' }, { status: 404, headers: privateHeaders });
    const producer = requireProducer(request, reportKind);
    const report = await reportById(id);
    if (!report || report.kind !== reportKind || report.producer_id !== producer) return Response.json({ error: 'Report not found' }, { status: 404, headers: privateHeaders });
    const sourcePath = request.headers.get('x-asset-path') ?? '';
    const descriptor = assetDescriptor(sourcePath);
    const announcedKey = request.headers.get('x-asset-key');
    const announcedFilename = request.headers.get('x-asset-filename');
    if (announcedKey !== descriptor.assetKey || announcedFilename !== descriptor.filename) return Response.json({ error: 'Asset metadata does not match its path' }, { status: 400, headers: privateHeaders });
    const content = await readTextAsset(request);
    const receipt = await storeAsset(id, descriptor, content);
    return Response.json({ ok: true, ...receipt }, { status: receipt.duplicate ? 200 : 201, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
