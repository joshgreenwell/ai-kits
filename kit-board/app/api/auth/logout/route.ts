import { NextResponse } from 'next/server';
import { cookieName, requireSameOrigin } from '@/lib/auth';
import { failure, privateHeaders } from '@/lib/http';
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const response = NextResponse.redirect(new URL('/login', request.url), 303);
    for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
    response.cookies.set(cookieName, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
    return response;
  } catch (error) { return failure(error); }
}
