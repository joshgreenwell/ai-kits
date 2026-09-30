import type { KitManifest } from './types';

export const prWatchKit = {
  id: 'pr-watch',
  title: 'PR watch',
  summary: 'A runner on the Mac polls the watched pull requests and starts a follow-up AI review when the author pushes a change to the diff.',
  directory: 'kit-board',
  extracted: false,
  page: { path: '/reviews', empty: 'Paste a pull request URL to start watching it.' },
  reports: [],
  producers: ['pr-watch'],
  schedules: [],
  endpoints: [
    { method: 'GET', path: '/api/v1/pr-watches', auth: 'producer', scope: 'pr-watch', summary: "The runner's tick: records the heartbeat and returns the work list." },
    { method: 'POST', path: '/api/v1/pr-watches/:id', auth: 'producer', scope: 'pr-watch', summary: 'What the runner saw on one watch, and what it did.' },
    { method: 'GET', path: '/api/pr-watches', auth: 'session', summary: 'The queue for /reviews.' },
    { method: 'POST', path: '/api/pr-watches', auth: 'session', summary: 'Watches a pull request.' },
    { method: 'PATCH', path: '/api/pr-watches/:id', auth: 'session', summary: 'Stops a watch, or asks for a review on the next tick.' },
  ],
  downloads: [
    { label: 'Runner', path: 'kit-board/scripts/pr-watch.mjs', summary: 'The launchd runner. It spends no tokens; it starts a review session only when one is due.' },
    { label: 'Decision core', path: 'kit-board/scripts/pr-watch-core.mjs', summary: 'Every decision the runner makes, with no network access.' },
  ],
} as const satisfies KitManifest;
