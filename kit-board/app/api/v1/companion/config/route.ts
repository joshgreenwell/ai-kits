import { failure, privateHeaders } from '@/lib/http';
import { usageStore } from '@/lib/usage-store';
export const maxDuration = 15;
/** The effective config document for the install; `ETag` and `If-None-Match` avoid re-downloading it. The User-Agent names the companion build, which gates settings older builds cannot parse. */
export async function GET(request: Request) {
  try {
    const install = await usageStore.companionInstall(request);
    const { document, etag } = await usageStore.companionConfig(install, request.headers.get('user-agent'));
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ...privateHeaders, ETag: etag } });
    return Response.json(document, { headers: { ...privateHeaders, ETag: etag } });
  } catch (error) { return failure(error); }
}
