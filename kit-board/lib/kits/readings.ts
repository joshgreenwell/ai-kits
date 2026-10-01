import type { KitManifest } from './types';

export const readingsKit = {
  id: 'readings',
  title: 'Readings',
  summary: 'A scheduled agent publishes the daily tech, AI and crypto readings as markdown, and the board draws the page from it.',
  directory: 'kit-readings',
  extracted: true,
  page: { path: '/readings', empty: 'Connect the Claude daily readings task to start this history.' },
  reports: [{ kind: 'readings', contract: 'readings-v1', enforcement: 'observe' }],
  producers: ['readings'],
  schedules: [
    { name: 'Daily readings', kind: 'readings', owner: 'Claude · this Mac', cadence: 'Every day · 9:00 AM', source: 'daily-tech-intel-snapshot', connected: true },
  ],
  endpoints: [
    { method: 'POST', path: '/api/v1/reports/readings', auth: 'producer', scope: 'readings', contract: 'readings-v1', summary: "Publishes one edition of the day's readings." },
    { method: 'POST', path: '/api/v1/reports/readings/validate', auth: 'producer-or-session', scope: 'readings', contract: 'readings-v1', summary: 'Checks an edition as publishing would, and stores nothing.' },
  ],
  downloads: [
    { label: 'Kit', path: 'kit-readings', summary: 'Schedule template, contract copy, synthetic fixtures and their tests.' },
    { label: 'Schedule template', path: 'kit-readings/schedule/daily-tech-intel-snapshot.md', summary: 'What the daily readings task writes, and how it checks and publishes it.' },
    { label: 'Publisher', path: 'kit-board/scripts/publish.mjs', summary: 'Zero-dependency client that wraps a payload in the envelope and posts it.' },
  ],
} as const satisfies KitManifest;
