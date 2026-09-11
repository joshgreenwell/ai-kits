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
export function resetMarker(item: ResetItem) {
  const kind = resetKind(item);
  if (kind === 'banked' || kind === 'credits' || kind === 'window_flush') return kind;
  if (item.category === 'forecast') return 'forecast';
  if (kind === 'watch' || kind === 'signal') return 'signal';
  return item.category === 'announcement' ? 'announcement' : kind;
}
export function resetTypeLabel(item: ResetItem) {
  return resetTypes.find(type => type.value === resetKind(item))?.label ?? 'Watch / signal';
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
