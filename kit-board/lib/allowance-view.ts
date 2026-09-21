import { DEFAULT_CADENCE_MINUTES } from './allowance-freshness';
import { meterLabel } from './allowance-meters';
import { isSparkWindow, quotaCycles, quotaOutlook, type HistoricalQuotaSample, type QuotaCycle } from './telemetry-contract';

/**
 * Client-safe view logic for the Allowances page (USG-023): the accordion's accounts and windows
 * derived from the live readings, the outlook state each window is in, the persisted preferences
 * (expanded accounts, Spark visibility, history range), and the account selection carried from
 * Tokens. Every current figure comes from the newest live reading of its own window; the history
 * range narrows the charts and never the meaning of current capacity.
 */
export type LiveAccount = { id: string; label: string; provider: string };
export type LiveSource = { id: string; account_id: string; machine_label: string; mode: string; disabled: boolean; last_seen_at: string | null; cadence_minutes?: number };
export type LiveQuota = HistoricalQuotaSample & { id: string; account_id: string; origin?: string; reader?: string; basis?: string; source_id?: string | null };
export type Outlook = NonNullable<ReturnType<typeof quotaOutlook>>;

export const HISTORY_RANGES = [7, 14, 30] as const;
export type HistoryDays = typeof HISTORY_RANGES[number];
export const DEFAULT_HISTORY_DAYS: HistoryDays = 30;
const DAY = 86_400_000;

/** The state a window's outlook is in, following the burn-rate note's table; `history_only` and `expired` come from USG-011's readings. */
export type OutlookState = 'measured' | 'blended' | 'historical' | 'learning' | 'stale' | 'expired' | 'history_only';
export const OUTLOOK_LABELS: Record<OutlookState, string> = {
  measured: 'current pace', blended: 'blended forecast', historical: 'historical seed', learning: 'learning pace', stale: 'stale reading', expired: 'awaiting new window', history_only: 'history only',
};

export type WindowView = {
  key: string; title: string; label: string; windowMinutes: number; spark: boolean; scoped: boolean;
  /** The outlook from live readings, or null when only history-only rows exist. */
  pace: Outlook | null; state: OutlookState;
  /** Every reading of this window in the history range, live and history-only, for the charts. */
  history: LiveQuota[]; cycles: QuotaCycle<LiveQuota>[];
  latestObservation: string | null; latestReader: string | null; cadenceMinutes: number;
  /** Rows from a disabled source, binding, or install, never current. */
  historyOnlyRows: number;
};
export type AccountView = { account: LiveAccount; windows: WindowView[]; visible: WindowView[]; hiddenSpark: number; latestObservation: string | null; alerts: string[] };

const WINDOW_ORDER = (w: WindowView) => (w.spark ? 3 : w.scoped ? 2 : w.windowMinutes < 1440 ? 0 : 1);

export function outlookState(pace: Outlook | null, historyOnly: boolean): OutlookState {
  if (!pace) return 'history_only';
  if (pace.stale) return pace.staleReason === 'expired' ? 'expired' : 'stale';
  if (pace.forecastSource === 'current_window') return 'measured';
  if (pace.forecastSource === 'blended') return 'blended';
  if (pace.forecastSource === 'historical') return 'historical';
  return historyOnly ? 'history_only' : 'learning';
}

/** One view per account with its windows, each forecast independently from its own readings and reset boundary. */
export function accountViews({ accounts, sources, quotas, now, historyDays = DEFAULT_HISTORY_DAYS, showSpark, alerts = {} }: {
  accounts: LiveAccount[]; sources: LiveSource[]; quotas: LiveQuota[]; now: number; historyDays?: HistoryDays; showSpark: boolean; alerts?: Record<string, string[]>;
}): AccountView[] {
  const cadenceBySource = new Map(sources.map(s => [s.id, s.cadence_minutes ?? DEFAULT_CADENCE_MINUTES]));
  const since = now - historyDays * DAY;
  return accounts.map(account => {
    const rows = quotas.filter(q => q.account_id === account.id);
    const windows = [...new Set(rows.map(q => q.window_key))].map(key => {
      const all = rows.filter(q => q.window_key === key).sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
      // The current reading is the newest live reading whatever the history range; the charts take the range.
      const live = all.filter(q => !q.history_only);
      const newest = live.at(-1) ?? all.at(-1)!;
      const cadence = (newest.source_id && cadenceBySource.get(newest.source_id)) || DEFAULT_CADENCE_MINUTES;
      const pace = quotaOutlook(all, now, cadence);
      // The active cycle stays whole on the chart whatever the range, jittered reset estimates included.
      const activeIds = new Set(pace ? quotaCycles(all, now).find(c => c.samples.some(s => s.id === newest.id))?.samples.map(s => s.id) : []);
      const inRange = all.filter(q => Date.parse(q.observed_at) >= since || activeIds.has(q.id));
      const historyOnly = live.length === 0;
      return {
        key, title: meterLabel(key, newest.label), label: newest.label, windowMinutes: newest.window_minutes, spark: isSparkWindow(newest), scoped: key.startsWith('seven_day_'),
        pace, state: outlookState(pace, historyOnly), history: inRange, cycles: quotaCycles(inRange, now),
        latestObservation: (live.at(-1) ?? all.at(-1))?.observed_at ?? null, latestReader: newest.reader ?? null, cadenceMinutes: cadence,
        historyOnlyRows: all.length - live.length,
      } satisfies WindowView;
    }).sort((a, b) => WINDOW_ORDER(a) - WINDOW_ORDER(b) || a.windowMinutes - b.windowMinutes || a.title.localeCompare(b.title));
    const visible = windows.filter(w => showSpark || !w.spark);
    // The header's time is the newest reading behind a current figure; a history-only account falls back to its newest history.
    const newest = (rows: (string | null)[]) => rows.filter((v): v is string => !!v).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const latestObservation = newest(windows.map(w => w.pace?.observed_at ?? null)) ?? newest(windows.map(w => w.latestObservation));
    return { account, windows, visible, hiddenSpark: windows.length - visible.length, latestObservation, alerts: alerts[account.id] ?? [] };
  });
}

