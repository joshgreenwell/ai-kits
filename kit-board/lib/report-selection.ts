import type { ReportKind, StoredReport } from './contracts';

// A detailed assessment is the audit's primary reading experience. Later
// condensed reconciliations remain accessible without displacing that report.
export function defaultReport(kind: ReportKind, history: StoredReport[]) {
  const available = history.filter(report => report.status !== 'failed');
  if (kind === 'audit') {
    const full = available.find(report => report.coverage.presentation === 'full-audit');
    if (full) return full;
  }
  return available[0] ?? history[0];
}
