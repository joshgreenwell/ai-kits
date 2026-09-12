import { z } from 'zod';

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stamp = z.iso.datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 300_000, 'Observation is in the future');
export const providerSchema = z.enum(['codex', 'claude']);
export const bucketSchema = z.object({
  session_hash: z.string().regex(/^[a-f0-9]{64}$/),
  hour: stamp.refine(v => Date.parse(v) % 3_600_000 === 0, 'Expected a UTC hour boundary'),
  model: z.string().min(1).max(100),
  input_tokens: counter, cached_tokens: counter, cache_write_tokens: counter,
  output_tokens: counter, total_tokens: counter, calls: counter,
}).strict().refine(v => v.total_tokens === v.input_tokens + v.cached_tokens + v.cache_write_tokens + v.output_tokens, 'Token components must be exclusive and sum to total');
export const quotaSchema = z.object({
  window_key: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),
  label: z.string().min(1).max(120), observed_at: stamp,
  used_percent: z.number().min(0).max(100), resets_at: z.iso.datetime({ offset: true }),
  window_minutes: z.number().int().positive().max(525600),
}).strict().refine(v => Date.parse(v.resets_at) > Date.parse(v.observed_at), 'Expired quota reading');
export const telemetrySchema = z.object({
  schema_version: z.literal(1), observed_at: stamp,
  buckets: z.array(bucketSchema).max(500).default([]),
  quotas: z.array(quotaSchema).max(100).default([]),
  coverage: z.object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    files: counter.optional(), bytes_read: counter.optional(),
    malformed_lines: counter.optional(), unavailable_roots: counter.optional(),
    duration_ms: counter.optional(), collector_version: z.string().max(30),
  }).strict(),
}).strict();
export type TokenBucket = z.infer<typeof bucketSchema>;
export type QuotaSample = z.infer<typeof quotaSchema>;
export type TelemetryInput = z.infer<typeof telemetrySchema>;
export const connectionSchema = z.object({
  account_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  provider: providerSchema, account_label: z.string().trim().min(1).max(80),
  machine_label: z.string().trim().min(1).max(100), mode: z.enum(['local', 'browser']),
}).strict().refine(v => v.mode !== 'browser' || v.provider === 'claude', 'Browser connections support Claude');

const HOUR = 3_600_000;
const RESET_TOLERANCE = 2 * 60_000;
const MAX_QUOTA_GAP = 3 * HOUR;

export type QuotaCycle = {
  key: string;
  resetAt: string;
  windowStartedAt: string;
  windowMinutes: number;
  samples: QuotaSample[];
  completed: boolean;
  discontinuous: boolean;
  measuredHours: number;
  usedPoints: number;
  pointsPerHour: number | null;
};

/** Group quota readings into reset-bounded cycles while tolerating small reset timestamp jitter. */
export function quotaCycles(samples: QuotaSample[], now = Date.now()): QuotaCycle[] {
  const ordered = [...samples].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const groups: { anchor: number; reset: number; windowMinutes: number; samples: QuotaSample[] }[] = [];
  for (const sample of ordered) {
    const reset = Date.parse(sample.resets_at);
    const group = groups.findLast(candidate => candidate.windowMinutes === sample.window_minutes && Math.abs(candidate.anchor - reset) <= RESET_TOLERANCE);
    if (group) {
      group.samples.push(sample);
      // The newest observation supplies the most recent provider estimate of this boundary.
      group.reset = reset;
    } else {
      groups.push({ anchor: reset, reset, windowMinutes: sample.window_minutes, samples: [sample] });
    }
  }

  return groups
    .sort((a, b) => a.reset - b.reset)
    .map(group => {
      const rows = group.samples.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
      let discontinuous = false;
      for (let i = 1; i < rows.length; i++) {
        const previous = rows[i - 1], current = rows[i];
        const gap = Date.parse(current.observed_at) - Date.parse(previous.observed_at);
        if (current.used_percent < previous.used_percent || gap <= 0 || gap > MAX_QUOTA_GAP) discontinuous = true;
      }
      const first = rows[0], last = rows.at(-1)!;
      const measuredHours = (Date.parse(last.observed_at) - Date.parse(first.observed_at)) / HOUR;
      const usedPoints = Math.max(0, last.used_percent - first.used_percent);
      const resetAt = new Date(group.reset).toISOString();
      return {
        key: `${group.windowMinutes}:${resetAt}`,
        resetAt,
        windowStartedAt: new Date(group.reset - group.windowMinutes * 60_000).toISOString(),
        windowMinutes: group.windowMinutes,
        samples: rows.map(row => ({ ...row, resets_at: resetAt })),
        completed: group.reset <= now,
        discontinuous,
        measuredHours,
        usedPoints,
        pointsPerHour: !discontinuous && measuredHours >= 0.5 ? usedPoints / measuredHours : null,
      };
    });
}

function weightedMedian(values: number[]) {
  if (!values.length) return null;
  const weighted = values.map((value, index) => ({ value, weight: 0.8 ** (values.length - index - 1) }))
    .sort((a, b) => a.value - b.value);
  const midpoint = weighted.reduce((sum, item) => sum + item.weight, 0) / 2;
  let cumulative = 0;
  for (const item of weighted) {
    cumulative += item.weight;
    if (cumulative >= midpoint) return item.value;
  }
  return weighted.at(-1)!.value;
}

function percentile(values: number[], fraction: number) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.round((ordered.length - 1) * fraction)];
}

