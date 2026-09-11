export type QuotaWindowState = {
  sample_id: string;
  window_key: string;
  label: string;
  observed_at: string;
  used_percent: number | null;
  remaining_percent: number | null;
  resets_at: string;
  window_minutes: number | null;
  age_seconds: number | null;
  state: 'usable' | 'insufficient' | 'stale' | 'discontinuous';
  pace: { points_per_hour: number; projected_used_percent: number | null; exhaustion_at: string | null } | null;
  source_id: string;
  source_last_seen_at: string | null;
  source_age_seconds: number | null;
};

export type QuotaRow = {
  id: string; source_id: string; window_key: string; label: string; observed_at: string; used_percent: number;
  resets_at: string; window_minutes: number; source_last_seen_at: string | null;
};

export function quotaWindowState(rows: QuotaRow[], now = Date.now()): QuotaWindowState | undefined {
  const current = rows[0];
  if (!current) return;
  const observedAt = Date.parse(current.observed_at);
  const resetAt = Date.parse(current.resets_at);
  const usedPercent = Number(current.used_percent);
  const windowMinutes = Number(current.window_minutes);
  const sourceSeenAt = current.source_last_seen_at === null ? null : Date.parse(current.source_last_seen_at);
  const valid = Number.isFinite(now) && Number.isFinite(observedAt) && Number.isFinite(resetAt) &&
    Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100 && Number.isSafeInteger(windowMinutes) && windowMinutes > 0 &&
    (sourceSeenAt === null || Number.isFinite(sourceSeenAt));
  if (!valid) return { sample_id: current.id, window_key: current.window_key, label: current.label, observed_at: current.observed_at,
    used_percent: Number.isFinite(usedPercent) ? usedPercent : null, remaining_percent: Number.isFinite(usedPercent) ? 100 - usedPercent : null,
    resets_at: current.resets_at, window_minutes: Number.isSafeInteger(windowMinutes) ? windowMinutes : null, age_seconds: null,
    state: 'insufficient', pace: null, source_id: current.source_id, source_last_seen_at: current.source_last_seen_at, source_age_seconds: null };
  const ageSeconds = Math.max(0, Math.floor((now - observedAt) / 1000));
  const sourceAgeSeconds = sourceSeenAt === null ? null : Math.max(0, Math.floor((now - sourceSeenAt) / 1000));
  const stale = ageSeconds > 7_200 || resetAt <= now || (sourceAgeSeconds !== null && sourceAgeSeconds > 7_200);
  const previous = rows[1];
  const previousAt = previous ? Date.parse(previous.observed_at) : null;
  const previousUsed = previous ? Number(previous.used_percent) : null;
  const discontinuous = !!previous && (
    !Number.isFinite(previousAt) || !Number.isFinite(previousUsed) || previous.resets_at !== current.resets_at || previous.window_minutes !== current.window_minutes ||
    previousUsed! > usedPercent || (previousAt === observedAt && previousUsed !== usedPercent) || observedAt - previousAt! > 3 * 3_600_000
  );
  const state: QuotaWindowState['state'] = stale ? 'stale' : discontinuous ? 'discontinuous' : 'usable';
  let pace: QuotaWindowState['pace'] = null;
  if (state === 'usable' && previous) {
    const elapsedHours = (observedAt - previousAt!) / 3_600_000;
    const pointsPerHour = elapsedHours > 0 ? (usedPercent - previousUsed!) / elapsedHours : 0;
    const exhaustionAt = pointsPerHour > 0 ? observedAt + (100 - usedPercent) / pointsPerHour * 3_600_000 : null;
    pace = { points_per_hour: pointsPerHour, projected_used_percent: usedPercent + pointsPerHour * ((resetAt - observedAt) / 3_600_000), exhaustion_at: exhaustionAt === null ? null : new Date(exhaustionAt).toISOString() };
  }
  return { sample_id: current.id, window_key: current.window_key, label: current.label, observed_at: current.observed_at,
    used_percent: usedPercent, remaining_percent: 100 - usedPercent, resets_at: current.resets_at,
    window_minutes: windowMinutes, age_seconds: ageSeconds, state, pace, source_id: current.source_id,
    source_last_seen_at: current.source_last_seen_at, source_age_seconds: sourceAgeSeconds };
}
