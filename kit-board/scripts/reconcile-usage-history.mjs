#!/usr/bin/env node
// Historical usage reconciliation (USG-011). Read-only unless `--apply` is given.
//
//   node --env-file=.env.local --import tsx scripts/reconcile-usage-history.mjs report [--since=YYYY-MM-DD] [--json]
//   node --env-file=.env.local --import tsx scripts/reconcile-usage-history.mjs outbox <source-id> <state.sqlite3 | envelope.json>... [--apply] [--json]
//
// `report` prints the before/after matrix: hourly keys by account, month, and model (v1-only, v2-only,
// shared, canonical totals with and without the retired rows), allowance observations by account and
// meter (history-only rows, cross-ledger duplicates, visibility under the old and new policy), and the
// retained monthly envelopes. `outbox` classifies a retired collector's pending v1 envelopes against
// the ledgers under the given source id (its explicit mapping) and applies them only with `--apply`,
// keeping each envelope's own observation time. The database URL comes from DATABASE_URL, the CA from
// DATABASE_CA_CERT; the script prints no credential and never touches collector contact.
import { readFile, stat } from 'node:fs/promises';
import postgres from 'postgres';
import { createUsageReconciliation } from '../lib/usage-reconciliation.ts';

const [command, ...rest] = process.argv.slice(2);
const flags = new Map(rest.filter(arg => arg.startsWith('--')).map(arg => { const [key, value = 'true'] = arg.slice(2).split('='); return [key, value]; }));
const positional = rest.filter(arg => !arg.startsWith('--'));
const json = flags.get('json') === 'true';
const usage = () => { console.error('Usage: reconcile-usage-history.mjs report [--since=YYYY-MM-DD] [--json] | outbox <source-id> <file>... [--apply] [--json]'); process.exit(2); };
if (!['report', 'outbox'].includes(command ?? '')) usage();
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set; run with `node --env-file=.env.local ...` or export it.'); process.exit(2); }

const sql = postgres(process.env.DATABASE_URL, {
  prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10,
  ssl: process.env.DATABASE_CA_CERT ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, '\n') } : undefined,
});
const reconciliation = createUsageReconciliation(() => sql);
const n = value => new Intl.NumberFormat('en-US').format(value);