/** Accounts carried from the Tokens URL: `accounts` and `providers` narrow the list; every other Tokens filter is ignored here. */
export function carriedAccounts(params: URLSearchParams, accounts: LiveAccount[]) {
  const wanted = new Set(params.getAll('accounts').flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean));
  const providers = new Set(params.getAll('providers').flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean));
  return accounts.filter(a => (!wanted.size || wanted.has(a.id)) && (!providers.size || providers.has(a.provider)));
}

export type AllowancePreferences = { expanded: string[] | null; showSpark: boolean; historyDays: HistoryDays };
export const PREFERENCE_KEY = 'observatory.allowances.v1';
export const DEFAULT_PREFERENCES: AllowancePreferences = { expanded: null, showSpark: false, historyDays: DEFAULT_HISTORY_DAYS };

/** Tolerant parse of the stored preferences; anything unrecognized falls back to the default. */
export function parsePreferences(raw: string | null): AllowancePreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Partial<AllowancePreferences>;
    const expanded = Array.isArray(value.expanded) ? value.expanded.filter((v): v is string => typeof v === 'string') : null;
    const historyDays = (HISTORY_RANGES as readonly number[]).includes(value.historyDays as number) ? value.historyDays as HistoryDays : DEFAULT_HISTORY_DAYS;
    return { expanded, showSpark: value.showSpark === true, historyDays };
  } catch { return DEFAULT_PREFERENCES; }
}

/** Expanded accounts start with the first one open; a remembered list is kept only for accounts that still exist. */
export function expandedAccounts(preferences: AllowancePreferences, accounts: LiveAccount[]) {
  const ids = accounts.map(a => a.id);
  if (preferences.expanded === null) return ids.slice(0, 1);
  return preferences.expanded.filter(id => ids.includes(id));
}

/** The list to remember after a toggle: the shown accounts as toggled, plus the remembered state of accounts not currently shown. */
export function rememberExpanded(preferences: AllowancePreferences, all: LiveAccount[], shown: LiveAccount[], ids: string[]) {
  const shownIds = new Set(shown.map(a => a.id));
  return [...ids, ...expandedAccounts(preferences, all).filter(id => !shownIds.has(id))];
}

export const countdownLabel = (resetsAt: string, now: number) => {
  const delta = Date.parse(resetsAt) - now;
  if (delta <= 0) return 'awaiting new window';
  const minutes = Math.max(1, Math.round(delta / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes % 60}m`;
};

/** The reading's own unit stays: every window today is percent used, so the remaining figure is percentage points. */
export const remainingLabel = (pace: Outlook | null) => (pace ? `${pace.remaining.toFixed(1)}% left` : 'no current reading');

/*
 * What the meters draw. A meter is a gauge of capacity, so it reads what is LEFT: a fresh window is a
 * full bar and the fill retreats as the allowance is spent. The contract underneath never flips —
 * `used_percent`, `projectedUsedPercent`, `pointsPerHour` and `usedPoints` stay in consumption space,
 * because that is what the providers report and what the ledgers store. These three derivations are
 * the only translation - the drawn level, the forecast end point, and one raw reading - shared by the
 * summary bar, the detail stat, and the burn chart so the figure above a meter and the figure inside
 * it can never disagree.
 */

/**
 * The level the summary bar draws: remaining percentage points, clamped into the meter's own 0..100
 * scale (a window with no current reading draws nothing, so 0 is only ever an exhausted allowance)
 * and rounded once, so the CSS width and `aria-valuenow` carry the same figure without a float tail.
 */
export const meterRemaining = (pace: Outlook | null) => (pace ? Math.max(0, Math.min(100, Math.round(pace.remaining * 10) / 10)) : 0);

/**
 * What is left when the window resets, deliberately unclamped: below zero is demand beyond the
 * allowance, and that real figure is what drives the warning colour, the "short by reset" wording,
 * and the chart's floor. Only the drawn width is ever clamped.
 */
export const projectedRemaining = (pace: Outlook | null) => (pace && pace.projectedUsedPercent !== null ? 100 - pace.projectedUsedPercent : null);

/**
 * One raw reading's level. A provider reports percent used and the burn chart plots percent left, so
 * every sample on every line - the active cycle, the faint completed ones, the tooltip and the
 * mirror - passes through here rather than inverting by hand at each call site.
 */
export const sampleRemaining = (usedPercent: number) => 100 - usedPercent;
