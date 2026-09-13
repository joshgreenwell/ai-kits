import 'server-only';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { database } from './db';
import { stableJson } from './contracts';
import { feedSources, RESET_NORMALIZATION_VERSION, type FeedSource } from './reset-feeds';
import { resetFeedFailure } from './reset-feed-errors';
import { createResetFeedFetcher } from './reset-feed-fetch';
import { resetFeedDefinition } from './reset-feed-fallback';

export async function syncResetFeeds() {
  const sql = database();
  const fetchFeed = createResetFeedFetcher();
  return Promise.all(Object.keys(feedSources).map(async key => {
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
      const [saved] = await sql`SELECT payload->>'normalization_version' AS version, payload->>'provenance' AS provenance FROM personal_hub.reset_feed_revisions
        WHERE source = ${source} AND content_hash = ${state.current_hash}`;
      const result = await fetchFeed(source, { ...state, ...saved });
      if ('unchanged' in result) {
        await sql`UPDATE personal_hub.reset_feed_state SET succeeded_at = now(), error = NULL WHERE source = ${source}`;
        return { source, unchanged: true };
      }
      const { payload } = result;
      const contentHash = createHash('sha256').update(stableJson(payload)).digest('hex');
      await sql.begin(async transaction => {
        // postgres 3.4.8 TransactionSql uses Omit, which drops the callable signature.
        const tx = transaction as unknown as postgres.Sql;
        await tx`INSERT INTO personal_hub.reset_feed_revisions(source, content_hash, payload)
          VALUES(${source}, ${contentHash}, ${tx.json(payload as unknown as postgres.JSONValue)}) ON CONFLICT DO NOTHING`;
        await tx`UPDATE personal_hub.reset_feed_state SET succeeded_at = now(), error = NULL, current_hash = ${contentHash},
          etag = ${result.etag}, last_modified = ${result.last_modified} WHERE source = ${source}`;
      });
      console.info('Reset feed refreshed', { source, via: payload.provenance ?? 'primary', items: payload.items.length,
        ...(payload.primary_error ? { primary_error: payload.primary_error } : {}) });
      return { source, ok: true, items: payload.items.length };
    } catch (error) {
      const message = resetFeedFailure(error);
      console.warn('Reset feed refresh failed', { source, reason: message });
      await sql`UPDATE personal_hub.reset_feed_state SET error = ${`v${RESET_NORMALIZATION_VERSION}:${message}`} WHERE source = ${source}`;
      return { source, ok: false, error: message };
    }
  }));
}
export async function resetFeedDashboard() {
  const rows = await database()`SELECT s.source, s.checked_at, s.succeeded_at, s.error, r.payload,
    (SELECT count(*)::int FROM personal_hub.reset_feed_revisions h WHERE h.source = s.source) AS revisions
    FROM personal_hub.reset_feed_state s LEFT JOIN personal_hub.reset_feed_revisions r ON r.source = s.source AND r.content_hash = s.current_hash`;
  return JSON.parse(JSON.stringify(rows.map(row => ({ ...row, ...resetFeedDefinition(row.source as FeedSource, row.payload) }))));
}