/** Provider allowance forecasts stay in percentage points, never inferred from token counts. */
export function quotaPace(samples: QuotaSample[], now = Date.now()) {
  const ordered = [...samples].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  const latest = ordered.at(-1);
  if (!latest) return null;
  const observed = Date.parse(latest.observed_at), reset = Date.parse(latest.resets_at);
  const ageMinutes = Math.max(0, (now - observed) / 60_000);
  const stale = ageMinutes > 120 || reset <= now;
  // Changing reset anchors, a decrease, or a long collection gap starts a new segment.
  const segment = [latest];
  for (let i = ordered.length - 2; i >= 0; i--) {
    const row = ordered[i], next = segment[0];
    if (row.resets_at !== latest.resets_at || row.window_minutes !== latest.window_minutes ||
      row.used_percent > next.used_percent || Date.parse(next.observed_at) - Date.parse(row.observed_at) > 3 * 3_600_000 ||
      observed - Date.parse(row.observed_at) > 24 * 3_600_000) break;
    segment.unshift(row);
  }
  const hours = (observed - Date.parse(segment[0].observed_at)) / 3_600_000;
  const rate = !stale && hours >= 0.5 ? (latest.used_percent - segment[0].used_percent) / hours : null;
  const remaining = 100 - latest.used_percent;
  const hoursLeft = (reset - observed) / 3_600_000;
  // Anchor a forecast to the observation, not the page view time.
  const exhaustion = rate !== null && rate > 0 ? observed + remaining / rate * 3_600_000 : null;
  const projectedUsedPercent = rate === null ? null : latest.used_percent + rate * hoursLeft;
  return { ...latest, ageMinutes, stale, remaining, samples: segment.length, measuredHours: hours,
    history: segment, projectedUsedPercent,
    pointsPerHour: rate, sustainablePointsPerDay: !stale && hoursLeft > 0 ? remaining / hoursLeft * 24 : null,
    exhaustionAt: exhaustion ? new Date(exhaustion).toISOString() : null,
    lastsUntilReset: rate === null ? null : rate === 0 || (exhaustion ?? Infinity) >= reset };
}

/** Seed a new reset window with recent completed-cycle pace, then yield to live evidence. */
export function quotaOutlook(samples: QuotaSample[], now = Date.now()) {
  const cycles = quotaCycles(samples, now);
  const active = [...cycles].reverse().find(cycle => !cycle.completed) ?? cycles.at(-1);
  if (!active) return null;
  const current = quotaPace(active.samples, now);
  if (!current) return null;

  const comparable = cycles
    .filter(cycle => cycle.key !== active.key && cycle.completed && cycle.pointsPerHour !== null)
    .slice(-8);
  const historicalRates = comparable.map(cycle => cycle.pointsPerHour!);
  const historicalPointsPerHour = weightedMedian(historicalRates);
  const currentPointsPerHour = current.pointsPerHour;
  const warmupHours = Math.min(6, Math.max(1, active.windowMinutes / 60 * 0.1));
  const liveWeight = currentPointsPerHour === null ? 0 : Math.min(1, current.measuredHours / warmupHours);

  let forecastSource: 'historical' | 'blended' | 'current_window' | 'stale' | 'unavailable';
  let effectiveRate: number | null;
  if (current.stale) {
    forecastSource = 'stale';
    effectiveRate = null;
  } else if (currentPointsPerHour === null && historicalPointsPerHour === null) {
    forecastSource = 'unavailable';
    effectiveRate = null;
  } else if (currentPointsPerHour === null) {
    forecastSource = 'historical';
    effectiveRate = historicalPointsPerHour;
  } else if (historicalPointsPerHour !== null && liveWeight < 1) {
    forecastSource = 'blended';
    effectiveRate = currentPointsPerHour * liveWeight + historicalPointsPerHour * (1 - liveWeight);
  } else {
    forecastSource = 'current_window';
    effectiveRate = currentPointsPerHour;
  }

  const observed = Date.parse(current.observed_at), reset = Date.parse(current.resets_at);
  const hoursLeft = (reset - observed) / HOUR;
  const projectedUsedPercent = effectiveRate === null ? null : current.used_percent + effectiveRate * hoursLeft;
  const exhaustion = effectiveRate !== null && effectiveRate > 0
    ? observed + current.remaining / effectiveRate * HOUR
    : null;
  return {
    ...current,
    cycles,
    completedCycles: cycles.filter(cycle => cycle.completed).length,
    comparableCycles: comparable.length,
    currentPointsPerHour,
    historicalPointsPerHour,
    historicalLowPointsPerHour: percentile(historicalRates, 0.25),
    historicalHighPointsPerHour: percentile(historicalRates, 0.75),
    liveWeight,
    forecastSource,
    pointsPerHour: effectiveRate,
    projectedUsedPercent,
    exhaustionAt: exhaustion ? new Date(exhaustion).toISOString() : null,
    lastsUntilReset: effectiveRate === null ? null : effectiveRate === 0 || (exhaustion ?? Infinity) >= reset,
  };
}

export function isSparkWindow(sample: Pick<QuotaSample, 'window_key' | 'label'>) {
  return /spark/i.test(`${sample.window_key} ${sample.label}`);
}

export function tokenPace(rows: { hour: string; total_tokens: number }[], now = Date.now()) {
  const end = Math.floor(now / HOUR) * HOUR;
  const sum = (hours: number) => rows.filter(r => Date.parse(r.hour) >= end - hours * HOUR && Date.parse(r.hour) < end)
    .reduce((n, r) => n + Number(r.total_tokens), 0);
  return { tokensLast24Hours: sum(24), tokensPerHour: sum(6) / 6, completeThrough: new Date(end).toISOString() };
}
