import { requireSession } from '@/lib/auth';
import { reportById } from '@/lib/db';
import { failure, privateHeaders } from '@/lib/http';
import { prepareArtifact } from '@/lib/artifact';
import { rewriteAssetLinks } from '@/lib/assets';
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
    const report = await reportById((await params).id);
    if (!report?.html) return new Response('Report not found', { status: 404, headers: privateHeaders });
    const result = prepareArtifact(rewriteAssetLinks(report.html, report.id));
    return new Response(result.html, { headers: { ...privateHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': result.csp, 'Referrer-Policy': 'no-referrer' } });
  } catch (error) { return failure(error); }
}
