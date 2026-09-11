import 'server-only';
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { RequestError, stableJson, type ReportInput, type ReportKind, type StoredReport } from './contracts';
import { DatabaseQueue } from './database-queue';
import { readCache } from './read-cache';

function createDatabase() {
  let client: ReturnType<typeof postgres> | undefined;
  const current = () => client ??= postgres(process.env.DATABASE_URL!, {
    prepare: false, max: 1, idle_timeout: 5, connect_timeout: 3, max_lifetime: 60,
    ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n') },
  });
  const queue = new DatabaseQueue(async () => {
    const failed = client; client = undefined;
    // Destroy the stalled connection before the next job. Do not retry writes:
    // a timed-out write may have committed and must use its idempotency receipt.
    if (failed) await failed.end({ timeout: 0 }).catch(() => {});
  });
  // Keep postgres's parameterization and JSON/INSERT helpers. Only execution is
  // gated; a whole transaction owns the gate, including COMMIT or ROLLBACK.
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (Array.isArray(first) && 'raw' in first) return queue.run(() => Reflect.apply(current(), undefined, [first, ...values]));
    return Reflect.apply(current(), undefined, [first, ...values]);
  }) as ReturnType<typeof postgres>;
  sql.json = (...args) => current().json(...args);
  sql.begin = ((...args: Parameters<ReturnType<typeof postgres>['begin']>) => queue.run(() => Reflect.apply(current().begin, undefined, args))) as typeof sql.begin;
  sql.end = options => queue.run(async () => { const old = client; client = undefined; if (old) await old.end(options); });
  return sql;
}
const scope = globalThis as typeof globalThis & { personalHubDatabaseV2?: ReturnType<typeof postgres> };
export function database() {
  if (!process.env.DATABASE_URL) throw new RequestError('The report database is not connected yet', 503);
  // Survives dev reloads, and shares one bounded client across route modules.
  return scope.personalHubDatabaseV2 ??= createDatabase();
}

export async function storeReport(kind: ReportKind, producer: string, report: ReportInput) {
  const sql = database();
  const hash = createHash('sha256').update(stableJson(report)).digest('hex');
  const rows = await sql`
    INSERT INTO personal_hub.report_revisions
      (id, kind, period_key, subject_key, producer_id, idempotency_key, title, produced_at, status, schema_version, coverage, payload, html, content_hash)
    VALUES (${randomUUID()}, ${kind}, ${report.period_key}, ${report.subject_key}, ${producer}, ${report.idempotency_key},
      ${report.title}, ${report.produced_at}, ${report.status}, ${report.schema_version}, ${sql.json(report.coverage as postgres.JSONValue)},
      ${sql.json(report.payload as postgres.JSONValue)}, ${report.html ?? null}, ${hash})
    ON CONFLICT (producer_id, kind, idempotency_key) DO NOTHING
    RETURNING id, content_hash`;
  if (rows.length) { if (kind === 'usage') monthlyUsageCache.invalidate(); return { id: rows[0].id as string, duplicate: false }; }
  const existing = await sql`SELECT id, content_hash FROM personal_hub.report_revisions WHERE producer_id = ${producer} AND kind = ${kind} AND idempotency_key = ${report.idempotency_key}`;
  if (existing[0]?.content_hash !== hash) throw new RequestError('This idempotency key already names different content; use a new revision key', 409);
  return { id: existing[0].id as string, duplicate: true };
}

export async function reportHistory(kind: ReportKind): Promise<StoredReport[]> {
  const rows = await database()`SELECT id, kind, period_key, subject_key, producer_id, idempotency_key, title, produced_at, received_at, status, schema_version, coverage, content_hash,
    (html IS NOT NULL) AS has_html FROM personal_hub.report_revisions WHERE kind = ${kind} ORDER BY produced_at DESC, received_at DESC LIMIT 200`;
  return JSON.parse(JSON.stringify(rows)) as StoredReport[];
}

export async function reportById(id: string): Promise<StoredReport | undefined> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return;
  const rows = await database()`SELECT * FROM personal_hub.report_revisions WHERE id = ${id}`;
  return rows[0] ? JSON.parse(JSON.stringify(rows[0])) as StoredReport : undefined;
}

const monthlyUsageCache = readCache(60_000, async () => {
  return database()`SELECT DISTINCT ON (period_key, subject_key) payload FROM personal_hub.report_revisions
    WHERE kind = 'usage' AND status != 'failed' ORDER BY period_key DESC, subject_key, produced_at DESC, received_at DESC`;
});
export const usageReports = () => monthlyUsageCache.get();

export async function latestByKind() {
  return database()`SELECT DISTINCT ON (kind) id, kind, title, status, produced_at, received_at, period_key, producer_id
    FROM personal_hub.report_revisions ORDER BY kind, produced_at DESC, received_at DESC`;
}

// Shared database buckets continue to work across Vercel instances and deployments.
export async function consumeLoginAttempt(bucket: string, maximum: number) {
  const rows = await database()`INSERT INTO personal_hub.login_limits (bucket, attempts, expires_at)
    VALUES (${bucket}, 1, now() + interval '15 minutes')
    ON CONFLICT(bucket) DO UPDATE SET
      attempts = CASE WHEN login_limits.expires_at < now() THEN 1 ELSE login_limits.attempts + 1 END,
      expires_at = CASE WHEN login_limits.expires_at < now() THEN now() + interval '15 minutes' ELSE login_limits.expires_at END
    RETURNING attempts`;
  return Number(rows[0].attempts) <= maximum;
}
