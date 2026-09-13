import { NextResponse, type NextRequest } from 'next/server';
import { verifySession } from './lib/crypto';
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const cookie = process.env.NODE_ENV === 'production' ? '__Host-personal-hub' : 'personal-hub';
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  const isPublic = path === '/login' || path.startsWith('/api/auth/');
  // These handlers authenticate their own scoped producer or cron credentials.
  const companion = path.startsWith('/api/v1/companion/') || path === '/api/v1/usage';
  const ingestion = (request.method === 'POST' && (path === '/api/reports' || path.startsWith('/api/v1/reports/') || path === '/api/v1/telemetry' || path === '/api/reset-feeds' || companion)) ||
    (request.method === 'PUT' && path === '/api/v1/companion/settings') ||
    (request.method === 'GET' && (path === '/api/internal/sync-legacy-usage' || path === '/api/internal/sync-reset-feeds' || path === '/api/internal/sync-companion-release' || path === '/api/v1/companion/config'));
  const signedIn = verifySession(request.cookies.get(cookie)?.value ?? '', process.env.SESSION_SECRET ?? '', process.env.SITE_PASSWORD_HASH ?? '');
  if (!isPublic && !ingestion && !signedIn) {
    if (path.startsWith('/api/') || !isRead) return NextResponse.json({ error: 'Please sign in' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
    return NextResponse.redirect(new URL('/login', request.url));
  }
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  // Artifact responses supply their own more restrictive policy and sandbox.
  if (!path.startsWith('/api/artifacts/')) response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
  return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.svg).*)'] };
