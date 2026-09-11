/** Bounded GETs only. Retry a transient failure once; navigation aborts both attempts. */
export async function fetchPrivateJson<T>(url: string, parent: AbortSignal, timeoutMs = 8000): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([parent, timeout]);
    try {
      const response = await fetch(url, { signal, cache: 'no-store' });
      if (attempt === 0 && (response.status === 503 || response.status === 504)) { await response.body?.cancel(); continue; }
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return await response.json() as T;
    } catch (error) {
      if (parent.aborted) throw error;
      if (attempt === 0 && (timeout.aborted || error instanceof TypeError)) continue;
      throw error;
    }
  }
  throw new Error('Request unavailable');
}
