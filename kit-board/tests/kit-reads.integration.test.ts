import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { reportContractRegistry } from '../lib/report-contracts';
import { contractStatus } from '../lib/contract-status';

const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };

/**
 * The reads behind /kits, as the application role: the newest revisions per kind with HTML reduced to a
 * stand-in, never a usage report, and the collector sources with their accounts. No other integration
 * test writes standup revisions, so these are the kind's newest; they are produced in the last hour,
 * because a contract refuses an observation time in the future.
 */
maybe('the kits reads: recent bodies per kind with HTML reduced, and collector sources', async () => {
  const { createKitReads } = await import('../lib/kit-reads');
  const admin = postgres(url!, options);
  const app = postgres(url!, { ...options, username: 'personal_hub_app' });
  const reads = createKitReads(() => app);
  const producer = `kit-reads-${randomUUID().slice(0, 8)}`;
  const account = randomUUID(), source = randomUUID();
  const example = reportContractRegistry['standup-v1'].example as Record<string, any>;
  const base = Date.now() - 60 * 60_000;
  const insert = (kind: string, minute: number, html: string | null) => admin`INSERT INTO personal_hub.report_revisions
      (id, kind, period_key, subject_key, producer_id, idempotency_key, title, produced_at, status, schema_version, coverage, payload, html, content_hash)
    VALUES (${randomUUID()}, ${kind}, '2026-09-29', ${example.subject_key}, ${producer}, ${`${kind}-${minute}`}, ${example.title},
      ${new Date(base + minute * 60_000)}, 'complete', 1, ${admin.json({})}, ${admin.json(example.payload)}, ${html}, 'hash')`;
  try {
    for (let minute = 0; minute < 22; minute++) await insert('standup', minute, minute === 21 ? '<p>' + 'x'.repeat(5000) + '</p>' : minute === 20 ? '' : null);
    await insert('usage', 30, null);
    await admin`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${account}, 'codex', 'Kits test')`;
    await admin`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash) VALUES (${source}, ${account}, 'kits-test', 'local', ${randomUUID().replaceAll('-', '')})`;

    const rows = await reads.recentReportBodies(20);
    const standups = rows.filter(row => row.kind === 'standup');
    assert.equal(standups.length, 20, 'at most perKind revisions of a kind');
    assert.ok(standups.every(row => !('producer_id' in row) && row.idempotency_key.startsWith('standup-')), 'only the body fields, and only these rows');
    assert.deepEqual(standups.slice(0, 3).map(row => row.idempotency_key), ['standup-21', 'standup-20', 'standup-19'], 'newest first');
    assert.deepEqual(standups.slice(0, 3).map(row => row.html), ['<html>', '', null], 'HTML is a stand-in, empty stays empty');
    assert.equal(rows.some(row => row.kind === 'usage'), false, 'usage envelopes are not report bodies');
    assert.ok(new Date(standups[0].produced_at).getTime() > 0);
    const status = contractStatus('standup', rows);
    assert.deepEqual([status.checked, status.matched, status.latest], [20, 20, true], 'stored examples still match their contract');

    const collectors = await reads.collectorSources();
    const mine = collectors.find(row => row.id === source);
    assert.deepEqual(mine && [mine.machine_label, mine.mode, mine.disabled, mine.last_seen_at, mine.label], ['kits-test', 'local', false, null, 'Kits test']);
  } finally {
    await admin`DELETE FROM personal_hub.report_revisions WHERE producer_id = ${producer}`;
    await admin`DELETE FROM personal_hub.telemetry_sources WHERE id = ${source}`;
    await admin`DELETE FROM personal_hub.usage_accounts WHERE id = ${account}`;
    await app.end();
    await admin.end();
  }
});
