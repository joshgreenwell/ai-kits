import type { ResetItem } from './reset-feeds';

/** History uses the effective reset time when supplied; other entries use publication time. */
export function resetDay(item: ResetItem) {
  return new Date(item.category === 'history' ? item.effective_at ?? item.at : item.at).toISOString().slice(0, 10);
}

export function calendarDays(month: string): (string | null)[] {
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const cells = Math.ceil((offset + count) / 7) * 7;
  return Array.from({ length: cells }, (_, index) => index < offset || index >= offset + count ? null : `${month}-${String(index - offset + 1).padStart(2, '0')}`);
}

export function shiftMonth(month: string, delta: number) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}


export const resetTypes = [
  { value: 'global', label: 'Global reset' }, { value: 'banked', label: 'Banked reset' },
  { value: 'window_flush', label: 'Window flush' }, { value: 'reset', label: 'Other reset' },
  { value: 'announcement', label: 'Announced' },
  { value: 'signal', label: 'Watch / signal' }, { value: 'forecast', label: 'Forecast' },
  { value: 'credits', label: 'Credits' },
] as const;
export function resetKind(item: ResetItem) {
  return item.reset_kind ?? (item.category === 'forecast' ? 'forecast' : /banked/i.test(item.status) ? 'banked' : /global/i.test(item.scope ?? '') ? 'global' : 'reset');
}
/**
 * What an entry says happened, apart from whether it was reported, announced, or forecast. Each type
 * keeps one color and one glyph in the record, with the provider as the tile's border, and one shape in
 * the calendar, where each provider and type pair takes a shade of the provider's family
 * (components/reset-dot.tsx). Either way an announced Codex global reset and a reported one share a
 * color and differ only in how certain they look.
 */
export type ResetEventType = 'global' | 'banked' | 'window_flush' | 'reset' | 'credits' | 'signal' | 'forecast';
export const RESET_EVENT_TYPES: readonly ResetEventType[] = ['global', 'banked', 'window_flush', 'reset', 'credits', 'signal', 'forecast'];
export const RESET_EVENT_LABELS: Record<ResetEventType, string> = {
  global: 'Global reset', banked: 'Banked reset', window_flush: 'Window flush', reset: 'Other reset', credits: 'Credits', signal: 'Watch / signal', forecast: 'Forecast',
};
export function resetEventType(item: ResetItem): ResetEventType {
  const kind = resetKind(item);
  return kind === 'watch' ? 'signal' : kind;
}
/** The providers a reset feed can name, in the order the filter, the calendar, and the legend list them. */
export const RESET_PROVIDERS = ['claude', 'codex', 'cursor'] as const;
const RESET_PROVIDER_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
export function resetProviderLabel(provider: string) {
  return RESET_PROVIDER_LABELS[provider] ?? provider;
}
export function resetProviderOrder(provider: string) {
  const index = (RESET_PROVIDERS as readonly string[]).indexOf(provider);
  return index === -1 ? RESET_PROVIDERS.length : index;
}
/** Announced and forecast entries have not happened yet; they draw fainter than a reported one. */
export function resetPlanned(item: ResetItem) {
  return item.category !== 'history';
}
export function matchesResetType(item: ResetItem, filter: string) {
  if (filter === 'all') return true;
  if (filter === 'announcement') return item.category === 'announcement';
  if (filter === 'forecast') return item.category === 'forecast';
  if (filter === 'signal') return ['watch', 'signal'].includes(resetKind(item));
  return resetKind(item) === filter;
}
/** Keep an announcement and its later observation, even when they cite the same post. */
export function resetEntryKey(item: ResetItem) {
  const kind = resetKind(item);
  return [item.provider, item.url, kind === 'global' ? 'reset' : kind, item.category].join('|');
}
