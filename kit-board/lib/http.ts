import { ZodError } from 'zod';
import { RequestError } from './contracts';
export const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
export function failure(error: unknown) {
  if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders });
  if (error instanceof ZodError) return Response.json({ error: 'Report validation failed', issues: error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400, headers: privateHeaders });
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
  // Names/codes only: driver messages and stacks may contain SQL values or secrets.
  console.error('Request failed', { name: error instanceof Error ? error.name : 'Unknown', code: /^[A-Z0-9_]{1,60}$/.test(code) ? code : 'UNKNOWN' });
  return Response.json({ error: 'The request could not be completed. Please try again.' }, { status: 503, headers: privateHeaders });
}
