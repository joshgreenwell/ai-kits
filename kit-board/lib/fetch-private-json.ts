import { USAGE_QUERY_CLIENT_TIMEOUT_MS } from './database-budget';

/** Tokens `/api/usage-query` ranks in-range keys per section; the bound outlasts the server's read budget so a read the server will cache is never abandoned. */
export const USAGE_QUERY_TIMEOUT_MS = USAGE_QUERY_CLIENT_TIMEOUT_MS;

/** Bounded GETs only. Retry a transient failure once; navigation aborts both attempts. A 504 is the server's read budget and is not retried. */
export async function fetchPrivateJson<T>(url: string, parent: AbortSignal, timeoutMs = 8000, retryTimeout = true): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([parent, timeout]);
    try {
      const response = await fetch(url, { signal, cache: 'no-store' });
      if (attempt === 0 && response.status === 503) { await response.body?.cancel(); continue; }
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return await response.json() as T;
    } catch (error) {
      if (parent.aborted) throw error;
      if (attempt === 0 && (error instanceof TypeError || (retryTimeout && timeout.aborted))) continue;
      throw error;
    }
  }
  throw new Error('Request unavailable');
}
