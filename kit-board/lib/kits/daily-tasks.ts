import type { KitManifest } from './types';

export const dailyTasksKit = {
  id: 'daily-tasks',
  title: 'Daily tasks',
  summary: 'A scheduled agent publishes the morning briefing, and on weekdays the standup, from mail, calendar and the work queue.',
  directory: 'kit-board',
  extracted: false,
  page: { path: '/tasks', empty: 'The next daily briefing and standup will appear here.' },
  reports: [
    { kind: 'tasks', contract: 'tasks-v1', enforcement: 'observe' },
    { kind: 'standup', contract: 'standup-v1', enforcement: 'observe' },
  ],
  producers: ['tasks', 'standup'],
  schedules: [
    { name: 'Daily personal assistant', kind: 'tasks', owner: 'Codex + Claude contributions', cadence: 'Every day · 9:00 AM. Standup: weekdays', source: 'daily-personal-assistant', connected: true },
  ],
  endpoints: [
    { method: 'POST', path: '/api/v1/reports/tasks', auth: 'producer', scope: 'tasks', contract: 'tasks-v1', summary: "Publishes one revision of the day's briefing." },
    { method: 'POST', path: '/api/v1/reports/standup', auth: 'producer', scope: 'standup', contract: 'standup-v1', summary: 'Publishes the final standup text.' },
  ],
  downloads: [
    { label: 'Publisher', path: 'kit-board/scripts/publish.mjs', summary: 'Zero-dependency client that wraps a payload in the envelope and posts it.' },
  ],
} as const satisfies KitManifest;
