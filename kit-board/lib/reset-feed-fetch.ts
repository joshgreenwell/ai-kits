import { feedSources, isFeedSource, nextResetUrls, normalizeFeed, RESET_NORMALIZATION_VERSION, type FeedSource, type ResetDocument } from './reset-feeds';
import { normalizeNextReset } from './nextreset-feeds';

async function readFeed(response: Response) {
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('unexpected_content_type');
  const reader = response.body?.getReader(); if (!reader) throw new Error('empty_response');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('response_too_large'); } chunks.push(value); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
type Saved = { version?: string; current_hash?: string | null; etag?: string | null; last_modified?: string | null };
type Result = { unchanged: true } | { payload: ResetDocument; etag: string | null; last_modified: string | null };

/** One instance per shared-lease sync: at most one request to each public endpoint. */
export function createResetFeedFetcher(fetcher: typeof fetch = fetch) {
  const request = (url: string, conditional: Record<string, string> = {}) => fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'PersonalObservatory/1.0 (private feed reader)', ...conditional },
    cache: 'no-store', signal: AbortSignal.timeout(15_000), redirect: 'error', credentials: 'omit',
  });
  let snapshot: Promise<[unknown, unknown]> | undefined;
  const nextReset = () => snapshot ??= Promise.all(Object.values(nextResetUrls).map(async url => {
    const response = await request(url);
    if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
    return readFeed(response);
  })) as Promise<[unknown, unknown]>;

  return async (source: FeedSource, saved: Saved = {}): Promise<Result> => {
    if (!isFeedSource(source)) throw new Error('Inactive feed source');
    if (source === 'nextreset-timeline' || source === 'nextreset-announcements') {
      const [archive, status] = await nextReset();
      // Two response documents form one snapshot; never reuse a single response's
      // validator for the combined document or send an old provider's validator.
      return { payload: normalizeNextReset(source, archive, status), etag: null, last_modified: null };
    }
    const canRevalidate = saved.version === String(RESET_NORMALIZATION_VERSION) && !!saved.current_hash;
    const response = await request(feedSources[source].url, {
      ...(canRevalidate && saved.etag ? { 'If-None-Match': saved.etag } : {}),
      ...(canRevalidate && saved.last_modified ? { 'If-Modified-Since': saved.last_modified } : {}),
    });
    if (response.status === 304 && canRevalidate) return { unchanged: true };
    if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
    return { payload: normalizeFeed(source, await readFeed(response)), etag: response.headers.get('etag'), last_modified: response.headers.get('last-modified') };
  };
}
