import { ZodError } from 'zod';
import { RequestError } from './contracts';
import { DatabaseUnavailable } from './database-queue';
export const privateHeaders = { 'Cache-Control': 'private, no-store, max-age=0', 'X-Robots-Tag': 'noindex, nofollow, noarchive' };
export const READ_TIMEOUT_MESSAGE = 'The usage read took too long; try a shorter range or fewer filters';
export function failure(error: unknown) {
  // 503 stays with RequestError alone: the database not configured or not connected.
  if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status, headers: privateHeaders });
  if (error instanceof ZodError) return Response.json({ error: 'Report validation failed', issues: error.issues.map(({ path, message }) => ({ path, message })) }, { status: 400, headers: privateHeaders });
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
  // Names/codes only: driver messages and stacks may contain SQL values or secrets.
  console.error('Request failed', { name: error instanceof Error ? error.name : 'Unknown', code: /^[A-Z0-9_]{1,60}$/.test(code) ? code : 'UNKNOWN' });
  // The read budget ran out: the queue's deadline or wait limit, or Postgres cancelling on its timeout (57014).
  if (error instanceof DatabaseUnavailable || code === '57014') return Response.json({ error: READ_TIMEOUT_MESSAGE }, { status: 504, headers: privateHeaders });
  return Response.json({ error: 'The request could not be completed. Please try again.' }, { status: 500, headers: privateHeaders });
}