// Envelopes are labeled by file order and content hash prefix; the path itself is never printed.
async function readEnvelopes(path, fileIndex) {
  await stat(path);   // never let the sqlite driver create a missing state file
  if (path.endsWith('.sqlite3') || path.endsWith('.db')) {
    // The retired collector keeps its pending bodies in the `outbox` table of its state file, oldest first.
    const { DatabaseSync } = await import('node:sqlite');
    let db;
    try { db = new DatabaseSync(path, { readOnly: true }); } catch { db = new DatabaseSync(path); }
    try {
      return db.prepare('SELECT hash, payload FROM outbox ORDER BY rowid').all().map((row, index) => ({ label: `file ${fileIndex + 1} envelope ${index + 1} (${String(row.hash).slice(0, 8)})`, body: JSON.parse(String(row.payload)) }));
    } finally { db.close(); }
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return (Array.isArray(parsed) ? parsed : [parsed]).map((body, index) => ({ label: `file ${fileIndex + 1} envelope ${index + 1}`, body }));
}

try {
  if (command === 'report') {
    const report = await reconciliation.report({ since: flags.get('since') ?? null });
    if (json) { console.log(JSON.stringify(report, null, 2)); }
    else {
      const t = report.hourly.totals;
      console.log(`Reconciliation as of ${report.as_of}${report.since ? ` since ${report.since}` : ''}`);
      console.log(`\nHourly keys: v1-only ${n(t.v1_only_keys)} (${n(t.v1_only_in_v2_hours)} inside companion-observed hours), v2-only ${n(t.v2_only_keys)}, shared ${n(t.shared_keys)}`);
      console.log(`Canonical: ${n(t.canonical_calls)} calls / ${n(t.canonical_tokens)} tokens; without v1 rows: ${n(t.without_v1_calls)} calls / ${n(t.without_v1_tokens)} tokens`);
      for (const row of report.hourly.rows) {
        console.log(`  ${row.account_id} ${row.period} ${row.model}: keys v1-only ${row.keys.v1_only} (${row.keys.v1_only_in_v2_hours} in v2 hours) · v2-only ${row.keys.v2_only} · shared ${row.keys.shared}`
          + ` (= ${row.keys.shared_equal}, v2> ${row.keys.shared_v2_larger}, v1> ${row.keys.shared_v1_larger}); canonical ${n(row.canonical.calls)} calls / ${n(row.canonical.tokens)} tokens`
          + ` (${n(row.canonical.tokens_from_v1_rows)} from v1 rows); without v1 ${n(row.without_v1.tokens)} tokens; v1-only ${n(row.v1_only.tokens)} tokens`);
      }
      console.log('\nAllowance observations:');
      for (const row of report.allowances.rows) {
        console.log(`  ${row.account_id} ${row.meter_key} ${row.origin}/${row.reader}: ${row.rows} rows, ${row.history_only_rows} history-only, ${row.cross_ledger_duplicates} duplicated by v2,`
          + ` visible before ${row.visible_before} → after ${row.visible_after}; observed ${row.observed.first} … ${row.observed.last}`);
      }
      console.log('\nCurrent selection per meter:');
      for (const row of report.allowances.current) {
        console.log(`  ${row.account_id} ${row.meter_key}: current ${row.current_observed_at ?? 'none (history only)'}; newest any ${row.newest_any_observed_at}${row.revived_prevented ? ' (a disabled producer is newer: not revived)' : ''}`);
      }
      console.log('\nMonthly envelopes retained:');
      for (const row of report.monthly.rows) console.log(`  ${row.period_key} ${row.subject_key}: ${row.revisions} revisions [${row.statuses.join(', ')}], latest produced ${row.latest_produced_at}`);
      for (const note of report.notes) console.log(`\n${note}`);
    }
  } else {
    const [sourceId, ...files] = positional;
    if (!sourceId || !files.length) usage();
    const apply = flags.get('apply') === 'true';
    const results = [];
    for (const [fileIndex, file] of files.entries()) {
      for (const { label, body } of await readEnvelopes(file, fileIndex)) {
        const result = await reconciliation.reconcileV1Envelope(sourceId, body, { apply });
        results.push({ label, ...result });
        if (!json) {
          const b = result.buckets.by_verdict, q = result.quotas.by_verdict;
          console.log(`${label} observed ${result.observed_at}${apply ? ' APPLIED' : ' dry run'}: buckets ${result.buckets.total}`
            + ` (duplicate ${b.duplicate}, superseded ${b.superseded}, advancing ${b.advancing}, new key ${b.new_key}); quotas ${result.quotas.total}`
            + ` (duplicate v1 ${q.duplicate_v1}, duplicate v2 ${q.duplicate_v2}, new ${q.new}); canonical ${n(result.canonical.before.tokens)} → ${n(result.canonical.after.tokens)} tokens`
            + `${result.canonical.projected ? ' (projected)' : ''}; ${result.no_new_facts ? 'no new logical facts' : 'adds logical facts'}`
            + `${apply ? `; inserted ${result.inserted.bucket_revisions} revisions, ${result.inserted.quota_samples} samples` : ''}`);
        }
      }
    }
    if (json) console.log(JSON.stringify(results, null, 2));
    else console.log(`\n${results.length} envelope(s) from source ${sourceId} (${results[0]?.source.mode ?? '?'}${results[0]?.source.disabled ? ', disabled' : ''}) mapped to account ${results[0]?.source.account_id ?? '?'}.`);
  }
} finally {
  await sql.end({ timeout: 2 });
}
