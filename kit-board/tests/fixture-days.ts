// Integration fixtures were written against fixed September 2026 dates. The allowance readings the dashboard serves
// are limited to the last 35 days (lib/usage-store.ts, lib/telemetry-store.ts), so a fixed date makes those tests
// fail once the calendar passes it. fixtureDay moves a fixture date forward by whole days so its day is two days
// before the day the process started, and leaves the time and the spelling after the date untouched.
const DAY_MS = 86_400_000;
const FIXTURE_DAY = Date.UTC(2026, 8, 2);
const started = new Date();
const TODAY = Date.UTC(started.getUTCFullYear(), started.getUTCMonth(), started.getUTCDate());
const SHIFT_DAYS = Math.round((TODAY - 2 * DAY_MS - FIXTURE_DAY) / DAY_MS);

export function fixtureDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) throw new Error(`fixtureDay expects an ISO date, got ${iso}`);
  const moved = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + SHIFT_DAYS * DAY_MS;
  return new Date(moved).toISOString().slice(0, 10) + iso.slice(10);
}

/** Applies fixtureDay to every ISO timestamp string in a parsed JSON fixture. */
export function shiftFixtureDates<T>(value: T): T {
  if (typeof value === 'string') return (/^\d{4}-\d{2}-\d{2}T/.test(value) ? fixtureDay(value) : value) as T;
  if (Array.isArray(value)) return value.map(shiftFixtureDates) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftFixtureDates(item)])) as T;
  return value;
}
