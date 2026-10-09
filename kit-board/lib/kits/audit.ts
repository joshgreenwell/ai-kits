import type { KitManifest } from './types';

export const auditKit = {
  id: 'audit',
  title: 'AI audit',
  summary: 'A weekly agent publishes the AI audit as an HTML report, with its linked evidence files uploaded beside it.',
  directory: 'kit-board',
  extracted: false,
  page: { path: '/audit', empty: 'Published AI audit reports will appear here.' },
  reports: [{ kind: 'audit', contract: 'audit-v1', enforcement: 'observe' }],
  producers: ['audit'],
  schedules: [
    { name: 'AI audit', kind: 'audit', owner: 'Codex', cadence: 'Tuesdays · 9:00 AM', source: 'weekly-ai-audit', connected: true },
  ],
  endpoints: [
    { method: 'POST', path: '/api/v1/reports/audit', auth: 'producer', scope: 'audit', contract: 'audit-v1', summary: 'Publishes one audit report.' },
    { method: 'POST', path: '/api/v1/reports/audit/validate', auth: 'producer-or-session', scope: 'audit', contract: 'audit-v1', summary: 'Checks an audit report as publishing would, and stores nothing.' },
    { method: 'POST', path: '/api/v1/reports/audit/:id/assets', auth: 'producer', scope: 'audit', summary: 'Uploads one linked evidence file for a report this producer published.' },
  ],
  downloads: [
    { label: 'Publisher', path: 'kit-board/scripts/publish.mjs', summary: 'Zero-dependency client that wraps a payload in the envelope and posts it.' },
    { label: 'Evidence uploader', path: 'kit-board/scripts/publish-assets.mjs', summary: "Uploads the files a published report links to." },
  ],
} as const satisfies KitManifest;
