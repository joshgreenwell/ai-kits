/**
 * Period arithmetic for the usage query layer (USG-012). Every selected range is half-open
 * `[start, end)` in instants; presets are resolved at local boundaries of one display zone,
 * America/Chicago initially (metric contract, section 5). Daylight-saving days keep their real
 * 23- or 25-hour length: boundaries come from the zone's own wall clock, never from adding
 * twenty-four hours.
 */
import { RequestError } from './contracts';

export const DISPLAY_TIMEZONE = 'America/Chicago';
export const PRESETS = ['today', 'last_7_days', 'last_30_days', 'month_to_date', 'previous_month', 'custom'] as const;
export type Preset = typeof PRESETS[number];
export const RESOLUTIONS = ['day', 'hour'] as const;
export type Resolution = typeof RESOLUTIONS[number];
/** The longest selectable range, and the longest range the hourly series serves. */
export const MAX_RANGE_DAYS = 400;
export const MAX_HOURLY_RANGE_DAYS = 14;
export const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, value);
  }
  return value;
}

export function isSupportedTimeZone(timeZone: string) {
  try { formatter(timeZone); return true; } catch { return false; }
}

export type WallClock = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The zone's wall-clock reading of an instant. */
export function wallClock(instant: number, timeZone: string): WallClock {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour === 24 ? 0 : parts.hour, minute: parts.minute, second: parts.second };
}

const asUtc = (w: WallClock) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** Zone offset at an instant, in milliseconds east of UTC. */
export function zoneOffset(instant: number, timeZone: string) {
  return asUtc(wallClock(instant, timeZone)) - instant;
}

/**
 * The instant at which the zone's wall clock reads the given date and hour. Inside a fall-back
 * overlap the earlier occurrence is returned; inside a spring-forward gap the instant after the gap.
 */
export function zonedInstant(year: number, month: number, day: number, timeZone: string, hour = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  const first = wall - zoneOffset(wall, timeZone);
  const second = wall - zoneOffset(first, timeZone);
  const matches = (candidate: number) => asUtc(wallClock(candidate, timeZone)) === wall;
  const candidates = [first, second].filter(matches);
  if (candidates.length) return Math.min(...candidates);
  // A wall time inside a gap: the offsets before and after disagree; take the later offset's reading.
  return Math.max(first, second);
}

export function localDayStart(instant: number, timeZone: string) {
  const w = wallClock(instant, timeZone);
  return zonedInstant(w.year, w.month, w.day, timeZone);
}

export function addLocalDays(dayStart: number, days: number, timeZone: string) {
  const w = wallClock(dayStart, timeZone);
  const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return zonedInstant(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

export function localMonthStart(instant: number, timeZone: string, monthOffset = 0) {
  const w = wallClock(instant, timeZone);
  const shifted = new Date(Date.UTC(w.year, w.month - 1 + monthOffset, 1));
  return zonedInstant(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1, timeZone);
}

/** `YYYY-MM` of an instant in the zone. */
export function localMonthKey(instant: number, timeZone: string) {
  const w = wallClock(instant, timeZone);
  return `${w.year}-${String(w.month).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` of an instant in the zone. */
export function localDateKey(instant: number, timeZone: string) {
  const w = wallClock(instant, timeZone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export type ResolvedRange = {
  preset: Preset; start: number; end: number; timezone: string;
  /** The range ends at the query instant, so the newest interval is still being observed. */
  anchored_to_now: boolean;
};

const iso = (value: string) => {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new RequestError('Invalid range instant');
  return instant;
};

/** Presets resolve at local boundaries; a custom range is taken as given, half-open and bounded. */
export function resolveRange({ preset, start, end, timezone = DISPLAY_TIMEZONE, now = Date.now() }: {
  preset: Preset; start?: string | null; end?: string | null; timezone?: string; now?: number;
}): ResolvedRange {
  if (!isSupportedTimeZone(timezone)) throw new RequestError('Unsupported time zone');
  const today = localDayStart(now, timezone);
  let range: { start: number; end: number };
  switch (preset) {
    case 'today': range = { start: today, end: now }; break;
    case 'last_7_days': range = { start: addLocalDays(today, -6, timezone), end: now }; break;
    case 'last_30_days': range = { start: addLocalDays(today, -29, timezone), end: now }; break;
    case 'month_to_date': range = { start: localMonthStart(now, timezone), end: now }; break;
    case 'previous_month': range = { start: localMonthStart(now, timezone, -1), end: localMonthStart(now, timezone) }; break;
    case 'custom': {
      if (!start || !end) throw new RequestError('A custom range needs start and end');
      range = { start: iso(start), end: Math.min(iso(end), now) };
      if (range.end <= range.start) throw new RequestError('The range end must be after its start');
      break;
    }
  }
  if (range.end - range.start > MAX_RANGE_DAYS * DAY) throw new RequestError(`The range may span at most ${MAX_RANGE_DAYS} days`);
  return { preset, ...range, timezone, anchored_to_now: range.end >= now };
}

export type Period = { start: number; end: number; /** The aligned interval start, the key rows group under. */ aligned: number; /** The aligned interval extends past the range on one side. */ clipped: boolean };

/** Aligned local intervals intersecting the range, clipped to it. Bounded by the range limits above. */
export function periodsWithin(range: { start: number; end: number }, resolution: Resolution, timezone: string): Period[] {
  if (resolution === 'hour' && range.end - range.start > MAX_HOURLY_RANGE_DAYS * DAY) {
    throw new RequestError(`Hourly resolution is available for ranges up to ${MAX_HOURLY_RANGE_DAYS} days`);
  }
  const periods: Period[] = [];
  let cursor = resolution === 'day' ? localDayStart(range.start, timezone) : Math.floor(range.start / HOUR) * HOUR;
  while (cursor < range.end) {
    const next = resolution === 'day' ? addLocalDays(cursor, 1, timezone) : cursor + HOUR;
    periods.push({ start: Math.max(cursor, range.start), end: Math.min(next, range.end), aligned: cursor, clipped: cursor < range.start || next > range.end });
    cursor = next;
  }
  return periods;
}

/** `YYYY-MM` keys of the local months a range touches, oldest first. */
export function monthsWithin(range: { start: number; end: number }, timezone: string) {
  const months: string[] = [];
  let cursor = localMonthStart(range.start, timezone);
  while (cursor < range.end) {
    months.push(localMonthKey(cursor, timezone));
    cursor = localMonthStart(cursor, timezone, 1);
  }
  return months;
}

/** The instants a local month spans in the zone. */
export function monthBounds(monthKey: string, timeZone: string) {
  const [year, month] = monthKey.split('-').map(Number);
  const start = zonedInstant(year, month, 1, timeZone);
  return { start, end: localMonthStart(start, timeZone, 1) };
}
