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

export function isSparkWindow(sample: Pick<QuotaSample, 'window_key' | 'label'>) {
  return /spark/i.test(`${sample.window_key} ${sample.label}`);
}

export function tokenPace(rows: { hour: string; total_tokens: number }[], now = Date.now()) {
  const end = Math.floor(now / 3_600_000) * 3_600_000;
  const sum = (hours: number) => rows.filter(r => Date.parse(r.hour) >= end - hours * 3_600_000 && Date.parse(r.hour) < end)
    .reduce((n, r) => n + Number(r.total_tokens), 0);
  return { tokensLast24Hours: sum(24), tokensPerHour: sum(6) / 6, completeThrough: new Date(end).toISOString() };
}
