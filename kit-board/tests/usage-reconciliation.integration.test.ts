import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { RequestError, stableJson } from '../lib/contracts';

const url = process.env.TEST_DATABASE_URL;
const maybe = (name: string, fn: () => Promise<void>) => test(name, { skip: !url }, fn);
const options = { prepare: false, ...(process.env.TEST_DATABASE_HOST ? { host: process.env.TEST_DATABASE_HOST, port: Number(process.env.TEST_DATABASE_PORT) } : {}) };
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
const hashOf = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

// Synthetic history: one account observed by a retired v1 source and by a companion binding.
const H1 = '2026-09-02T02:00:00.000Z', H2 = '2026-09-02T03:00:00.000Z', H3 = '2026-09-02T04:00:00.000Z';
const bucket = (session: string, hour: string, calls: number, total: number, cached = 0) =>
  ({ session_hash: sha(session), hour, model: 'synthetic-model', input_tokens: total - cached, cached_tokens: cached, cache_write_tokens: 0, output_tokens: 0, total_tokens: total, calls });
const quota = (observed_at: string, used_percent: number, resets_at = '2026-09-02T05:00:00.000Z') =>
  ({ window_key: 'five_hour', label: '5-hour allowance', observed_at, used_percent, resets_at, window_minutes: 300 });
const envelope = (buckets: ReturnType<typeof bucket>[], quotas: ReturnType<typeof quota>[] = [], observed_at = '2026-09-02T04:30:00.000Z') =>
  ({ schema_version: 1, observed_at, buckets, quotas, coverage: { collector_version: '1.9.0' } });

