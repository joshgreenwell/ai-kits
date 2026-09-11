import { requireSession } from '@/lib/auth';
import { reportAsset } from '@/lib/assets-store';
import { failure, privateHeaders } from '@/lib/http';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; key: string }> }) {
  try {
    await requireSession();
    const { id, key } = await params;
    const asset = await reportAsset(id, key);
    if (!asset) return new Response('Asset not found', { status: 404, headers: privateHeaders });
    return new Response(asset.content, {
      headers: {
        ...privateHeaders,
        'Content-Type': `${asset.media_type}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${asset.filename}"`,
        'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) { return failure(error); }
}
