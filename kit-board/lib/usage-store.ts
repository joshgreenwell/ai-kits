import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { RequestError, stableJson } from './contracts';
import { readCache } from './read-cache';
import { collectionSettingsSchema, installOverrideSchema, mergeSettings, type CollectionSettings, type InstallOverride } from './companion-settings';
import {
  adapterProvider, bindingRequestSchema, contentSubject, identityRequestSchema, isBrowserAdapter, issuePairingCodeSchema,
  normalizePairingCode, pairRequestSchema, PAIRING_ALPHABET, type AdapterCoverage, type RejectionReason, type UsageEnvelope, type UsageRecord,
} from './usage-contract';

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export type CompanionInstallRow = {
  id: string; kind: 'companion' | 'browser'; machine_label: string; platform: string; arch: string;
  paused: boolean; settings: InstallOverride;
};
type BindingRow = {
  id: string; account_id: string; provider: string; source_id: string; enabled: boolean;
  identity_hash: string | null; identity_reset_at: string | null;
};

export type BindingSummary = { id: string; install_id: string; account_id: string; account_label: string; provider: string; identity_hash: string | null;
  identity_reset_at: string | null; enabled: boolean; source_id: string; last_seen_at: string | null; coverage: unknown;
  identity_state: 'confirmed' | 'unconfirmed' | 'reset'; v1_active: { id: string; machine_label: string; last_seen_at: string | null }[] };
export type InstallSummary = { id: string; machine_label: string; kind: 'companion' | 'browser'; platform: string; arch: string; settings: InstallOverride;
  paused: boolean; disabled: boolean; companion_version: string | null; created_at: string; last_seen_at: string | null; last_config_fetch_at: string | null;
  bindings: BindingSummary[]; applied_settings_version: number | null; update_available: boolean;
  latest_run: { run_id: string; started_at: string; finished_at: string; companion_version: string; settings_version: number; coverage: AdapterCoverage[];
    accepted_buckets: number; accepted_records: number; rejected_records: number; received_at: string } | null };
export type InstallsSummary = { installs: InstallSummary[]; settings: CollectionSettings; settings_version: number; latest_companion_version: string | null; settings_updated_at: string };

const CHANNEL_RANK = "CASE channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END";
const IDENTITY_RANK = "CASE session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END";

