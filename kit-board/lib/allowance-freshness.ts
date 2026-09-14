/**
 * One freshness rule for every allowance reading surface: the dashboard's current reading,
 * the live cards, the routing quota state, and the Connections page. The companion applies
 * the same formula to its `no_recent_samples` capability detail, and the metric contract
 * states it once: a reading is stale when it is older than the larger of two hours and two
 * collection cadences plus fifteen minutes, or when its window has already reset.
 * Collector contact is a different fact and is never folded into this verdict.
 */
export const DEFAULT_CADENCE_MINUTES = 60;
const FLOOR_MINUTES = 120;
const SLACK_MINUTES = 15;

export type ReadingFreshness = {
  ageMinutes: number;
  staleAfterMinutes: number;
  stale: boolean;
  reason: 'age' | 'expired' | null;
};

/** Minutes a reading may age before it is stale at this cadence; the two-hour floor covers one missed run. */
export function staleAfterMinutes(cadenceMinutes = DEFAULT_CADENCE_MINUTES) {
  return Math.max(FLOOR_MINUTES, 2 * cadenceMinutes + SLACK_MINUTES);
}

const instant = (value: string | number) => (typeof value === 'number' ? value : Date.parse(value));

export function readingFreshness({ observedAt, resetsAt = null, now, cadenceMinutes = DEFAULT_CADENCE_MINUTES }: {
  observedAt: string | number; resetsAt?: string | number | null; now: number; cadenceMinutes?: number;
}): ReadingFreshness {
  const observed = instant(observedAt);
  const reset = resetsAt === null ? null : instant(resetsAt);
  // An unreadable observation time is reported as stale rather than silently fresh.
  const ageMinutes = Number.isFinite(observed) ? Math.max(0, (now - observed) / 60_000) : Number.POSITIVE_INFINITY;
  const limit = staleAfterMinutes(cadenceMinutes);
  const expired = reset !== null && Number.isFinite(reset) && reset <= now;
  const aged = ageMinutes > limit;
  return { ageMinutes, staleAfterMinutes: limit, stale: aged || expired, reason: expired ? 'expired' : aged ? 'age' : null };
}
