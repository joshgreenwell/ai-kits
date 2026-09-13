export const nextResetUrls = { archive: 'https://nextreset.net/api/resets', status: 'https://nextreset.net/api/status' } as const;
export const feedSources = {
  'nextreset-timeline': { label: 'NextReset · history', provider: 'codex', url: nextResetUrls.archive },
  'nextreset-announcements': { label: 'NextReset · announcements', provider: 'codex', url: nextResetUrls.status },
  'claude-radar': { label: 'Reset Radar · Claude', provider: 'claude', url: 'https://www.resetradar.com/feed.json' },
} as const;
export type FeedSource = keyof typeof feedSources;
export const RESET_NORMALIZATION_VERSION = 6;
export function isFeedSource(source: string): source is FeedSource {
  return Object.prototype.hasOwnProperty.call(feedSources, source);
}
/** Retired sources remain stored, but are never served as active feeds. */
export function activeResetFeeds<T extends { source: string }>(rows: T[]) {
  return rows.flatMap(row => isFeedSource(row.source) ? [{ ...row, ...feedSources[row.source] }] : []);
}
export type ResetKind = 'global' | 'banked' | 'reset' | 'window_flush' | 'credits' | 'watch' | 'signal' | 'forecast';
export type ResetItem = { id: string; provider: string; title: string; at: string; effective_at: string | null;
  url: string; category: 'history' | 'announcement' | 'forecast'; status: string; confidence: string | null; scope: string | null; reset_kind?: ResetKind; source_type?: string; banked_state?: string | null; announcement_state?: string | null; verification_status?: string | null; observation_result?: string | null };
export type ResetDocument = { normalization_version?: number; items: ResetItem[]; source_updated_at: string | null; upstream_stale: boolean;
  provenance?: 'nextreset';
  coverage?: { checked_at: string; direct_checked_at: string | null; direct_complete: boolean; pending_unavailable: boolean } };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown, max = 1200) => typeof v === 'string' ? v.slice(0, max).trim() : '';
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const url = (v: unknown) => { try { const u = new URL(str(v, 2048)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
function array(v: unknown) { if (!Array.isArray(v)) throw new Error('Feed schema changed'); return v.slice(0, 1000); }
export function normalizeFeed(source: 'claude-radar', payload: unknown): ResetDocument {
  const data = obj(payload), items: ResetItem[] = [];
  const add = (item: ResetItem) => { if (item.id && item.title && item.at && item.url) items.push(item); };
  if (source === 'claude-radar') {
    for (const value of array(data.items)) {
      const v = obj(value), tags = Array.isArray(v.tags) ? v.tags.map(t => str(t, 80)) : [];
      if (!tags.includes('counter-reset') && !/\b(reset|flush)\b/i.test(str(v.title))) continue;
      const at = date(v.date_published); if (!at) continue;
      const projected = tags.includes('projected'), upcoming = tags.includes('upcoming');
      add({ id: str(v.id, 160), provider: 'claude', title: str(v.title) + '\n' + str(v.content_text), at, effective_at: upcoming ? at : null,
        // Reset Radar's "global" tag means broadly observed. It does not make this
        // equivalent to a Codex goodwill reset or a personal weekly reset.
        reset_kind: projected ? 'forecast' : 'window_flush', source_type: tags.join(', '),
        url: url(v.url), category: projected ? 'forecast' : upcoming ? 'announcement' : 'history',
        status: projected ? (/graded a miss|graded.*miss|no remaining support/i.test(str(v.content_text, 8000)) ? 'missed projection' : 'projection') : upcoming ? 'announced' : 'reported',
        confidence: null, scope: tags.includes('global') ? 'broadly reported window flush' : 'reported window flush' });
    }
  } else {
    throw new Error('Inactive feed source');
  }
  return { normalization_version: RESET_NORMALIZATION_VERSION, items, source_updated_at: date(data.updated_at || data.fetched_at), upstream_stale: data.stale === true };
}
