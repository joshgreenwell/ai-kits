import 'server-only';
import { cookies } from 'next/headers';
import { verifySession } from './crypto';
import { RequestError, type ReportKind } from './contracts';
import { producerForToken } from './producer-credentials';

export const cookieName = process.env.NODE_ENV === 'production' ? '__Host-personal-hub' : 'personal-hub';
export async function authenticated() {
  return verifySession((await cookies()).get(cookieName)?.value ?? '', process.env.SESSION_SECRET ?? '', process.env.SITE_PASSWORD_HASH ?? '');
}
export async function requireSession() { if (!(await authenticated())) throw new RequestError('Please sign in', 401); }
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = process.env.SITE_URL ?? new URL(request.url).origin;
  if (origin !== expected) throw new RequestError('Invalid request origin', 403);
}
export function requireProducer(request: Request, kind: ReportKind): string {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length > 512) throw new RequestError('Unauthorized', 401);
  const producer = producerForToken(
    header.slice(7),
    kind,
    process.env.INGEST_KEYS_JSON,
    process.env.USAGE_INGEST_KEYS_JSON,
  );
  if (producer) return producer;
  throw new RequestError('Unauthorized', 401);
}
