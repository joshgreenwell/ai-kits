import { DEFAULT_CADENCE_MINUTES } from './allowance-freshness';

/** The collector facts the compact status line needs; a subset of what `/api/usage-live` returns per source. */
export type StatusSource = {
  disabled: boolean; mode: string; last_seen_at: string | null; cadence_minutes?: number;
  coverage: { malformed_lines?: number; unavailable_roots?: number } | null;
};

export type UsageStatus = {
  /** `none` before any collector exists; `partial` when a local log could not be read; `stale` when a collector missed two cadences. */
  state: 'fresh' | 'stale' | 'partial' | 'none';
  collectors: number;
  label: string;
};

/**
 * One line of data status for the usage views: how many collectors are enabled and whether their
 * contact is current. Contact is judged per collector at its own cadence, two cadences plus a
 * quarter hour, and never stands in for reading freshness (that is the allowance card's job).
 */
export function usageStatus(sources: StatusSource[], now: number): UsageStatus {
  const enabled = sources.filter(s => !s.disabled);
  if (!enabled.length) return { state: 'none', collectors: 0, label: 'no collectors connected' };
  const partial = enabled.some(s => s.coverage?.unavailable_roots || s.coverage?.malformed_lines);
  const stale = enabled.filter(s => {
    const cadence = s.cadence_minutes ?? DEFAULT_CADENCE_MINUTES;
    return !s.last_seen_at || now - Date.parse(s.last_seen_at) > (2 * cadence + 15) * 60_000;
  });
  const collectors = enabled.length;
  if (partial) return { state: 'partial', collectors, label: 'some local logs could not be read' };
  if (stale.length === collectors) return { state: 'stale', collectors, label: 'no recent collector contact' };
  if (stale.length) return { state: 'stale', collectors, label: `${stale.length} of ${collectors} collectors quiet` };
  return { state: 'fresh', collectors, label: 'collectors current' };
}
