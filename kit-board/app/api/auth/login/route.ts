import { NextResponse } from 'next/server';
import { cookieName, requireSameOrigin } from '@/lib/auth';
import { consumeLoginAttempt } from '@/lib/db';
import { digest, issueSession, verifyPassword } from '@/lib/crypto';
import { readJson, RequestError } from '@/lib/contracts';
import { failure, privateHeaders } from '@/lib/http';

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const hash = process.env.SITE_PASSWORD_HASH;
    const secret = process.env.SESSION_SECRET;
    if (!hash || !secret) throw new RequestError('Sign-in is not configured yet', 503);
    const payload = await readJson(request, 4096) as { password?: unknown } | null;
    if (!payload || typeof payload.password !== 'string' || payload.password.length > 512) throw new RequestError('Enter your password');
    // Vercel supplies this header; local development uses a single loopback bucket.
    const ip = process.env.VERCEL ? (request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown') : 'local';
    if (!await consumeLoginAttempt('global', 120)) throw new RequestError('Too many attempts. Try again in 15 minutes.', 429);
    if (!await consumeLoginAttempt('ip:' + digest(ip + secret), 10)) throw new RequestError('Too many attempts. Try again in 15 minutes.', 429);
    if (!(await verifyPassword(payload.password, hash))) throw new RequestError('That password did not match', 401);
    const response = NextResponse.json({ ok: true }, { headers: privateHeaders });
    response.cookies.set(cookieName, issueSession(secret, hash), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 7 * 86400 });
    return response;
  } catch (error) { return failure(error); }
}
