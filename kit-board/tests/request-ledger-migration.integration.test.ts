import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

// Runs under scripts/test-db.mjs, which seeds the Cursor replay fixture (seedRequestLedgerReplayFixture)
// before 20260921090000_request_ledger_revision_uniqueness.sql applies.
const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };

const accountId = 'migration-upgrade-legacy';
const bindingId = '00000000-0000-4000-8000-000000000303';
const cursorRecord = '00000000-0000-4000-8000-000000000361';
const claudeRecord = '00000000-0000-4000-8000-000000000366';

maybe('the request ledger migration keeps one earliest sighting per identical Cursor content and names the revision key', async () => {
  const sql = postgres(url!, options);
  try {
    const cursorRows = await sql`SELECT id, model_actual, observed_at, ended_at, received_at FROM personal_hub.activity_requests
      WHERE account_id = ${accountId} AND record_id = ${cursorRecord} ORDER BY observed_at`;
    assert.deepEqual(cursorRows.map(row => [row.id, row.model_actual, new Date(row.observed_at as string).toISOString()]), [
      ['00000000-0000-4000-8000-000000000362', null, '2026-09-03T01:00:00.000Z'],
      ['00000000-0000-4000-8000-000000000365', 'cursor-synthetic-model', '2026-09-03T04:00:00.000Z'],
    ], 'three identical sightings collapse to the earliest observed_at (the one received last); the differing revision stays');
    const claudeRows = await sql`SELECT count(*)::int AS rows FROM personal_hub.activity_requests WHERE account_id = ${accountId} AND record_id = ${claudeRecord}`;
    assert.equal(Number(claudeRows[0].rows), 2, 'a claude pair differing only in ended_at is not the Cursor replay and is untouched');

    const constraints = await sql`SELECT conname FROM pg_constraint
      WHERE conrelid = 'personal_hub.activity_requests'::regclass AND contype = 'u' ORDER BY conname`;
    assert.deepEqual(constraints.map(row => row.conname), ['activity_requests_revision'], 'the inline UNIQUE constraint carries the ledgers\' shared name');
    const revisionIndexes = await sql`SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'personal_hub' AND indexname LIKE '%\\_revision'
        AND tablename IN ('activity_requests', 'agent_events', 'tool_events', 'resource_accesses') ORDER BY tablename`;
    assert.deepEqual(revisionIndexes.map(row => [row.tablename, row.indexname]), [
      ['activity_requests', 'activity_requests_revision'], ['agent_events', 'agent_events_revision'],
      ['resource_accesses', 'resource_accesses_revision'], ['tool_events', 'tool_events_revision'],
    ]);
    for (const row of revisionIndexes) assert.match(row.indexdef as string, /^CREATE UNIQUE INDEX \w+ ON personal_hub\.\w+ USING btree \(account_id, semantic_key, channel, content_hash\)$/);
    assert.equal((await sql`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'personal_hub' AND tablename = 'activity_requests'
      AND indexdef LIKE '%(account_id, semantic_key, channel, content_hash)'`)[0].n, 1, 'one revision index, not a second copy');

    // An exact replay of the surviving sighting is refused by the key, as ingestion's ON CONFLICT DO NOTHING relies on.
    const replay = await sql`INSERT INTO personal_hub.activity_requests
        (id, account_id, binding_id, provider, adapter, channel, record_id, semantic_key, product, surface, execution_host,
         session_hash, session_identity, model_actual, ended_at, observed_at, input_fresh_tokens, input_cached_tokens,
         input_cache_write_tokens, output_tokens, basis, outcome, parser_version, content_hash)
      VALUES (${'00000000-0000-4000-8000-000000000369'}, ${accountId}, ${bindingId}, 'cursor', 'cursor_execution', 'local_db',
        ${cursorRecord}, ${'1'.repeat(64)}, 'cursor', 'ide', 'local', ${'2'.repeat(64)}, 'derived', NULL,
        '2026-09-03T05:00:00Z', '2026-09-03T05:00:00Z', 0, 0, 0, 0, 'exact', 'completed', '2.0.0', ${'6'.repeat(64)})
      ON CONFLICT DO NOTHING RETURNING id`;
    assert.equal(replay.length, 0);
  } finally { await sql.end({ timeout: 1 }); }
});
