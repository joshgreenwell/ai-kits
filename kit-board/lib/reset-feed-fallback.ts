import { feedSources, RESET_NORMALIZATION_VERSION, type FeedSource, type ResetDocument, type ResetItem } from './reset-feeds';

export const nextResetUrls = { archive: 'https://nextreset.net/api/resets', status: 'https://nextreset.net/api/status' } as const;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const str = (v: unknown, max = 1200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const english = (v: unknown) => str(obj(v).en);

function record(value: unknown, announcement: boolean, pending = false): ResetItem | null {
  const v = obj(value), at = date(v.announcedAt), id = str(v.id, 160), title = english(v.title);
  if (!['regular', 'banked', 'compensation', 'mixed'].includes(str(v.kind))) return null;
  if (!['x_post', 'observed'].includes(str(v.sourceKind))) return null;
  let link: URL;
  try { link = new URL(str(v.sourceUrl, 2048)); } catch { return null; }
  if (!id || !at || !title || link.protocol !== 'https:' || link.username || link.password) return null;
  const regular = v.kind === 'regular';
  return { id, provider: 'codex', title: title + (english(v.summary) ? `\n${english(v.summary)}` : ''),
    at, effective_at: null, url: link.href,
    category: pending || announcement || !regular ? 'announcement' : 'history',
    reset_kind: v.kind === 'banked' ? 'banked' : !regular ? 'credits' : v.scope === 'broad' ? 'global' : 'reset',
    source_type: `nextreset:${str(v.sourceKind, 40)}:${str(v.kind, 40)}`,
    status: pending ? 'pending announcement' : v.sourceKind === 'observed' ? 'archive observation' : !regular ? 'announced credits' : announcement ? 'reset announcement' : 'reported reset',
    confidence: null, scope: str(v.scope, 100) || null,
    // An archive record never proves a credit was redeemed, a personal window reset,
    // or that the publication/observation time was the actual account reset time.
    banked_state: v.kind === 'banked' ? 'announced' : null };
}

/** Documented public archive + status; original source links and dates are retained. */
export function normalizeNextReset(source: 'codex-timeline' | 'codex-announcements', archive: unknown, status: unknown): ResetDocument {
  const data = obj(archive), current = obj(status), meta = obj(data.meta), statusMeta = obj(current.meta);
  const checked = date(meta.checked_at), statusChecked = date(statusMeta.checked_at);
  if (!Array.isArray(data.data) || !checked || !statusChecked || !('scheduled' in current)) throw new Error('Feed schema changed');
  const announcements = source === 'codex-announcements';
  const items = new Map<string, ResetItem>();
  for (const value of [...data.data.slice(0, 1000), current.latest_update].filter(Boolean)) {
    if (announcements && obj(value).sourceKind === 'observed') continue;
    const item = record(value, announcements);
    if (!item) throw new Error('Feed schema changed');
    items.set(item.id, item);
  }
  // scheduled is nullable. Never turn a past due time into a completed reset.
  // If its shape differs from the documented records, surface a coverage gap.
  const pending = current.scheduled == null ? null : record(current.scheduled, true, true);
  if (pending) items.set(pending.id, pending);
  const direct = obj(meta.x_source), statusDirect = obj(statusMeta.x_source);
  const complete = (v: Obj) => v.fresh === true && obj(v.coverage).posts === true && obj(v.coverage).replies === true && obj(v.coverage).caughtUp === true;
  const directChecks = [date(direct.checked_at), date(statusDirect.checked_at)];
  return { normalization_version: RESET_NORMALIZATION_VERSION, provenance: 'nextreset', items: [...items.values()],
    source_updated_at: date(meta.upstream_generated_at),
    upstream_stale: meta.fresh !== true || statusMeta.fresh !== true || meta.saved_snapshot === true || statusMeta.saved_snapshot === true,
    coverage: { checked_at: checked < statusChecked ? checked : statusChecked,
      direct_checked_at: directChecks.every(Boolean) ? (directChecks as string[]).sort()[0] : null,
      direct_complete: complete(direct) && complete(statusDirect), pending_unavailable: current.scheduled != null && !pending } };
}

export function resetFeedDefinition(source: FeedSource, payload?: ResetDocument | null) {
  if (payload?.provenance === 'nextreset' && (source === 'codex-timeline' || source === 'codex-announcements')) {
    return { provider: 'codex', label: `NextReset · ${source === 'codex-timeline' ? 'history' : 'announcements'}`,
      url: source === 'codex-timeline' ? nextResetUrls.archive : nextResetUrls.status };
  }
  return feedSources[source];
}

export function resetFeedCoverageNotes(payload?: ResetDocument | null, now = Date.now()): string[] {
  if (!payload?.coverage) return [];
  const c = payload.coverage, notes: string[] = [];
  if (payload.upstream_stale || now - Date.parse(c.checked_at) > 45 * 60_000) notes.push('Archive sync delayed');
  if (!c.direct_complete || !c.direct_checked_at || now - Date.parse(c.direct_checked_at) > 45 * 60_000) notes.push('New-post/reply review delayed or incomplete');
  if (c.pending_unavailable) notes.push('Pending announcement format unavailable; check NextReset');
  return notes;
}