/** Injectable database provider keeps the store testable against a disposable cluster. */
export function createUsageStore(getDatabase?: () => Sql) {
  // Routes load the server-only connector only when a database operation runs.
  const sql = async () => getDatabase?.() ?? (await import('./db')).database();

  async function consumeAttempt(db: Sql, bucket: string, maximum: number) {
    const rows = await db`INSERT INTO personal_hub.login_limits (bucket, attempts, expires_at)
      VALUES (${bucket}, 1, now() + interval '15 minutes')
      ON CONFLICT(bucket) DO UPDATE SET
        attempts = CASE WHEN login_limits.expires_at < now() THEN 1 ELSE login_limits.attempts + 1 END,
        expires_at = CASE WHEN login_limits.expires_at < now() THEN now() + interval '15 minutes' ELSE login_limits.expires_at END
      RETURNING attempts`;
    return Number(rows[0].attempts) <= maximum;
  }

  /** Eight characters from an unambiguous alphabet, ten-minute expiry, stored hashed; returned once. */
  async function issuePairingCode(input: unknown) {
    const data = issuePairingCodeSchema.parse(input);
    const code = Array.from({ length: 8 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join('');
    const db = await sql();
    const [row] = await db`INSERT INTO personal_hub.companion_pairing_codes (code_hash, machine_label, kind, expires_at)
      VALUES (${hash(code)}, ${data.machine_label}, ${data.kind}, now() + interval '10 minutes') RETURNING expires_at`;
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: new Date(row.expires_at as string).toISOString(), machine_label: data.machine_label, kind: data.kind };
  }

  /** Exchanges a one-time code for an install id and key. Rate-limited per address and per code prefix. */
  async function pairInstall(input: unknown, address: string) {
    const data = pairRequestSchema.parse(input);
    const code = normalizePairingCode(data.code);
    if (code.length !== 8) throw new RequestError('Invalid or expired pairing code', 401);
    const db = await sql();
    if (!await consumeAttempt(db, 'pair:global', 200) || !await consumeAttempt(db, 'pair:ip:' + hash(address), 20) || !await consumeAttempt(db, 'pair:code:' + hash(code.slice(0, 4)), 10)) {
      throw new RequestError('Too many pairing attempts. Try again in 15 minutes.', 429);
    }
    const id = randomUUID(), key = randomBytes(32).toString('base64url');
    const paired = await db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      const [claimed] = await tx`UPDATE personal_hub.companion_pairing_codes SET used_at = now()
        WHERE code_hash = ${hash(code)} AND used_at IS NULL AND expires_at > now() RETURNING machine_label, kind`;
      if (!claimed) return false;
      await tx`INSERT INTO personal_hub.companion_installs (id, machine_label, kind, platform, arch, key_hash)
        VALUES (${id}, ${data.machine_label}, ${data.kind}, ${data.platform}, ${data.arch}, ${hash(key)})`;
      await tx`UPDATE personal_hub.companion_pairing_codes SET install_id = ${id} WHERE code_hash = ${hash(code)}`;
      return true;
    });
    if (!paired) throw new RequestError('Invalid or expired pairing code', 401);
    return { install_id: id, key };
  }

  /** Bearer install key → the install row (not disabled); updates `last_seen_at`. */
  async function companionInstall(request: Request): Promise<CompanionInstallRow> {
    const auth = request.headers.get('authorization') ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new RequestError('Unauthorized', 401);
    const db = await sql();
    const [row] = await db`UPDATE personal_hub.companion_installs SET last_seen_at = now()
      WHERE key_hash = ${hash(auth.slice(7))} AND NOT disabled RETURNING id, kind, machine_label, platform, arch, paused, settings`;
    if (!row) throw new RequestError('Unauthorized', 401);
    return clone(row) as CompanionInstallRow;
  }

  async function globalSettings(db: Sql) {
    const [row] = await db`SELECT settings, settings_version, latest_companion_version, updated_at FROM personal_hub.collection_settings WHERE id = 1`;
    if (!row) throw new RequestError('Collection settings are not initialized', 503);
    return { stored: (row.settings ?? {}) as Partial<CollectionSettings>, settings_version: Number(row.settings_version),
      latest_companion_version: (row.latest_companion_version as string | null) ?? null, updated_at: row.updated_at as string };
  }

  /** The config document (section 1.2) and its ETag. */
  async function companionConfig(install: CompanionInstallRow) {
    const db = await sql();
    const global = await globalSettings(db);
    const bindings = await db`SELECT id AS binding_id, account_id, provider, enabled, identity_hash FROM personal_hub.companion_bindings
      WHERE install_id = ${install.id} ORDER BY created_at, id`;
    const settings = mergeSettings(global.stored, install.settings);
    settings.paused = settings.paused || install.paused;
    const document = { schema_version: 2, settings_version: global.settings_version,
      install: { id: install.id, kind: install.kind, machine_label: install.machine_label, paused: install.paused },
      bindings: clone(bindings), settings, companion: { latest_version: global.latest_companion_version } };
    await db`UPDATE personal_hub.companion_installs SET last_config_fetch_at = now() WHERE id = ${install.id}`;
    return { document, etag: `"${hash(document).slice(0, 32)}"` };
  }

  /** Creates the account (provider must match), one never-issued companion source row, and the binding. Idempotent. */
  async function createBinding(install: CompanionInstallRow, input: unknown) {
    const data = bindingRequestSchema.parse(input);
    const db = await sql();
    return db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${data.account_id}, ${data.provider}, ${data.account_label}) ON CONFLICT DO NOTHING`;
      const [account] = await tx`SELECT provider FROM personal_hub.usage_accounts WHERE id = ${data.account_id}`;
      if (account.provider !== data.provider) throw new RequestError('Account belongs to another provider', 409);
      const [existing] = await tx`SELECT id AS binding_id, account_id, provider, enabled, identity_hash FROM personal_hub.companion_bindings
        WHERE install_id = ${install.id} AND account_id = ${data.account_id}`;
      if (existing) return { created: false, binding: clone(existing) };
      const sourceId = randomUUID(), bindingId = randomUUID();
      await tx`INSERT INTO personal_hub.telemetry_sources (id, account_id, machine_label, mode, key_hash)
        VALUES (${sourceId}, ${data.account_id}, ${install.machine_label}, 'companion', ${hash(randomBytes(32).toString('base64url'))})`;
      await tx`INSERT INTO personal_hub.companion_bindings (id, install_id, account_id, source_id, provider, identity_hash)
        VALUES (${bindingId}, ${install.id}, ${data.account_id}, ${sourceId}, ${data.provider}, ${data.identity_hash})`;
      return { created: true, binding: { binding_id: bindingId, account_id: data.account_id, provider: data.provider, enabled: true, identity_hash: data.identity_hash } };
    });
  }

  async function bumpSettingsVersion(db: Sql) {
    const [row] = await db`UPDATE personal_hub.collection_settings SET settings_version = settings_version + 1, updated_at = now() WHERE id = 1 RETURNING settings_version`;
    return Number(row.settings_version);
  }

  /** Replaces this install's override; increments the shared settings version. */
  async function updateInstallSettings(install: CompanionInstallRow, input: unknown) {
    const override = installOverrideSchema.parse(input);
    const db = await sql();
    await db`UPDATE personal_hub.companion_installs SET settings = ${db.json(override as postgres.JSONValue)} WHERE id = ${install.id}`;
    return { ok: true, settings_version: await bumpSettingsVersion(db) };
  }

  /** Sets a binding's identity when it is unset or was reset by the UI; a different existing hash is a conflict. */
  async function confirmIdentity(install: CompanionInstallRow, bindingId: string, input: unknown) {
    const data = identityRequestSchema.parse(input);
    if (!isUuid(bindingId)) throw new RequestError('Unknown binding', 404);
    const db = await sql();
    const [binding] = await db`SELECT id, identity_hash, enabled FROM personal_hub.companion_bindings WHERE id = ${bindingId} AND install_id = ${install.id}`;
    if (!binding) throw new RequestError('Unknown binding', 404);
    if (binding.identity_hash === null) {
      await db`UPDATE personal_hub.companion_bindings SET identity_hash = ${data.identity_hash}, identity_reset_at = NULL WHERE id = ${bindingId}`;
    } else if (binding.identity_hash !== data.identity_hash) {
      throw new RequestError('The binding identity changed; approve the new identity in the Observatory first', 409);
    }
    return { ok: true, binding_id: bindingId, identity_hash: data.identity_hash, enabled: binding.enabled as boolean };
  }

  function rejection(install: CompanionInstallRow, binding: BindingRow | undefined, record: UsageRecord): RejectionReason | null {
    if (!binding) return 'binding_not_owned';
    if (!binding.enabled) return 'binding_not_enabled';
    if (binding.identity_hash === null && binding.identity_reset_at !== null) return 'identity_changed';
    if (isBrowserAdapter(record.adapter) !== (install.kind === 'browser')) return 'adapter_not_allowed_for_install';
    if (install.kind === 'browser' && record.record_type === 'activity.request') return 'record_type_not_allowed_for_install';
    if (adapterProvider(record.adapter) !== binding.provider) return 'adapter_provider_mismatch';
    return null;
  }

  /** A v1-shaped coverage summary for the binding's source row, so the existing Connections list and freshness logic keep working. */
  function sourceCoverage(entries: AdapterCoverage[], version: string) {
    const execution = entries.find(entry => entry.adapter.endsWith('_execution'));
    return { collector_version: version, companion: true,
      files: execution?.files ?? 0, bytes_read: execution?.bytes_read ?? 0, duration_ms: execution?.duration_ms ?? 0,
      malformed_lines: execution?.malformed ?? 0,
      unavailable_roots: execution?.state === 'partial' && execution.detail_code === 'unavailable_roots' ? 1 : 0,
      adapters: entries };
  }

  /** One transaction: buckets into the v1 ledger, records into the four ledgers, coverage into the run record. */
  async function ingestUsage(install: CompanionInstallRow, envelope: UsageEnvelope) {
    const db = await sql();
    return db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      const bindingRows = await tx`SELECT id, account_id, provider, source_id, enabled, identity_hash, identity_reset_at
        FROM personal_hub.companion_bindings WHERE install_id = ${install.id}`;
      const bindings = new Map<string, BindingRow>();
      for (const row of bindingRows) bindings.set(row.id as string, clone(row) as BindingRow);
      const acceptable = (binding?: BindingRow) => !!binding && binding.enabled && !(binding.identity_hash === null && binding.identity_reset_at !== null);

      let acceptedBuckets = 0, duplicates = 0;
      if (install.kind !== 'browser') {
        const rows = envelope.buckets.flatMap(entry => {
          const binding = bindings.get(entry.binding_id);
          if (!acceptable(binding)) return [];
          return [{ id: randomUUID(), account_id: binding!.account_id, source_id: binding!.source_id, observed_at: envelope.run.finished_at,
            content_hash: hash(entry.bucket), ...entry.bucket }];
        });
        if (rows.length) {
          const inserted = await tx`INSERT INTO personal_hub.token_bucket_revisions ${tx(rows)} ON CONFLICT DO NOTHING RETURNING id`;
          acceptedBuckets = inserted.length; duplicates += rows.length - inserted.length;
        }
      }

      const rejected: { record_id: string; reason: RejectionReason }[] = [];
      const requests: Row[] = [], usage: Row[] = [], readings: Row[] = [], money: Row[] = [];
      for (const record of envelope.records) {
        const binding = bindings.get(record.binding_id);
        const reason = rejection(install, binding, record);
        if (reason) { rejected.push({ record_id: record.record_id, reason }); continue; }
        const base = { id: randomUUID(), account_id: binding!.account_id, binding_id: record.binding_id, provider: binding!.provider,
          adapter: record.adapter, observed_at: record.observed_at, basis: record.basis, content_hash: hash(contentSubject(record)) };
        switch (record.record_type) {
          case 'activity.request':
            requests.push({ ...base, channel: record.channel, record_id: record.record_id, semantic_key: record.semantic_key, product: record.product,
              surface: record.surface, execution_host: record.execution_host, session_hash: record.session_hash, session_identity: record.session_identity,
              parent_session_hash: record.parent_session_hash, model_requested: record.model_requested, model_actual: record.model_actual,
              started_at: record.started_at, ended_at: record.ended_at, input_fresh_tokens: record.tokens.input_fresh, input_cached_tokens: record.tokens.input_cached,
              input_cache_write_tokens: record.tokens.input_cache_write, output_tokens: record.tokens.output, reasoning_tokens: record.tokens.reasoning,
              tool_calls: record.tool_calls, tools: tx.json((record.tools ?? null) as postgres.JSONValue), project_hash: record.project_hash, client_version: record.client_version,
              latency_ms: record.latency_ms, outcome: record.outcome, parser_version: record.parser_version });
            break;
          case 'account.usage_bucket':
            usage.push({ ...base, report_source: record.report_source, bucket_start: record.bucket_start, bucket_end: record.bucket_end,
              provider_timezone: record.provider_timezone, ...record.dimensions, dimensions_hash: hash(record.dimensions), ...record.measures,
              provider_event_id: record.provider_event_id, provider_refreshed_at: record.provider_refreshed_at });
            break;
          case 'allowance.reading': {
            // The readings ledger has no basis column: a reading is always provider-reported.
            const { basis: _basis, ...reading } = base;
            readings.push({ ...reading, reader: record.reader, meter_key: record.meter_key, label: record.label, kind: record.kind, value: record.value,
              unit: record.unit, capacity: record.capacity, window_minutes: record.window_minutes, window_started_at: record.window_started_at,
              resets_at: record.resets_at, raw_window_id: record.raw_window_id });
            break;
          }
          case 'money.entry':
            money.push({ ...base, entry_kind: record.entry_kind, amount: record.amount, unit: record.unit, source_unit: record.source_unit,
              price_basis: record.price_basis, period_start: record.period_start, period_end: record.period_end,
              reference_kind: record.reference.kind, reference_key: record.reference.key, sku: record.sku, model: record.model });
            break;
        }
      }
      let acceptedRecords = 0;
      const insert = async (table: string, rows: Row[]) => {
        if (!rows.length) return;
        const inserted = await tx`INSERT INTO personal_hub.${tx(table)} ${tx(rows)} ON CONFLICT DO NOTHING RETURNING id`;
        acceptedRecords += inserted.length; duplicates += rows.length - inserted.length;
      };
      await insert('activity_requests', requests); await insert('account_usage_buckets', usage);
      await insert('allowance_readings', readings); await insert('money_entries', money);

      await tx`INSERT INTO personal_hub.companion_runs (id, install_id, run_id, started_at, finished_at, companion_version, settings_version, coverage,
          accepted_buckets, accepted_records, rejected_records)
        VALUES (${randomUUID()}, ${install.id}, ${envelope.run.run_id}, ${envelope.run.started_at}, ${envelope.run.finished_at}, ${envelope.run.companion_version},
          ${envelope.run.settings_version}, ${tx.json(envelope.coverage as postgres.JSONValue)}, ${acceptedBuckets}, ${acceptedRecords}, ${rejected.length})
        ON CONFLICT (run_id) DO UPDATE SET
          accepted_buckets = companion_runs.accepted_buckets + EXCLUDED.accepted_buckets,
          accepted_records = companion_runs.accepted_records + EXCLUDED.accepted_records,
          rejected_records = companion_runs.rejected_records + EXCLUDED.rejected_records,
          coverage = CASE WHEN jsonb_array_length(EXCLUDED.coverage) > 0 THEN EXCLUDED.coverage ELSE companion_runs.coverage END,
          finished_at = EXCLUDED.finished_at
        WHERE companion_runs.install_id = EXCLUDED.install_id`;
      await tx`UPDATE personal_hub.companion_installs SET companion_version = ${envelope.run.companion_version}, last_seen_at = now() WHERE id = ${install.id}`;
      if (envelope.coverage.length) {
        for (const binding of bindings.values()) {
          const entries = envelope.coverage.filter(entry => adapterProvider(entry.adapter) === binding.provider);
          if (!entries.length) continue;
          await tx`UPDATE personal_hub.telemetry_sources SET last_seen_at = now(), coverage = ${tx.json(sourceCoverage(entries, envelope.run.companion_version) as postgres.JSONValue)}
            WHERE id = ${binding.source_id}`;
        }
      }
      return { ok: true, schema_version: 2, run_id: envelope.run.run_id, accepted: { buckets: acceptedBuckets, records: acceptedRecords }, duplicates, rejected };
    });
  }

  async function collectionSettings() {
    const db = await sql();
    const global = await globalSettings(db);
    return { settings: mergeSettings(global.stored), settings_version: global.settings_version,
      latest_companion_version: global.latest_companion_version, updated_at: global.updated_at };
  }

  /** Replaces the global document; increments the shared settings version. */
  async function updateCollectionSettings(input: unknown) {
    const settings = collectionSettingsSchema.parse(input);
    const db = await sql();
    await db`UPDATE personal_hub.collection_settings SET settings = ${db.json(settings as postgres.JSONValue)} WHERE id = 1`;
    dashboardCache.invalidate();
    return { ok: true, settings_version: await bumpSettingsVersion(db) };
  }

  const semver = (value: string | null) => value?.match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1, 4).map(Number) ?? null;
  const behind = (current: string | null, latest: string | null) => {
    const a = semver(current), b = semver(latest);
    return !!a && !!b && (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2]))));
  };

  /** Installs with bindings, latest run, and applied settings version, for the Connections page. */
  async function listInstalls() {
    const db = await sql();
    const global = await globalSettings(db);
    const [installs, bindings, runs, activeV1] = await Promise.all([
      db`SELECT id, machine_label, kind, platform, arch, settings, paused, disabled, companion_version, created_at, last_seen_at, last_config_fetch_at
        FROM personal_hub.companion_installs ORDER BY created_at, id`,
      db`SELECT b.id, b.install_id, b.account_id, b.provider, b.identity_hash, b.identity_reset_at, b.enabled, b.source_id, s.last_seen_at, s.coverage, a.label AS account_label
        FROM personal_hub.companion_bindings b JOIN personal_hub.telemetry_sources s ON s.id = b.source_id JOIN personal_hub.usage_accounts a ON a.id = b.account_id
        ORDER BY b.created_at, b.id`,
      db`SELECT DISTINCT ON (install_id) install_id, run_id, started_at, finished_at, companion_version, settings_version, coverage,
          accepted_buckets, accepted_records, rejected_records, received_at
        FROM personal_hub.companion_runs ORDER BY install_id, finished_at DESC, received_at DESC`,
      db`SELECT id, account_id, machine_label, last_seen_at FROM personal_hub.telemetry_sources
        WHERE mode = 'local' AND NOT disabled AND last_seen_at > now() - interval '2 hours'`,
    ]);
    const result = installs.map(install => {
      const run = runs.find(r => r.install_id === install.id);
      const own = bindings.filter(b => b.install_id === install.id).map(b => ({ ...b,
        identity_state: b.identity_hash ? 'confirmed' : b.identity_reset_at ? 'reset' : 'unconfirmed',
        v1_active: activeV1.filter(v => v.account_id === b.account_id).map(v => ({ id: v.id, machine_label: v.machine_label, last_seen_at: v.last_seen_at })) }));
      return { ...install, bindings: own, latest_run: run ?? null,
        applied_settings_version: run ? Number(run.settings_version) : null,
        update_available: install.kind === 'companion' && behind(install.companion_version as string | null, global.latest_companion_version) };
    });
    return clone({ installs: result, settings: mergeSettings(global.stored), settings_version: global.settings_version,
      latest_companion_version: global.latest_companion_version, settings_updated_at: global.updated_at }) as InstallsSummary;
  }

  /** Pause, resume, disable, override, enable or disable a binding, approve a re-confirmed identity. */
  async function updateInstall(input: unknown) {
    const body = (input && typeof input === 'object' ? input : {}) as { id?: unknown; action?: unknown; binding_id?: unknown; settings?: unknown };
    const id = isUuid(body.id) ? body.id : null;
    if (!id) throw new RequestError('Invalid install');
    const bindingId = isUuid(body.binding_id) ? body.binding_id : null;
    const db = await sql();
    const action = String(body.action);
    if (action === 'pause' || action === 'resume') {
      await db`UPDATE personal_hub.companion_installs SET paused = ${action === 'pause'} WHERE id = ${id}`;
      await bumpSettingsVersion(db);
    } else if (action === 'disable') {
      await db.begin(async transaction => {
        const tx = transaction as unknown as Sql;
        await tx`UPDATE personal_hub.companion_installs SET disabled = true, paused = true WHERE id = ${id}`;
        await tx`UPDATE personal_hub.companion_bindings SET enabled = false WHERE install_id = ${id}`;
        await tx`UPDATE personal_hub.telemetry_sources SET disabled = true WHERE id IN (SELECT source_id FROM personal_hub.companion_bindings WHERE install_id = ${id})`;
      });
    } else if (action === 'override') {
      const override = installOverrideSchema.parse(body.settings ?? {});
      await db`UPDATE personal_hub.companion_installs SET settings = ${db.json(override as postgres.JSONValue)} WHERE id = ${id}`;
      await bumpSettingsVersion(db);
    } else if (action === 'binding_enable' || action === 'binding_disable') {
      if (!bindingId) throw new RequestError('Invalid binding');
      const enabled = action === 'binding_enable';
      await db.begin(async transaction => {
        const tx = transaction as unknown as Sql;
        const [binding] = await tx`UPDATE personal_hub.companion_bindings SET enabled = ${enabled} WHERE id = ${bindingId} AND install_id = ${id} RETURNING source_id`;
        if (!binding) throw new RequestError('Unknown binding', 404);
        await tx`UPDATE personal_hub.telemetry_sources SET disabled = ${!enabled} WHERE id = ${binding.source_id}`;
      });
      await bumpSettingsVersion(db);
    } else if (action === 'approve_identity') {
      if (!bindingId) throw new RequestError('Invalid binding');
      const [binding] = await db`UPDATE personal_hub.companion_bindings SET identity_hash = NULL, identity_reset_at = now()
        WHERE id = ${bindingId} AND install_id = ${id} RETURNING id`;
      if (!binding) throw new RequestError('Unknown binding', 404);
      await bumpSettingsVersion(db);
    } else throw new RequestError('Unknown action');
    dashboardCache.invalidate();
    return { ok: true };
  }

  async function loadDashboard() {
    const db = await sql();
    const [installs, ledgers, allowance] = await Promise.all([
      listInstalls(),
      db`SELECT
        (SELECT count(*)::int FROM personal_hub.activity_requests WHERE observed_at >= now() - interval '35 days') AS activity_requests,
        (SELECT count(*)::int FROM personal_hub.account_usage_buckets WHERE observed_at >= now() - interval '35 days') AS account_usage_buckets,
        (SELECT count(*)::int FROM personal_hub.allowance_readings WHERE observed_at >= now() - interval '35 days') AS allowance_readings,
        (SELECT count(*)::int FROM personal_hub.money_entries WHERE observed_at >= now() - interval '35 days') AS money_entries`,
      // Current reading per meter: reader rank, then the freshest observation within two hours of the newest.
      db`WITH ranked AS (
        SELECT r.account_id, r.meter_key, r.label, r.kind, r.value, r.unit, r.capacity, r.window_minutes, r.resets_at, r.reader, r.observed_at,
          row_number() OVER (PARTITION BY r.account_id, r.meter_key ORDER BY
            CASE r.reader WHEN 'statusline' THEN 1 WHEN 'embedded' THEN 2 WHEN 'web_backend' THEN 3 ELSE 0 END, r.observed_at DESC) AS rank,
          max(r.observed_at) OVER (PARTITION BY r.account_id, r.meter_key) AS newest
        FROM personal_hub.allowance_readings r
        JOIN personal_hub.companion_bindings b ON b.id = r.binding_id AND b.enabled
        JOIN personal_hub.companion_installs i ON i.id = b.install_id AND NOT i.disabled
        WHERE r.observed_at >= now() - interval '35 days')
        SELECT account_id, meter_key, label, kind, value, unit, capacity, window_minutes, resets_at, reader, observed_at FROM ranked
        WHERE observed_at >= newest - interval '2 hours' AND rank = (SELECT min(rank) FROM ranked x WHERE x.account_id = ranked.account_id AND x.meter_key = ranked.meter_key AND x.observed_at >= x.newest - interval '2 hours')
        ORDER BY account_id, meter_key`,
    ]);
    return clone({ ...installs, ledgers: ledgers[0], allowance, as_of: new Date().toISOString() });
  }
  const dashboardCache = readCache(30_000, loadDashboard);
  const usageDashboard = () => dashboardCache.get();

  /** Reconciliation is a query, never a write: account usage minus covered requests, per token class, labeled. */
  async function reconcile(accountId: string, start: string, end: string) {
    const db = await sql();
    const [requests] = await db.unsafe(`WITH canonical AS (
        SELECT DISTINCT ON (r.semantic_key) r.*
        FROM personal_hub.activity_requests r JOIN personal_hub.companion_bindings b ON b.id = r.binding_id AND b.enabled
        WHERE r.account_id = $1 AND r.observed_at >= $2 AND r.observed_at < $3
        ORDER BY r.semantic_key, ${CHANNEL_RANK}, ${IDENTITY_RANK}, r.observed_at DESC)
      SELECT count(*)::int AS requests, sum(input_fresh_tokens)::float8 AS input_fresh, sum(input_cached_tokens)::float8 AS input_cached,
        sum(input_cache_write_tokens)::float8 AS input_cache_write, sum(output_tokens)::float8 AS output, sum(total_tokens)::float8 AS total
      FROM canonical`, [accountId, start, end]);
    const [usage] = await db.unsafe(`WITH canonical AS (
        SELECT DISTINCT ON (u.report_source, u.bucket_start, u.bucket_end, u.dimensions_hash) u.*
        FROM personal_hub.account_usage_buckets u JOIN personal_hub.companion_bindings b ON b.id = u.binding_id AND b.enabled
        WHERE u.account_id = $1 AND u.bucket_start >= $2 AND u.bucket_end <= $3
        ORDER BY u.report_source, u.bucket_start, u.bucket_end, u.dimensions_hash, u.provider_refreshed_at DESC NULLS LAST, u.observed_at DESC)
      SELECT count(*)::int AS buckets, sum(requests)::float8 AS requests, sum(input_tokens)::float8 AS input, sum(cached_tokens)::float8 AS cached,
        sum(cache_write_tokens)::float8 AS cache_write, sum(output_tokens)::float8 AS output, sum(total_tokens)::float8 AS total
      FROM canonical`, [accountId, start, end]);
    const diff = (a: unknown, b: unknown) => (a === null || b === null ? null : Number(a) - Number(b));
    return clone({ account_id: accountId, window: { start, end },
      account_usage: { buckets: usage.buckets, requests: usage.requests, input: usage.input, cached: usage.cached, cache_write: usage.cache_write, output: usage.output, total: usage.total },
      covered_requests: { requests: requests.requests, input: requests.input_fresh, cached: requests.input_cached, cache_write: requests.input_cache_write, output: requests.output, total: requests.total },
      unattributed: { input: diff(usage.input, requests.input_fresh), cached: diff(usage.cached, requests.input_cached), cache_write: diff(usage.cache_write, requests.input_cache_write),
        output: diff(usage.output, requests.output), total: diff(usage.total, requests.total) },
      note: 'Unattributed account usage is reported as such; it is never allocated to a surface, converted from a percentage, or written into the request ledger.' });
  }

  /** The newest `observatory-v*` release tag, read from the public GitHub Releases API with the reset-feed rules. */
  async function syncCompanionRelease(fetcher: typeof fetch = fetch) {
    const db = await sql();
    const [lease] = await db`UPDATE personal_hub.collection_settings SET latest_companion_checked_at = now()
      WHERE id = 1 AND (latest_companion_checked_at IS NULL OR latest_companion_checked_at < now() - interval '30 minutes')
      RETURNING latest_companion_version, latest_companion_etag`;
    if (!lease) return { cached: true };
    try {
      const response = await fetcher('https://api.github.com/repos/joshgreenwell/ai-kits/releases?per_page=30', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PersonalObservatory/1.0 (release check)', ...(lease.latest_companion_etag ? { 'If-None-Match': lease.latest_companion_etag as string } : {}) },
        cache: 'no-store', signal: AbortSignal.timeout(15_000), redirect: 'error', credentials: 'omit',
      });
      if (response.status === 304) return { unchanged: true, latest_companion_version: lease.latest_companion_version };
      if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('empty_response');
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Error('response_too_large'); } chunks.push(value); }
      const releases = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      if (!Array.isArray(releases)) throw new Error('schema_changed');
      let latest: { version: string; parts: number[] } | null = null;
      for (const release of releases) {
        const item = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
        if (item.draft === true || item.prerelease === true || typeof item.tag_name !== 'string') continue;
        const match = /^observatory-v(\d+\.\d+\.\d+)$/.exec(item.tag_name);
        if (!match) continue;
        const parts = match[1].split('.').map(Number);
        if (!latest || behind(latest.version, match[1])) latest = { version: match[1], parts };
      }
      await db`UPDATE personal_hub.collection_settings SET latest_companion_version = ${latest?.version ?? (lease.latest_companion_version as string | null)},
        latest_companion_etag = ${response.headers.get('etag')} WHERE id = 1`;
      dashboardCache.invalidate();
      return { ok: true, latest_companion_version: latest?.version ?? null };
    } catch (error) {
      const message = error instanceof Error && /^(http_\d{3}|empty_response|response_too_large|schema_changed)$/.test(error.message) ? error.message
        : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : error instanceof SyntaxError ? 'invalid_json' : 'network_error';
      console.warn('Companion release check failed', { reason: message });
      return { ok: false, error: message, latest_companion_version: lease.latest_companion_version };
    }
  }

  return { issuePairingCode, pairInstall, companionInstall, companionConfig, createBinding, updateInstallSettings, confirmIdentity, ingestUsage,
    collectionSettings, updateCollectionSettings, listInstalls, updateInstall, usageDashboard, reconcile, syncCompanionRelease };
}

export const usageStore = createUsageStore();
