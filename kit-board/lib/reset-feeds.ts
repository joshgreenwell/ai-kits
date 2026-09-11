export const feedSources = {
  'codex-timeline': { label: 'Codex Reset · history', provider: 'codex', url: 'https://codex-reset.com/api/timeline' },
  'codex-announcements': { label: 'Codex Reset · announcements', provider: 'codex', url: 'https://codex-reset.com/api/feed' },
  'codex-forecast': { label: 'Codex Reset · forecast', provider: 'codex', url: 'https://codex-reset.com/api/forecast' },
  'claude-radar': { label: 'Reset Radar · Claude', provider: 'claude', url: 'https://www.resetradar.com/feed.json' },
} as const;
export type FeedSource = keyof typeof feedSources;
export const RESET_NORMALIZATION_VERSION = 4;
export type ResetKind = 'global' | 'banked' | 'reset' | 'window_flush' | 'credits' | 'watch' | 'signal' | 'forecast';
export type ResetItem = { id: string; provider: string; title: string; at: string; effective_at: string | null;
  url: string; category: 'history' | 'announcement' | 'forecast'; status: string; confidence: string | null; scope: string | null; reset_kind?: ResetKind; source_type?: string; banked_state?: string | null; announcement_state?: string | null; verification_status?: string | null; observation_result?: string | null };
export type ResetDocument = { normalization_version?: number; items: ResetItem[]; source_updated_at: string | null; upstream_stale: boolean;
  forecast?: { probability24: number | null; probability48: number | null; confidence: string; note: string; official: string | null; last_reset_at: string | null } };
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown, max = 1200) => typeof v === 'string' ? v.slice(0, max).trim() : '';
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const url = (v: unknown) => { try { const u = new URL(str(v, 2048)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
function array(v: unknown) { if (!Array.isArray(v)) throw new Error('Feed schema changed'); return v.slice(0, 1000); }
function codexKind(v: Obj): ResetKind {
  const type = str(v.type || v.kind);
  if (v.reset_kind === 'banked' || type === 'banked') return 'banked';
  if (type === 'credits') return 'credits';
  if (type === 'watch' || type === 'signal') return type;
  if (v.explicit_reset_claim === true || v.tibo_lane === 'reset_announcement') return 'global';
  return v.scope === 'global' ? 'global' : 'reset';
}
function codexDetails(v: Obj) {
  return { reset_kind: codexKind(v), source_type: str(v.type || v.kind, 80),
    banked_state: str(v.banked_state, 100) || null, announcement_state: str(v.announcement_state, 100) || null,
    verification_status: str(v.reset_verification_status, 100) || null, observation_result: str(v.observation_result, 100) || null };
}
function officialText(v: unknown) { if (typeof v === 'string') return str(v); const o = obj(v); return str(o.summary || o.text || o.label) || null; }
export function normalizeFeed(source: FeedSource, payload: unknown): ResetDocument {
  const data = obj(payload), items: ResetItem[] = [];
  const add = (item: ResetItem) => { if (item.id && item.title && item.at && item.url) items.push(item); };
  if (source === 'codex-timeline') {
    for (const value of array(data.events)) {
      const v = obj(value);
      if (!['reset', 'credits', 'banked', 'watch', 'signal'].includes(str(v.type))) continue;
      const at = date(v.announced_at || v.date);
      if (!at) continue;
      add({ id: str(v.id, 160), provider: 'codex', title: str(v.summary), at, effective_at: date(v.effective_at), url: url(v.url),
        category: v.preview || v.type !== 'reset' ? 'announcement' : 'history',
        ...codexDetails(v), status: str(v.banked_state || v.reset_verification_status || v.observation_result || v.announcement_state || 'reported', 100),
        confidence: str(v.confidence, 50) || null, scope: str(v.scope, 100) || null });
    }
  } else if (source === 'codex-announcements') {
    for (const value of array(data.tweets)) {
      const v = obj(value);
      if (!['reset', 'candidate', 'banked', 'signal', 'watch'].includes(str(v.kind))) continue;
      const at = date(v.at); if (!at) continue;
      add({ id: str(v.id, 160), provider: 'codex', title: str(v.text), at, effective_at: null, url: url(v.url), category: 'announcement',
        ...codexDetails(v), status: str(v.banked_state || v.reset_verification_status || v.kind, 100), confidence: str(v.confidence, 50) || null, scope: str(v.scope, 100) || null });
    }
  } else if (source === 'claude-radar') {
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
    const p = obj(data.probabilities);
    if (!Object.keys(p).length || !date(data.updated_at)) throw new Error('Forecast schema changed');
    const probability = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 100 ? v : null;
    return { normalization_version: RESET_NORMALIZATION_VERSION, items: [], source_updated_at: date(data.updated_at), upstream_stale: data.stale === true,
      forecast: { probability24: probability(p.rounded_24h), probability48: probability(p.rounded_48h),
        confidence: str(data.confidence, 80), note: str(data.confidence_note), official: officialText(data.official_signal), last_reset_at: date(data.last_reset_at) } };
  }
  return { normalization_version: RESET_NORMALIZATION_VERSION, items, source_updated_at: date(data.updated_at || data.fetched_at), upstream_stale: data.stale === true };
}
