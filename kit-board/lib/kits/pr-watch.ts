import type { KitManifest } from './types';

export const prWatchKit = {
  id: 'pr-watch',
  title: 'PR watch',
  summary: "A runner on the Mac polls the watched pull requests. On someone else's PR it starts a follow-up AI review when the author pushes a change to the diff; on the owner's own PR it works through new review comments and pushes the fixes.",
  directory: 'kit-pr-watch',
  extracted: true,
  page: { path: '/reviews', empty: 'Paste a pull request URL to start watching it.' },
  reports: [],
  producers: ['pr-watch'],
  schedules: [],
  endpoints: [
    { method: 'GET', path: '/api/v1/pr-watches', auth: 'producer', scope: 'pr-watch', returns: 'pr-watch-work-v1', summary: "The runner's tick: records the heartbeat and returns the work list." },
    { method: 'POST', path: '/api/v1/pr-watches/:id', auth: 'producer', scope: 'pr-watch', contract: 'pr-watch-report-v1', summary: 'What the runner saw on one watch, and what it did.' },
    { method: 'GET', path: '/api/pr-watches', auth: 'session', summary: 'One tab\'s queue on /reviews: `?kind=review` (Re-review, the default) or `?kind=address` (Address comments).' },
    { method: 'POST', path: '/api/pr-watches', auth: 'session', summary: 'Watches a pull request, for re-review or for its comments.' },
    { method: 'PATCH', path: '/api/pr-watches/:id', auth: 'session', summary: 'Stops a watch, or asks for a review or a pass over the comments on the next tick.' },
  ],
  downloads: [
    { label: 'Kit', path: 'kit-pr-watch', summary: 'The runner, its decision core, both contract copies, synthetic fixtures and their tests.' },
    { label: 'Runner', path: 'kit-pr-watch/pr-watch.mjs', summary: 'The launchd runner. It spends no tokens; it starts a review or an address session only when one is due.' },
    { label: 'Decision core', path: 'kit-pr-watch/pr-watch-core.mjs', summary: 'Every decision the runner makes, with no network access.' },
  ],
} as const satisfies KitManifest;
