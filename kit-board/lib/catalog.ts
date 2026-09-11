import type { ReportKind } from './contracts';
export const sections: { kind: ReportKind; title: string; path: string; empty: string }[] = [
  { kind: 'usage', title: 'AI usage', path: '/usage', empty: 'Monthly usage reports will appear after the first upload.' },
  { kind: 'tasks', title: 'Daily tasks', path: '/tasks', empty: 'The next merged daily briefing will appear here.' },
  { kind: 'standup', title: 'Standup', path: '/standup', empty: 'Your standup updates will appear here after publication.' },
  { kind: 'readings', title: 'Readings', path: '/readings', empty: 'Connect the Claude daily readings task to start this history.' },
  { kind: 'audit', title: 'Luumen AI audit', path: '/audit', empty: 'Published Luumen AI audit reports will appear here.' },
];
export const schedules = [
  { name: 'Monthly AI usage', kind: 'usage', owner: 'Codex + Claude · each computer', cadence: 'Codex: 1st · 9:00 AM. Claude catch-up: 2nd–5th · 9:15 AM', source: 'monthly-ai-usage', connected: true },
  { name: 'Daily personal assistant', kind: 'tasks', owner: 'Codex + Claude contributions', cadence: 'Every day · 9:00 AM', source: 'daily-personal-assistant', connected: true },
  { name: 'Daily standup', kind: 'standup', owner: 'Codex', cadence: 'Weekdays · 9:00 AM', source: 'daily-standup-update', connected: true },
  { name: 'Daily readings', kind: 'readings', owner: 'Claude cloud · copied by Codex', cadence: 'Every day · 10:00 AM. Publication checks: 12:15, 3:15, 6:15 PM', source: 'publish-claude-readings-to-personal-observatory', connected: true },
  { name: 'Luumen AI audit', kind: 'audit', owner: 'Codex', cadence: 'Tuesdays · 9:00 AM', source: 'weekly-luumen-ai-audit', connected: true },
];
