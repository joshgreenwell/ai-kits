import { z } from 'zod';
import type { QuotaSample } from './telemetry-contract';

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const calibrationMethod = 'local-equivalent-v1-prorated-hours';
export type EstimateQuota = QuotaSample & { id: string; account_id: string };
type Hour = { account_id: string; hour: string; total_tokens: number };
type Source = { id: string; account_id: string; mode: string; disabled: boolean; last_seen_at: string | null;
  coverage: { since?: string; unavailable_roots?: number; malformed_lines?: number } | null };
export type Calibration = {
  id: string; account_id: string; window_key: string; window_minutes: number;
  start_sample_id: string; end_sample_id: string; started_at: string; ended_at: string;
  local_tokens: number; percent_delta: number; tokens_per_point: number;
  method_version: string; confirmed_at: string; revoked_at: string | null;
};
export type EstimateData = {
  accounts: { id: string; provider: string; label: string }[];
  quotas: EstimateQuota[]; hourly: Hour[]; sources: Source[];
};
export const calibrationRequest = z.object({
  account_id: z.string().min(1).max(80), start_sample_id: z.uuid(), end_sample_id: z.uuid(),
  confirm_local_only: z.literal(true),
}).strict();

// Model-specific quota windows cannot be compared with all-model local totals.
export function allModelWindow(q: QuotaSample) {
  return (q.window_key === 'five_hour' && q.window_minutes === 300) ||
    (q.window_key === 'seven_day' && q.window_minutes === 10080);
}
const at = (q: QuotaSample) => Date.parse(q.observed_at);
const sameWindow = (a: QuotaSample, b: QuotaSample) => a.window_key === b.window_key && a.window_minutes === b.window_minutes && Date.parse(a.resets_at) === Date.parse(b.resets_at);
const continuous = (a: QuotaSample, b: QuotaSample) => sameWindow(a, b) && at(b) > at(a) && at(b) - at(a) <= 3 * HOUR && b.used_percent >= a.used_percent;

/** Reject conflicting simultaneous observations rather than selecting a convenient reading. */
function orderedQuotas(rows: EstimateQuota[]) {
  const rowsByTime = new Map<number, EstimateQuota>();
  for (const q of [...rows].sort((a, b) => at(a) - at(b) || a.id.localeCompare(b.id))) {
    const previous = rowsByTime.get(at(q));
    if (previous && (!sameWindow(previous, q) || previous.used_percent !== q.used_percent)) return null;
    if (!previous) rowsByTime.set(at(q), q);
  }
  return [...rowsByTime.values()];
}

/** Uniform activity within boundary hours is an explicit approximation, not observed timing. */
export function intervalTokens(rows: Hour[], accountId: string, start: number, end: number) {
  return rows.reduce((sum, row) => {
    if (row.account_id !== accountId) return sum;
    const hour = Date.parse(row.hour), overlap = Math.max(0, Math.min(end, hour + HOUR) - Math.max(start, hour));
    return sum + Number(row.total_tokens) * overlap / HOUR;
  }, 0);
}

function coverageProblem(data: EstimateData, accountId: string, start: number, end: number, now: number) {
  const sources = data.sources.filter(s => s.account_id === accountId && s.mode === 'local' && !s.disabled);
  if (!sources.length) return 'Connect a local collector for this account to establish and check the baseline.';
  const completeThrough = Math.ceil(end / HOUR) * HOUR;
  if (completeThrough > now) return 'Wait for the boundary hour to finish and its local collection to arrive.';
  for (const source of sources) {
    if (!source.last_seen_at || now - Date.parse(source.last_seen_at) > 2 * HOUR || Date.parse(source.last_seen_at) < completeThrough)
      return 'Waiting for every enabled local collector on this account to catch up.';
    if (!source.coverage?.since || Date.parse(source.coverage.since + 'T00:00:00Z') > start || source.coverage.unavailable_roots || source.coverage.malformed_lines)
      return 'Local collection is incomplete for this period. Check the account’s collectors.';
  }
  return null;
}

export function calibrationPreview(data: EstimateData, accountId: string, startId: string, endId: string, now = Date.now()) {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!data.accounts.some(a => a.id === accountId && a.provider === 'claude')) return fail('Choose a Claude account.');
  const start = data.quotas.find(q => q.id === startId && q.account_id === accountId);
  const end = data.quotas.find(q => q.id === endId && q.account_id === accountId);
  if (!start || !end || !allModelWindow(start) || !sameWindow(start, end)) return fail('Choose two readings from the same all-model allowance window and reset.');
  if (at(end) - at(start) < 2 * HOUR || at(start) < now - 9 * DAY || at(end) > now)
    return fail('Choose a local-only period lasting at least two hours within the last nine days.');
  const samples = orderedQuotas(data.quotas.filter(q => q.account_id === accountId && q.window_key === start.window_key && at(q) >= at(start) && at(q) <= at(end)));
  if (!samples || samples.length < 3 || samples.slice(1).some((q, i) => !continuous(samples[i], q)))
    return fail('This period crosses a reset, decrease, conflicting reading, or collection gap. At least three readings are required.');
  const delta = end.used_percent - start.used_percent;
  if (delta < 3) return fail('At least three allowance percentage points are needed for a useful baseline.');
  const coverage = coverageProblem(data, accountId, at(start), at(end), now);
  if (coverage) return fail(coverage);
  const local = intervalTokens(data.hourly, accountId, at(start), at(end));
  if (!(local > 0) || !Number.isFinite(local)) return fail('No local token activity was recorded in this period.');
  return { ok: true as const, value: {
    account_id: accountId, window_key: start.window_key, window_minutes: start.window_minutes,
    start_sample_id: start.id, end_sample_id: end.id, started_at: start.observed_at, ended_at: end.observed_at,
    local_tokens: local, percent_delta: delta, tokens_per_point: local / delta, method_version: calibrationMethod,
  }, samples: samples.length };
}

