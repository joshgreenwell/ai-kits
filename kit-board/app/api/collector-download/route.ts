import { requireSession } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
export async function GET() {
  try {
    await requireSession();
    return Response.json({ error: 'Legacy collector downloads are retired. Pair a companion instead.' }, { status: 410, headers: privateHeaders });
  } catch (error) { return failure(error); }
}
