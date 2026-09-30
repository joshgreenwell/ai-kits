import type postgres from 'postgres';
import type { StoredBody } from './contract-status';

type Sql = ReturnType<typeof postgres>;
type DatabaseProvider = () => Sql;
export type CollectorSource = { id: string; machine_label: string; mode: string; disabled: boolean; last_seen_at: Date | null; label: string };

/** The reads behind /kits, with an injectable database provider so they run against a disposable Postgres in tests. */
export function createKitReads(getDatabase?: DatabaseProvider) {
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();
  return {
    /**
     * The newest revisions of each non-usage kind, with the body fields its contract reads, so /kits can
     * check what producers actually send. HTML is replaced by a stand-in: the envelope capped its size on
     * the way in, and only whether it is present or empty matters to a contract.
     */
    async recentReportBodies(perKind = 20) {
      const db = await sql();
      return db<StoredBody[]>`SELECT kind, schema_version, period_key, subject_key, idempotency_key, title, produced_at, status, coverage, payload,
        CASE WHEN html IS NULL THEN NULL WHEN octet_length(html) = 0 THEN '' ELSE '<html>' END AS html
        FROM (SELECT kind, schema_version, period_key, subject_key, idempotency_key, title, produced_at, received_at, status, coverage, payload, html,
            row_number() OVER (PARTITION BY kind ORDER BY produced_at DESC, received_at DESC) AS position
          FROM personal_hub.report_revisions WHERE kind != 'usage') recent
        WHERE position <= ${perKind} ORDER BY kind, produced_at DESC, received_at DESC`;
    },
    /** Each telemetry source with its account, for the usage kit's collectors table. */
    async collectorSources() {
      const db = await sql();
      return db<CollectorSource[]>`SELECT s.id, s.machine_label, s.mode, s.disabled, s.last_seen_at, a.label
        FROM personal_hub.telemetry_sources s JOIN personal_hub.usage_accounts a ON a.id = s.account_id ORDER BY s.created_at`;
    },
  };
}

export const kitReads = createKitReads();