export function cloudEstimate(data: EstimateData, accountId: string, calibrations: Calibration[], now = Date.now()) {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!data.accounts.some(a => a.id === accountId && a.provider === 'claude')) return fail('Cloud estimates currently support Claude accounts.');
  const quotas = data.quotas.filter(q => q.account_id === accountId && allModelWindow(q));
  if (!quotas.length) return fail('Waiting for Claude allowance readings. Pair the browser collector or use the local statusline hook.');
  const active = calibrations.filter(c => c.account_id === accountId && !c.revoked_at && c.method_version === calibrationMethod &&
    Date.parse(c.ended_at) >= now - 30 * DAY && c.tokens_per_point > 0 && Number.isFinite(c.tokens_per_point))
    .sort((a, b) => Date.parse(b.confirmed_at) - Date.parse(a.confirmed_at));
  // The most recently confirmed scope is the user's selection. Never add quota windows together.
  const selected = active[0];
  if (!selected) return fail('Save a confirmed local-only baseline below. Baselines expire after 30 days.');
  const baselines: Calibration[] = [];
  for (const c of active) {
    if (c.window_key !== selected.window_key || c.window_minutes !== selected.window_minutes || baselines.length >= 5) continue;
    if (baselines.some(b => Date.parse(c.started_at) < Date.parse(b.ended_at) && Date.parse(c.ended_at) > Date.parse(b.started_at))) continue;
    baselines.push(c);
  }
  const rates = baselines.map(c => c.tokens_per_point).sort((a, b) => a - b);
  const middle = Math.floor(rates.length / 2), rate = rates.length % 2 ? rates[middle] : (rates[middle - 1] + rates[middle]) / 2;
  if ((rates.at(-1)! - rates[0]) / rate > 0.35) return fail('Your baselines disagree by more than 35%. Recalibrate for your current model and workload.');
  const observations = orderedQuotas(quotas.filter(q => q.window_key === selected.window_key && q.window_minutes === selected.window_minutes && at(q) <= now));
  if (!observations?.length) return fail('Conflicting allowance readings. Wait for a consistent collection.');
  const latest = observations.at(-1)!;
  if (now - at(latest) > 2 * HOUR || Date.parse(latest.resets_at) <= now) return fail('Waiting for a fresh allowance reading after the current reset or collection gap.');
  const after = Math.max(now - DAY, ...baselines.map(c => Date.parse(c.ended_at)));
  const intervals: { start: string; end: string; points: number; local: number }[] = [];
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i - 1], b = observations[i];
    if (at(a) < after || !continuous(a, b) || Math.ceil(at(b) / HOUR) * HOUR > now) continue;
    // Unknown local activity is never silently treated as cloud consumption.
    if (coverageProblem(data, accountId, at(a), at(b), now)) continue;
    intervals.push({ start: a.observed_at, end: b.observed_at, points: b.used_percent - a.used_percent, local: intervalTokens(data.hourly, accountId, at(a), at(b)) });
  }
  if (!intervals.length) return fail('Waiting for complete, collected intervals after your baseline. Local and allowance readings must both be fresh.');
  const points = intervals.reduce((s, i) => s + i.points, 0), local = intervals.reduce((s, i) => s + i.local, 0);
  if (points < 3) return fail('Waiting for three more allowance percentage points after your baseline.');
  const total = points * rate;
  // Aggregate the signed residual first. Flooring every hour would invent positive usage from noise.
  if (local > total) return fail('Observed local usage exceeds this baseline’s estimate. Recalibrate; this does not mean cloud usage was zero.');
  return { ok: true as const, value: { window_key: selected.window_key, window_minutes: selected.window_minutes,
    local_tokens: local, estimated_unobserved_tokens: total - local, estimated_total_tokens: total,
    points, tokens_per_point: rate, baseline_count: baselines.length, interval_count: intervals.length,
    covered_hours: intervals.reduce((s, i) => s + (Date.parse(i.end) - Date.parse(i.start)) / HOUR, 0),
    started_at: intervals[0].start, ended_at: intervals.at(-1)!.end, intervals } };
}
