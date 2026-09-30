import type { ReportKind } from './contracts';
import { checkReportContract, type ContractIssue } from './report-contracts';

/** A stored revision as `kitReads.recentReportBodies` reads it. */
export type StoredBody = {
  kind: string; schema_version: number; period_key: string; subject_key: string; idempotency_key: string; title: string;
  produced_at: Date | string; status: string; coverage: unknown; payload: unknown; html: string | null;
};

export type ContractStatus = {
  kind: Exclude<ReportKind, 'usage'>;
  checked: number;
  matched: number;
  /** Whether the newest revision matches, or null when none is stored. */
  latest: boolean | null;
  /** The most common issues, each counted once per revision that has it. */
  issues: { path: string; message: string; revisions: number }[];
};

/** The request body a stored revision was posted with, as far as its contract can tell. */
export function storedBody(row: StoredBody) {
  return {
    schema_version: row.schema_version, period_key: row.period_key, subject_key: row.subject_key, idempotency_key: row.idempotency_key,
    title: row.title, produced_at: new Date(row.produced_at).toISOString(), status: row.status, coverage: row.coverage, payload: row.payload,
    ...(row.html === null ? {} : { html: row.html }),
  };
}

/** An issue's place with array indexes folded, so the same drift in thirty items reads as one issue. */
export const issuePath = (path: ContractIssue['path']) =>
  path.reduce<string>((text, part) => typeof part === 'number' ? `${text}[]` : text ? `${text}.${part}` : part, '') || '(body)';

/** Checks each kind's stored revisions, newest first, against the kind's current contract. */
export function contractStatus(kind: Exclude<ReportKind, 'usage'>, rows: readonly StoredBody[], top = 5): ContractStatus {
  const results = rows.filter(row => row.kind === kind).map(row => checkReportContract(kind, storedBody(row)));
  const counts = new Map<string, { path: string; message: string; revisions: number }>();
  for (const result of results) {
    const seen = new Set<string>();
    for (const issue of result.issues) {
      const path = issuePath(issue.path);
      const key = `${path}\u0000${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { path, message: issue.message, revisions: 0 };
      entry.revisions += 1;
      counts.set(key, entry);
    }
  }
  return {
    kind,
    checked: results.length,
    matched: results.filter(result => result.valid).length,
    latest: results.length ? results[0].valid : null,
    issues: [...counts.values()].sort((a, b) => b.revisions - a.revisions || a.path.localeCompare(b.path)).slice(0, top),
  };
}
