import type { StoredReport } from './contracts';
import { defaultReport } from './report-selection';

export type DailyDay = { day: string; briefing: boolean; standup: boolean };
export type DailySelection = { days: DailyDay[]; day?: string; briefing?: StoredReport; standup?: StoredReport };

// The briefing and the standup describe the same working day, so one day picker selects both.
// A requested revision pins its own day and kind; the other kind follows that day's default.
export function dailySelection(briefings: StoredReport[], standups: StoredReport[], request: { day?: string; report?: string } = {}): DailySelection {
  const days = [...new Set([...briefings, ...standups].map(report => report.period_key))].sort().reverse()
    .map(day => ({ day, briefing: briefings.some(report => report.period_key === day), standup: standups.some(report => report.period_key === day) }));
  const pinned = request.report ? [...briefings, ...standups].find(report => report.id === request.report) : undefined;
  const day = pinned?.period_key ?? request.day ?? days[0]?.day;
  const pick = (kind: 'tasks' | 'standup', history: StoredReport[]) =>
    pinned?.kind === kind ? pinned : defaultReport(kind, history.filter(report => report.period_key === day));
  return { days, day, briefing: pick('tasks', briefings), standup: pick('standup', standups) };
}
