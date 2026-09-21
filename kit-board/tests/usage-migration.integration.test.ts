import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = {
  prepare: false,
  ...(process.env.TEST_DATABASE_HOST
    ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) }
    : {}),
};

const accountId = 'migration-upgrade-legacy';
const bindingId = '00000000-0000-4000-8000-000000000303';

maybe('usage detail migration preserves legacy bucket evidence and enforces new accounting states', async () => {
  const sql = postgres(url!, options);
  try {
    const [constraint] = await sql`
      SELECT convalidated
      FROM pg_constraint
      WHERE conrelid = 'personal_hub.account_usage_buckets'::regclass
        AND conname = 'account_usage_buckets_reasoning_subset_check'
    `;
    assert.equal(constraint.convalidated, false, 'the upgrade constraint must not scan or reject legacy rows');

    const [legacy] = await sql`
      SELECT output_tokens, reasoning_tokens, token_state
      FROM personal_hub.account_usage_buckets
      WHERE id = '00000000-0000-4000-8000-000000000304'
    `;
    assert.deepEqual(
      [Number(legacy.output_tokens), Number(legacy.reasoning_tokens), legacy.token_state],
      [1, 2, null],
      'a bucket accepted before the migration remains readable',
    );
    const [legacyProject] = await sql`
      SELECT r.project_basis AS raw_basis, r.project_key AS raw_key, r.project_hash,
        resolved.project_basis, resolved.project_key, resolved.identity_id, resolved.project_state
      FROM personal_hub.activity_requests r
      JOIN personal_hub.activity_request_project_resolution resolved ON resolved.request_id = r.id
      WHERE r.id = '00000000-0000-4000-8000-000000000330'
    `;
    assert.deepEqual(
      [legacyProject.raw_basis, legacyProject.raw_key, legacyProject.project_hash,
        legacyProject.project_basis, legacyProject.project_key, legacyProject.project_state],
      [null, null, 'c'.repeat(64), 'working_directory', 'c'.repeat(64), 'unassigned'],
      'the project registry backfills a scoped identity from retained hash-only evidence without rewriting it',
    );
    assert.ok(legacyProject.identity_id);
    const legacyAccesses = await sql`
      SELECT r.id, r.resource_key AS raw_key, r.configuration_version AS raw_version, r.access_kind, r.evidence_basis, r.outcome,
        resolved.identity_id, resolved.source_state, resolved.current_configuration, resolved.install_id,
        i.configuration_version AS identity_version, i.first_seen, i.last_seen
      FROM personal_hub.resource_accesses r
      JOIN personal_hub.resource_access_source_resolution resolved ON resolved.access_id = r.id
      JOIN personal_hub.usage_knowledge_source_identities i ON i.id = resolved.identity_id
      WHERE r.id IN ('00000000-0000-4000-8000-000000000340', '00000000-0000-4000-8000-000000000342')
      ORDER BY r.id
    `;
    assert.equal(legacyAccesses.length, 2, 'every retained access resolves through one backfilled identity');
    const [newerReceipt, olderReceipt] = legacyAccesses;
    assert.equal(newerReceipt.identity_id, olderReceipt.identity_id, 'one key on one install is one identity');
    assert.equal(newerReceipt.install_id, '00000000-0000-4000-8000-000000000302', 'identity scope comes from the binding install');
    assert.deepEqual(
      [newerReceipt.raw_key, newerReceipt.raw_version, newerReceipt.access_kind, newerReceipt.evidence_basis, newerReceipt.outcome,
        olderReceipt.raw_key, olderReceipt.raw_version, olderReceipt.access_kind, olderReceipt.evidence_basis, olderReceipt.outcome],
      ['legacy.vault', 'legacy.v1', 'read', 'explicit_argument', 'succeeded',
        'legacy.vault', 'legacy.v0', 'search', 'indirect_shell', 'unknown'],
      'the knowledge-source registry backfills a scoped identity without rewriting raw accesses',
    );
    assert.deepEqual(
      [newerReceipt.identity_version, newerReceipt.first_seen.toISOString(), newerReceipt.last_seen.toISOString()],
      ['legacy.v1', '2026-09-01T01:02:00.000Z', '2026-09-01T01:04:00.000Z'],
      'the version comes from the row received last while sighting bounds follow observation time',
    );
    assert.deepEqual(
      [newerReceipt.source_state, newerReceipt.current_configuration, olderReceipt.source_state, olderReceipt.current_configuration],
      ['unassigned', true, 'unassigned', false],
      'only rows classified under the latest configuration count as current',
    );
    // Allowance basis and per-type run counts: a reading accepted before the column existed is
    // reported as provider-reported through the recreated view, which keeps invoker rights.
    const [legacyReading] = await sql`
      SELECT r.basis AS raw_basis, v.basis AS view_basis, v.reader, v.origin
      FROM personal_hub.allowance_readings r
      JOIN personal_hub.allowance_percent_view v ON v.id = r.id
      WHERE r.id = '00000000-0000-4000-8000-000000000350'
    `;
    assert.deepEqual(
      [legacyReading.raw_basis, legacyReading.view_basis, legacyReading.reader, legacyReading.origin],
      ['reported', 'reported', 'statusline', 'allowance_readings'],
      'a reading retained before the basis column is reported, on the ledger and through the view',
    );
    const [viewOptions] = await sql`
      SELECT reloptions @> '{security_invoker=true}'::text[] AS invoker
      FROM pg_class WHERE oid = 'personal_hub.allowance_percent_view'::regclass
    `;
    assert.equal(viewOptions.invoker, true, 'replacing the view restates security_invoker');
    const [legacyRun] = await sql`
      SELECT accepted_by_type FROM personal_hub.companion_runs
      WHERE id = '00000000-0000-4000-8000-000000000351'
    `;
    assert.deepEqual(legacyRun.accepted_by_type, {}, 'a run accepted before per-type counts existed reports none rather than invented ones');
    await assert.rejects(
      sql`INSERT INTO personal_hub.allowance_readings
        (id, account_id, binding_id, provider, adapter, reader, meter_key, label, kind,
         value, unit, window_minutes, resets_at, observed_at, basis, content_hash)
        VALUES ('00000000-0000-4000-8000-000000000353', ${accountId}, ${bindingId},
          'claude', 'claude_account', 'statusline', 'five_hour', 'Claude · 5h', 'percent_used',
          30, 'percent', 300, '2026-09-01T09:00:00Z', '2026-09-01T08:00:00Z', 'guessed', ${'e'.repeat(64)})`,
      /allowance_readings_basis_check/,
      'basis is a closed set',
    );
    const indexes = await sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'personal_hub'
        AND indexname IN ('allowance_readings_binding_recent', 'activity_requests_binding_recent')
      ORDER BY indexname
    `;
    assert.deepEqual(indexes.map(row => row.indexname), ['activity_requests_binding_recent', 'allowance_readings_binding_recent']);

    await assert.rejects(
      sql`ALTER TABLE personal_hub.account_usage_buckets
        VALIDATE CONSTRAINT account_usage_buckets_reasoning_subset_check`,
      /account_usage_buckets_reasoning_subset_check/,
      'validation remains deferred until legacy violations are reconciled',
    );

    await assert.rejects(
      sql`INSERT INTO personal_hub.account_usage_buckets
        (id, account_id, binding_id, provider, adapter, report_source,
         bucket_start, bucket_end, model, dimensions_hash, output_tokens,
         reasoning_tokens, total_tokens, basis, observed_at, content_hash)
        VALUES ('00000000-0000-4000-8000-000000000305', ${accountId}, ${bindingId},
          'claude', 'claude_account', 'new_legacy_violation',
          '2026-09-01T02:00:00Z', '2026-09-01T03:00:00Z', 'synthetic-model',
          ${'6'.repeat(64)}, 1, 2, 1, 'reported', '2026-09-01T03:01:00Z', ${'7'.repeat(64)})`,
      /account_usage_buckets_reasoning_subset_check/,
      'NOT VALID still enforces the subset rule for new writes',
    );

    await assert.rejects(
      sql`INSERT INTO personal_hub.activity_requests
        (id, account_id, binding_id, provider, adapter, channel, record_id,
         semantic_key, product, surface, execution_host, session_hash,
         session_identity, model_actual, observed_at, input_fresh_tokens,
         input_cached_tokens, input_cache_write_tokens, output_tokens,
         reasoning_tokens, reported_total_tokens, unclassified_tokens,
         token_state, basis, outcome, parser_version, content_hash)
        VALUES ('00000000-0000-4000-8000-000000000306', ${accountId}, ${bindingId},
          'claude', 'claude_execution', 'local_file',
          '00000000-0000-4000-8000-000000000307', ${'8'.repeat(64)},
          'claude_code', 'cli', 'local', ${'9'.repeat(64)}, 'provider',
          'synthetic-model', '2026-09-01T04:01:00Z', 0, 0, 0, NULL, 2,
          1, 1, 'partial', 'reported', 'completed', '2.0.0', ${'a'.repeat(64)})`,
      /activity_requests_token_accounting_check/,
      'reasoning above a reported request total cannot be labeled partial',
    );
    await sql`INSERT INTO personal_hub.activity_requests
      (id, account_id, binding_id, provider, adapter, channel, record_id,
       semantic_key, product, surface, execution_host, session_hash,
       session_identity, model_actual, observed_at, input_fresh_tokens,
       input_cached_tokens, input_cache_write_tokens, output_tokens,
       reasoning_tokens, reported_total_tokens, unclassified_tokens,
       token_state, basis, outcome, parser_version, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000308', ${accountId}, ${bindingId},
        'claude', 'claude_execution', 'local_file',
        '00000000-0000-4000-8000-000000000309', ${'b'.repeat(64)},
        'claude_code', 'cli', 'local', ${'c'.repeat(64)}, 'provider',
        'synthetic-model', '2026-09-01T04:02:00Z', 0, 0, 0, NULL, 2,
        1, NULL, 'inconsistent', 'reported', 'completed', '2.0.0', ${'d'.repeat(64)})`;

    await assert.rejects(
      sql`INSERT INTO personal_hub.account_usage_buckets
        (id, account_id, binding_id, provider, adapter, report_source,
         bucket_start, bucket_end, model, dimensions_hash, input_tokens,
         cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
         total_tokens, unclassified_tokens, token_state, basis, observed_at,
         content_hash)
        VALUES ('00000000-0000-4000-8000-000000000310', ${accountId}, ${bindingId},
          'claude', 'claude_account', 'partial_reasoning_violation',
          '2026-09-01T05:00:00Z', '2026-09-01T06:00:00Z', 'synthetic-model',
          ${'e'.repeat(64)}, 0, 0, 0, NULL, 2, 1, 1, 'partial', 'reported',
          '2026-09-01T06:01:00Z', ${'f'.repeat(64)})`,
      /account_usage_buckets_token_accounting_check/,
      'reasoning above a provider total cannot be labeled partial',
    );
    await sql`INSERT INTO personal_hub.account_usage_buckets
      (id, account_id, binding_id, provider, adapter, report_source,
       bucket_start, bucket_end, model, dimensions_hash, input_tokens,
       cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
       total_tokens, unclassified_tokens, token_state, basis, observed_at,
       content_hash)
      VALUES ('00000000-0000-4000-8000-000000000311', ${accountId}, ${bindingId},
        'claude', 'claude_account', 'inconsistent_reasoning_evidence',
        '2026-09-01T06:00:00Z', '2026-09-01T07:00:00Z', 'synthetic-model',
        ${'0'.repeat(64)}, 0, 0, 0, NULL, 2, 1, NULL, 'inconsistent', 'reported',
        '2026-09-01T07:01:00Z', ${'1'.repeat(64)})`;

    await sql`INSERT INTO personal_hub.activity_requests
      (id, account_id, binding_id, provider, adapter, channel, record_id,
       semantic_key, product, surface, execution_host, session_hash,
       session_identity, model_actual, observed_at, input_fresh_tokens,
       input_cached_tokens, input_cache_write_tokens, output_tokens,
       reasoning_tokens, reported_total_tokens, unclassified_tokens,
       token_state, basis, outcome, parser_version, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000312', ${accountId}, ${bindingId},
        'claude', 'claude_execution', 'local_file',
        '00000000-0000-4000-8000-000000000313', ${'2'.repeat(64)},
        'claude_code', 'cli', 'local', ${'3'.repeat(64)}, 'provider',
        'synthetic-model', '2026-09-01T07:02:00Z', NULL, NULL, NULL, NULL, 2,
        NULL, NULL, 'partial', 'reported', 'completed', '2.0.0', ${'4'.repeat(64)})`;
    await sql`INSERT INTO personal_hub.account_usage_buckets
      (id, account_id, binding_id, provider, adapter, report_source,
       bucket_start, bucket_end, model, dimensions_hash, input_tokens,
       cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
       total_tokens, unclassified_tokens, token_state, basis, observed_at,
       content_hash)
      VALUES ('00000000-0000-4000-8000-000000000314', ${accountId}, ${bindingId},
        'claude', 'claude_account', 'partial_reasoning_only',
        '2026-09-01T07:00:00Z', '2026-09-01T08:00:00Z', 'synthetic-model',
        ${'5'.repeat(64)}, NULL, NULL, NULL, NULL, 2, NULL, NULL, 'partial', 'reported',
        '2026-09-01T08:01:00Z', ${'6'.repeat(64)})`;
    await assert.rejects(
      sql`UPDATE personal_hub.activity_requests SET token_state = 'unknown'
        WHERE id = '00000000-0000-4000-8000-000000000312'`,
      /activity_requests_token_accounting_check/,
      'reasoning-only evidence cannot be labeled unknown',
    );
    await assert.rejects(
      sql`UPDATE personal_hub.account_usage_buckets SET token_state = 'unknown'
        WHERE id = '00000000-0000-4000-8000-000000000314'`,
      /account_usage_buckets_token_accounting_check/,
      'provider reasoning-only evidence cannot be labeled unknown',
    );

    await assert.rejects(
      sql`INSERT INTO personal_hub.activity_requests
        (id, account_id, binding_id, provider, adapter, channel, record_id,
         semantic_key, product, surface, execution_host, session_hash,
         session_identity, model_actual, observed_at, input_fresh_tokens,
         input_cached_tokens, input_cache_write_tokens, output_tokens,
         reasoning_tokens, reported_total_tokens, unclassified_tokens,
         token_state, basis, outcome, parser_version, content_hash)
        VALUES ('00000000-0000-4000-8000-000000000315', ${accountId}, ${bindingId},
          'claude', 'claude_execution', 'local_file',
          '00000000-0000-4000-8000-000000000325', ${'5'.repeat(64)},
          'claude_code', 'cli', 'local', ${'6'.repeat(64)}, 'provider',
          'synthetic-model', '2026-09-01T08:02:00Z', 60, 0, 0, NULL, 50,
          100, 40, 'partial', 'reported', 'completed', '2.0.0', ${'7'.repeat(64)})`,
      /activity_requests_token_accounting_check/,
      'known request inputs plus reasoning as the output lower bound cannot exceed a partial total',
    );
    await sql`INSERT INTO personal_hub.activity_requests
      (id, account_id, binding_id, provider, adapter, channel, record_id,
       semantic_key, product, surface, execution_host, session_hash,
       session_identity, model_actual, observed_at, input_fresh_tokens,
       input_cached_tokens, input_cache_write_tokens, output_tokens,
       reasoning_tokens, reported_total_tokens, unclassified_tokens,
       token_state, basis, outcome, parser_version, content_hash)
      VALUES ('00000000-0000-4000-8000-000000000316', ${accountId}, ${bindingId},
        'claude', 'claude_execution', 'local_file',
        '00000000-0000-4000-8000-000000000326', ${'7'.repeat(64)},
        'claude_code', 'cli', 'local', ${'8'.repeat(64)}, 'provider',
        'synthetic-model', '2026-09-01T08:03:00Z', 60, 0, 0, NULL, 50,
        100, NULL, 'inconsistent', 'reported', 'completed', '2.0.0', ${'9'.repeat(64)})`;

    await assert.rejects(
      sql`INSERT INTO personal_hub.account_usage_buckets
        (id, account_id, binding_id, provider, adapter, report_source,
         bucket_start, bucket_end, model, dimensions_hash, input_tokens,
         cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
         total_tokens, unclassified_tokens, token_state, basis, observed_at,
         content_hash)
        VALUES ('00000000-0000-4000-8000-000000000317', ${accountId}, ${bindingId},
          'claude', 'claude_account', 'partial_reasoning_lower_bound',
          '2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z', 'synthetic-model',
          ${'a'.repeat(64)}, 60, 0, 0, NULL, 50, 100, 40, 'partial', 'reported',
          '2026-09-01T09:01:00Z', ${'b'.repeat(64)})`,
      /account_usage_buckets_token_accounting_check/,
      'known bucket inputs plus reasoning as the output lower bound cannot exceed a partial total',
    );
    await sql`INSERT INTO personal_hub.account_usage_buckets
      (id, account_id, binding_id, provider, adapter, report_source,
       bucket_start, bucket_end, model, dimensions_hash, input_tokens,
       cached_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
       total_tokens, unclassified_tokens, token_state, basis, observed_at,
       content_hash)
      VALUES ('00000000-0000-4000-8000-000000000318', ${accountId}, ${bindingId},
        'claude', 'claude_account', 'inconsistent_reasoning_lower_bound',
        '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z', 'synthetic-model',
        ${'c'.repeat(64)}, 60, 0, 0, NULL, 50, 100, NULL, 'inconsistent', 'reported',
        '2026-09-01T10:01:00Z', ${'d'.repeat(64)})`;

    const [states] = await sql`
      SELECT
        (SELECT token_state FROM personal_hub.activity_requests
          WHERE id = '00000000-0000-4000-8000-000000000308') AS request_state,
        (SELECT token_state FROM personal_hub.account_usage_buckets
          WHERE id = '00000000-0000-4000-8000-000000000311') AS bucket_state,
        (SELECT token_state FROM personal_hub.activity_requests
          WHERE id = '00000000-0000-4000-8000-000000000312') AS request_partial_state,
        (SELECT token_state FROM personal_hub.account_usage_buckets
          WHERE id = '00000000-0000-4000-8000-000000000314') AS bucket_partial_state,
        (SELECT token_state FROM personal_hub.activity_requests
          WHERE id = '00000000-0000-4000-8000-000000000316') AS request_lower_bound_state,
        (SELECT token_state FROM personal_hub.account_usage_buckets
          WHERE id = '00000000-0000-4000-8000-000000000318') AS bucket_lower_bound_state
    `;
    assert.deepEqual(
      [
        states.request_state,
        states.bucket_state,
        states.request_partial_state,
        states.bucket_partial_state,
        states.request_lower_bound_state,
        states.bucket_lower_bound_state,
      ],
      ['inconsistent', 'inconsistent', 'partial', 'partial', 'inconsistent', 'inconsistent'],
    );
  } finally {
    await sql.end({ timeout: 1 });
  }
});
