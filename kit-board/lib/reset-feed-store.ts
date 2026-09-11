import 'server-only';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { database } from './db';
import { stableJson } from './contracts';
import { feedSources, normalizeFeed, RESET_NORMALIZATION_VERSION, type FeedSource } from './reset-feeds';

async function readFeed(response: Response) {
  if (!response.headers.get('content-type')?.includes('json')) throw new Error('unexpected_content_type');
  const reader = response.body?.getReader(); if (!reader) throw new Error('empty_response');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('response_too_large'); } chunks.push(value); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function syncResetFeeds() {
  const sql = database();
  return Promise.all(Object.entries(feedSources).map(async ([key, definition]) => {
    const source = key as FeedSource;
    await sql`INSERT INTO personal_hub.reset_feed_state(source) VALUES(${source}) ON CONFLICT DO NOTHING`;
    const [state] = await sql`UPDATE personal_hub.reset_feed_state SET checked_at = now(), next_check_at = now() + interval '30 minutes'
      WHERE source = ${source} AND (next_check_at IS NULL OR next_check_at <= now() OR
        ((error IS NULL OR error NOT LIKE ${`v${RESET_NORMALIZATION_VERSION}:%`}) AND checked_at < now() - interval '30 seconds' AND EXISTS (
          SELECT 1 FROM personal_hub.reset_feed_revisions r WHERE r.source = ${source}
          AND r.content_hash = reset_feed_state.current_hash
          AND COALESCE(r.payload->>'normalization_version', '') <> ${String(RESET_NORMALIZATION_VERSION)}))) RETURNING *`;
    if (!state) return { source, cached: true };
    try {
      const [saved] = await sql`SELECT payload->>'normalization_version' AS version FROM personal_hub.reset_feed_revisions
        WHERE source = ${source} AND content_hash = ${state.current_hash}`;
      // Old normalized payloads need fresh source bytes, even if the upstream ETag is unchanged.
      const currentVersion = saved?.version === String(RESET_NORMALIZATION_VERSION);
      const response = await fetch(definition.url, { headers: { Accept: 'application/json', 'User-Agent': 'PersonalObservatory/1.0 (private feed reader)',
        ...(currentVersion && state.etag ? { 'If-None-Match': state.etag } : {}), ...(currentVersion && state.last_modified ? { 'If-Modified-Since': state.last_modified } : {}) },
        cache: 'no-store', signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (response.status === 304 && currentVersion && state.current_hash) {
        await sql`UPDATE personal_hub.reset_feed_state SET succeeded_at = now(), error = NULL WHERE source = ${source}`;
        return { source, unchanged: true };
      }
      if (!response.ok) throw new Error(`http_${response.status}`);
      const payload = normalizeFeed(source, await readFeed(response));
      const contentHash = createHash('sha256').update(stableJson(payload)).digest('hex');
      await sql.begin(async transaction => {
        // postgres 3.4.8 TransactionSql uses Omit, which drops the callable signature.
        const tx = transaction as unknown as postgres.Sql;
        await tx`INSERT INTO personal_hub.reset_feed_revisions(source, content_hash, payload)
          VALUES(${source}, ${contentHash}, ${tx.json(payload as unknown as postgres.JSONValue)}) ON CONFLICT DO NOTHING`;
        await tx`UPDATE personal_hub.reset_feed_state SET succeeded_at = now(), error = NULL, current_hash = ${contentHash},
          etag = ${response.headers.get('etag')}, last_modified = ${response.headers.get('last-modified')} WHERE source = ${source}`;
      });
      return { source, ok: true, items: payload.items.length };
    } catch (error) {
      const message = error instanceof Error && /^http_\d+$/.test(error.message) ? error.message : 'feed_unavailable_or_changed';
      await sql`UPDATE personal_hub.reset_feed_state SET error = ${`v${RESET_NORMALIZATION_VERSION}:${message}`} WHERE source = ${source}`;
      return { source, ok: false, error: message };
    }
  }));
}
export async function resetFeedDashboard() {
  const rows = await database()`SELECT s.source, s.checked_at, s.succeeded_at, s.error, r.payload,
    (SELECT count(*)::int FROM personal_hub.reset_feed_revisions h WHERE h.source = s.source) AS revisions
    FROM personal_hub.reset_feed_state s LEFT JOIN personal_hub.reset_feed_revisions r ON r.source = s.source AND r.content_hash = s.current_hash`;
  return JSON.parse(JSON.stringify(rows.map(row => ({ ...row, ...feedSources[row.source as FeedSource] }))));
}