maybe('historical reconciliation: canonical keys, preserved disabled-source history, and an idempotent v1 outbox replay', async () => {
  const { createUsageReconciliation } = await import('../lib/usage-reconciliation');
  const sql = postgres(url!, options);
  const reconciliation = createUsageReconciliation(() => sql);
  const account = `recon-${randomUUID().slice(0, 8)}`;
  const v1Source = randomUUID(), companionSource = randomUUID(), installId = randomUUID(), bindingId = randomUUID(), browserSource = randomUUID();
  try {
    await sql`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${account}, 'claude', 'Reconciliation fixture')`;
    await sql`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash) VALUES
      (${v1Source}, ${account}, 'retired v1 host', 'local', ${sha(randomUUID())}),
      (${companionSource}, ${account}, 'companion host', 'companion', ${sha(randomUUID())}),
      (${browserSource}, ${account}, 'browser', 'browser', ${sha(randomUUID())})`;
    await sql`INSERT INTO personal_hub.companion_installs (id, machine_label, kind, platform, arch, key_hash) VALUES (${installId}, 'companion host', 'companion', 'linux', 'amd64', ${sha(randomUUID())})`;
    await sql`INSERT INTO personal_hub.companion_bindings (id, install_id, account_id, source_id, provider, identity_hash) VALUES (${bindingId}, ${installId}, ${account}, ${companionSource}, 'claude', ${sha('identity')})`;
    const revision = (source: string, b: ReturnType<typeof bucket>, observed_at: string) =>
      sql`INSERT INTO personal_hub.token_bucket_revisions ${sql({ id: randomUUID(), account_id: account, source_id: source, observed_at, content_hash: hashOf(b), ...b })} ON CONFLICT DO NOTHING RETURNING id`;
    // A: both observed, same calls and total, different composition; the companion's later observation is canonical.
    await revision(v1Source, bucket('a', H1, 2, 100), '2026-09-02T02:10:00Z');
    await revision(companionSource, bucket('a', H1, 2, 100, 40), '2026-09-02T02:12:00Z');
    // B: the companion saw more of the session. C and D: v1 only, D inside an hour the companion did observe.
    await revision(v1Source, bucket('b', H1, 1, 50), '2026-09-02T02:10:00Z');
    await revision(companionSource, bucket('b', H1, 3, 150), '2026-09-02T02:12:00Z');
    await revision(v1Source, bucket('c', H2, 1, 30), '2026-09-02T03:10:00Z');
    await revision(v1Source, bucket('d', H1, 1, 20), '2026-09-02T02:10:00Z');
    // E: companion only.
    await revision(companionSource, bucket('e', H3, 4, 400), '2026-09-02T04:12:00Z');
    // An identical republication is one row on the ledger, whichever source published first, so the
    // companion's copy of D is dropped by the unique key and D still reads as a v1-only key.
    assert.equal((await revision(companionSource, bucket('d', H1, 1, 20), '2026-09-02T02:12:00Z')).length, 0);

    const sample = (observed_at: string, used_percent: number, resets_at = '2026-09-02T05:00:00.000Z') =>
      sql`INSERT INTO personal_hub.quota_samples (id, account_id, source_id, content_hash, window_key, label, observed_at, used_percent, resets_at, window_minutes)
        VALUES (${randomUUID()}, ${account}, ${v1Source}, ${hashOf(quota(observed_at, used_percent, resets_at))}, 'five_hour', '5-hour allowance', ${observed_at}, ${used_percent}, ${resets_at}, 300)`;
    const reading = (observed_at: string, value: number, resets_at = '2026-09-02T05:00:00Z') =>
      sql`INSERT INTO personal_hub.allowance_readings (id, account_id, binding_id, provider, adapter, reader, meter_key, label, kind, value, unit, window_minutes, resets_at, observed_at, basis, content_hash)
        VALUES (${randomUUID()}, ${account}, ${bindingId}, 'claude', 'claude_account', 'statusline', 'five_hour', 'Claude · 5h', 'percent_used', ${value}, 'percent', 300, ${resets_at}, ${observed_at}, 'reported', ${sha(randomUUID())})`;
    await sample('2026-09-02T03:00:00.000Z', 10);
    await sample('2026-09-02T03:20:00.000Z', 20);   // the v1 hook and the companion hook read one inbox: same observation twice
    await reading('2026-09-02T03:20:00Z', 20);
    await reading('2026-09-02T03:40:00Z', 30);

    // The before/after matrix by account, period, and model.
    const before = await reconciliation.report({ since: '2026-09-01' });
    const hourly = before.hourly.rows.filter(row => row.account_id === account);
    assert.equal(hourly.length, 1);
    assert.deepEqual(hourly[0], {
      account_id: account, provider: 'claude', period: '2026-09', model: 'synthetic-model',
      keys: { v1_only: 2, v2_only: 1, shared: 2, shared_equal: 1, shared_v2_larger: 1, shared_v1_larger: 0, v1_only_in_v2_hours: 1 },
      canonical: { calls: 11, tokens: 700, calls_from_v1_rows: 2, tokens_from_v1_rows: 50 },
      without_v1: { calls: 9, tokens: 650 },
      v1_only: { calls: 2, tokens: 50 },
    }, 'shared keys count once, v1-only keys stay as coarse rows, and dropping v1 rows would lose exactly the v1-only history');
    const [canonicalA] = await sql`SELECT source_mode, cached_tokens FROM personal_hub.token_bucket_canonical WHERE account_id = ${account} AND session_hash = ${sha('a')}`;
    assert.deepEqual([canonicalA.source_mode, Number(canonicalA.cached_tokens)], ['companion', 40], 'the canonical view applies the nonregressing rule');
    await assert.rejects(reconciliation.report({ since: 'yesterday' }), /ISO date/);

    const allowances = () => reconciliation.report({ since: '2026-09-01' }).then(r => ({
      rows: r.allowances.rows.filter(row => row.account_id === account).map(({ observed, resets, ...row }) => ({ ...row, first: observed.first, last: observed.last, reset: resets.last })),
      current: r.allowances.current.find(row => row.account_id === account && row.meter_key === 'five_hour') }));
    const enabled = await allowances();
    assert.deepEqual(enabled.rows, [
      { account_id: account, provider: 'claude', meter_key: 'five_hour', origin: 'allowance_readings', reader: 'statusline', rows: 2, history_only_rows: 0, cross_ledger_duplicates: 0,
        visible_before: 2, visible_after: 2, first: '2026-09-02T03:20:00.000Z', last: '2026-09-02T03:40:00.000Z', reset: '2026-09-02T05:00:00.000Z' },
      { account_id: account, provider: 'claude', meter_key: 'five_hour', origin: 'quota_samples', reader: 'v1', rows: 2, history_only_rows: 0, cross_ledger_duplicates: 1,
        visible_before: 2, visible_after: 1, first: '2026-09-02T03:00:00.000Z', last: '2026-09-02T03:20:00.000Z', reset: '2026-09-02T05:00:00.000Z' },
    ]);
    assert.deepEqual(enabled.current, { account_id: account, meter_key: 'five_hour', current_observed_at: '2026-09-02T03:40:00.000Z', newest_any_observed_at: '2026-09-02T03:40:00.000Z', revived_prevented: false });

    // Disabling the v1 source and the binding preserves every observation as history and leaves no current reading.
    await sql`UPDATE personal_hub.telemetry_sources SET disabled = true WHERE id = ${v1Source}`;
    await sql`UPDATE personal_hub.companion_bindings SET enabled = false WHERE id = ${bindingId}`;
    const disabled = await allowances();
    assert.deepEqual(disabled.rows.map(row => [row.origin, row.rows, row.history_only_rows, row.visible_before, row.visible_after]),
      [['allowance_readings', 2, 2, 0, 2], ['quota_samples', 2, 2, 0, 1]], 'the old policy hid all four rows; the new one shows three, the duplicate once');
    assert.deepEqual(disabled.current, { account_id: account, meter_key: 'five_hour', current_observed_at: null, newest_any_observed_at: '2026-09-02T03:40:00.000Z', revived_prevented: true });
    const view = await sql`SELECT origin, used_percent, history_only FROM personal_hub.allowance_percent_view WHERE account_id = ${account} ORDER BY observed_at`;
    assert.deepEqual(view.map(r => [r.origin, Number(r.used_percent), r.history_only]), [['quota_samples', 10, true], ['allowance_readings', 20, true], ['allowance_readings', 30, true]]);
    await sql`UPDATE personal_hub.companion_bindings SET enabled = true WHERE id = ${bindingId}`;
    assert.equal((await allowances()).current?.current_observed_at, '2026-09-02T03:40:00.000Z', 're-enabling the binding restores its newest reading as current');
    // With the v1 source live and only the binding disabled, the shared observation surfaces as the live v1 sample.
    await sql`UPDATE personal_hub.telemetry_sources SET disabled = false WHERE id = ${v1Source}`;
    await sql`UPDATE personal_hub.companion_bindings SET enabled = false WHERE id = ${bindingId}`;
    const mixed = await sql`SELECT origin, used_percent, history_only FROM personal_hub.allowance_percent_view WHERE account_id = ${account} ORDER BY observed_at, origin`;
    assert.deepEqual(mixed.map(r => [r.origin, Number(r.used_percent), r.history_only]),
      [['quota_samples', 10, false], ['allowance_readings', 20, true], ['quota_samples', 20, false], ['allowance_readings', 30, true]],
      'a disabled binding never demotes an enabled source\'s copy of the observation');
    assert.equal((await allowances()).current?.current_observed_at, '2026-09-02T03:20:00.000Z');
    await sql`UPDATE personal_hub.telemetry_sources SET disabled = true WHERE id = ${v1Source}`;
    await sql`UPDATE personal_hub.companion_bindings SET enabled = true WHERE id = ${bindingId}`;

    // The retired collector's pending envelope, classified under its explicit (now disabled) source mapping.
    const pending = envelope([
      bucket('a', H1, 2, 100),          // the v1 revision already stored: duplicate
      bucket('b', H1, 3, 150),          // identical to the companion's canonical row: duplicate
      bucket('c', H2, 5, 90),           // more complete than the stored v1-only row: advancing
      bucket('d', H1, 1, 20),           // duplicate
      bucket('f', H2, 1, 10),           // never observed: new key, preserved as a coarse row
      bucket('e', H3, 4, 400, 100),     // same calls and total as the companion's row, other composition: superseded
    ], [
      quota('2026-09-02T03:00:00.000Z', 10),   // already on the v1 ledger
      quota('2026-09-02T03:40:00.000Z', 30),   // the companion recorded this observation: never copied
      quota('2026-09-02T04:00:00.000Z', 40),   // new
    ]);
    const count = async () => {
      const [b] = await sql`SELECT count(*)::int AS n FROM personal_hub.token_bucket_revisions WHERE account_id = ${account}`;
      const [q] = await sql`SELECT count(*)::int AS n FROM personal_hub.quota_samples WHERE account_id = ${account}`;
      return [Number(b.n), Number(q.n)];
    };
    const dry = await reconciliation.reconcileV1Envelope(v1Source, pending);
    assert.deepEqual([dry.applied, dry.source.disabled, dry.source.account_id, dry.no_new_facts], [false, true, account, false]);
    assert.deepEqual(dry.buckets.by_verdict, { duplicate: 3, superseded: 1, advancing: 1, new_key: 1 });
    assert.deepEqual(dry.buckets.verdicts.map(v => v.verdict), ['duplicate', 'duplicate', 'advancing', 'duplicate', 'new_key', 'superseded']);
    assert.deepEqual(dry.buckets.verdicts[2].canonical, { calls: 1, total_tokens: 30, source_mode: 'local' });
    assert.deepEqual(dry.quotas.by_verdict, { duplicate_v1: 1, duplicate_v2: 1, new: 1 });
    assert.deepEqual(dry.canonical, { before: { calls: 11, tokens: 700 }, after: { calls: 16, tokens: 770 }, projected: true });
    assert.deepEqual(await count(), [7, 2], 'a dry run writes nothing');
    const [contact] = await sql`SELECT last_seen_at FROM personal_hub.telemetry_sources WHERE id = ${v1Source}`;

    const applied = await reconciliation.reconcileV1Envelope(v1Source, pending, { apply: true });
    assert.deepEqual([applied.applied, applied.inserted, applied.canonical], [true, { bucket_revisions: 2, quota_samples: 1 }, { before: { calls: 11, tokens: 700 }, after: { calls: 16, tokens: 770 }, projected: false }]);
    assert.deepEqual(await count(), [9, 3]);
    const [canonicalE] = await sql`SELECT source_mode, cached_tokens FROM personal_hub.token_bucket_canonical WHERE account_id = ${account} AND session_hash = ${sha('e')}`;
    assert.deepEqual([canonicalE.source_mode, Number(canonicalE.cached_tokens)], ['companion', 0], 'a superseded replay is not appended, so it cannot win the composition tie-break');
    const [replayed] = await sql`SELECT observed_at, source_id FROM personal_hub.token_bucket_revisions WHERE account_id = ${account} AND session_hash = ${sha('f')}`;
    assert.deepEqual([replayed.observed_at.toISOString(), replayed.source_id], ['2026-09-02T04:30:00.000Z', v1Source], 'a replayed fact keeps its own observation time and source');
    assert.deepEqual((await sql`SELECT last_seen_at FROM personal_hub.telemetry_sources WHERE id = ${v1Source}`)[0].last_seen_at, contact.last_seen_at, 'a replay is not collector contact');
    assert.equal((await sql`SELECT count(*)::int AS n FROM personal_hub.quota_samples WHERE account_id = ${account} AND used_percent = 30`)[0].n, 0, 'the observation the companion holds was not copied');

    const again = await reconciliation.reconcileV1Envelope(v1Source, pending, { apply: true });
    assert.deepEqual([again.no_new_facts, again.inserted, again.canonical.before, again.canonical.after], [true, { bucket_revisions: 0, quota_samples: 0 }, { calls: 16, tokens: 770 }, { calls: 16, tokens: 770 }]);
    assert.deepEqual(again.buckets.by_verdict, { duplicate: 5, superseded: 1, advancing: 0, new_key: 0 });
    assert.deepEqual(again.quotas.by_verdict, { duplicate_v1: 2, duplicate_v2: 1, new: 0 });
    assert.deepEqual(await count(), [9, 3], 'a second run adds no row and no logical fact');
    const after = (await reconciliation.report({ since: '2026-09-01' })).hourly.rows.find(row => row.account_id === account)!;
    assert.deepEqual([after.canonical.calls, after.canonical.tokens, after.keys.v1_only, after.keys.shared], [16, 770, 3, 2]);

    // An interrupted import leaves nothing behind: the whole envelope is one transaction.
    const interrupted = Object.assign(((...args: unknown[]) => Reflect.apply(sql, undefined, args)) as unknown as typeof sql, sql, {
      begin: ((callback: (tx: unknown) => Promise<unknown>) => sql.begin(async tx => { await callback(tx); throw new Error('interrupted before commit'); })) as unknown as typeof sql.begin,
    });
    const partial = envelope([bucket('h', H3, 1, 5)], [quota('2026-09-02T04:20:00.000Z', 45)]);
    await assert.rejects(createUsageReconciliation(() => interrupted).reconcileV1Envelope(v1Source, partial, { apply: true }), /interrupted/);
    assert.deepEqual(await count(), [9, 3]);
    assert.equal((await reconciliation.reconcileV1Envelope(v1Source, partial)).no_new_facts, false, 'the interrupted facts are still pending');

    // Mapping is explicit: an unknown, companion, or bucket-bearing browser source is refused.
    const status = (code: number, pattern: RegExp) => (error: unknown) => error instanceof RequestError && error.status === code && pattern.test(error.message);
    await assert.rejects(reconciliation.reconcileV1Envelope(randomUUID(), pending), status(404, /Unknown telemetry source/));
    await assert.rejects(reconciliation.reconcileV1Envelope('not-a-uuid', pending), status(404, /Unknown telemetry source/));
    await assert.rejects(reconciliation.reconcileV1Envelope(companionSource, pending), status(409, /companion binding/));
    await assert.rejects(reconciliation.reconcileV1Envelope(browserSource, pending), status(403, /quota readings only/));
    await assert.rejects(reconciliation.reconcileV1Envelope(v1Source, { schema_version: 1 }), 'an invalid envelope is rejected by the v1 contract');
    const browserOnly = await reconciliation.reconcileV1Envelope(browserSource, envelope([], [quota('2026-09-02T04:10:00.000Z', 42)]));
    assert.deepEqual([browserOnly.source.mode, browserOnly.quotas.by_verdict.new], ['browser', 1]);

    // Monthly envelopes are only counted, never expanded.
    assert.equal(typeof (await reconciliation.report()).monthly.note, 'string');
  } finally {
    await sql.end({ timeout: 1 });
  }
});
