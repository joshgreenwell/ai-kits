import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { RequestError, stableJson } from './contracts';
import { readCache } from './read-cache';
import { collectionSettingsSchema, installOverrideSchema, mergeSettings, type CollectionSettings, type InstallOverride } from './companion-settings';
import { companionCapabilitiesSchema, type CompanionCapabilities } from './companion-capabilities';
import { readingFreshness } from './allowance-freshness';
import { projectRegistryMutationSchema } from './project-registry';
import { knowledgeSourceMutationSchema } from './knowledge-source-registry';
import {
  adapterProvider, bindingRequestSchema, contentSubject, identityRequestSchema, isBrowserAdapter, issuePairingCodeSchema,
  normalizePairingCode, pairRequestSchema, PAIRING_ALPHABET, type AdapterCoverage, type InvalidUsageRecord, type RejectionReason, type UsageEnvelope, type UsageRecord,
} from './usage-contract';

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const dimensionsSubject = (dimensions: Record<string, unknown>) => {
  const { pricing, ...legacy } = dimensions;
  if (!pricing || Object.values(pricing as Record<string, unknown>).every(value => value === null)) return legacy;
  return dimensions;
};

export type CompanionInstallRow = {
  id: string; kind: 'companion' | 'browser'; machine_label: string; platform: string; arch: string;
  paused: boolean; settings: InstallOverride;
};
type BindingRow = {
  id: string; account_id: string; provider: string; source_id: string; enabled: boolean;
  identity_hash: string | null; identity_reset_at: string | null;
};

/**
 * Accepted, duplicate, and rejected counts per record type; `invalid` collects records that failed to
 * parse, and `rejected:<reason>` keys split the rejections by their closed reason.
 */
export type AcceptedByType = Record<string, { accepted: number; duplicate: number; rejected: number } & Record<string, number>>;
export type BindingSummary = { id: string; install_id: string; account_id: string; account_label: string; provider: string; identity_hash: string | null;
  identity_reset_at: string | null; enabled: boolean; source_id: string; last_seen_at: string | null; coverage: unknown;
  identity_state: 'confirmed' | 'unconfirmed' | 'reset'; v1_active: { id: string; machine_label: string; last_seen_at: string | null }[];
  // Newest ledger evidence per binding. `last_seen_at` above is collector contact and moves on coverage-only receipts; these do not.
  last_observation: { allowance: { observed_at: string; resets_at: string | null; reader: string } | null; requests: string | null };
  last_received: { allowance: string | null };
  // Another enabled binding of the same install and provider holds this binding's non-null hash, so the
  // companion cannot tell their readings apart (`confirmIdentity` refuses new duplicates; older rows may still hold one).
  duplicate_identity: boolean };
/** The last capability document and whether it still describes the running build. */
export type CapabilitiesSummary = {
  document: CompanionCapabilities | null; digest: string | null; previous_digest: string | null;
  reported_at: string | null; changed_at: string | null;
  /** Current only when the document names the version the last envelope carried and was reported within one cadence of that envelope. */
  current: boolean; reason: 'never_reported' | 'version_mismatch' | 'stale' | null;
};
/** The installed schedule as last reported, judged against the desired cadence at read time. */
export type ScheduleSummary = {
  mechanism: string | null; state: 'not_installed' | 'installed' | 'interval_mismatch' | 'unreadable' | 'unknown';
  installed_interval_minutes: number | null; desired_interval_minutes: number; pending: boolean; config_dir_pinned: boolean | null;
  /** Which cadence freshness verdicts use: the installed interval when a current report carries one, else the desired one. */
  cadence_basis: 'installed' | 'desired'; effective_cadence_minutes: number;
};
/** One rung per fact the server actually holds; "off" and "blocked" stay distinct from "failed". */
export type HealthSummary = {
  pairing: 'paired';
  binding: 'none' | 'partial' | 'complete';
  identity: 'none' | 'confirmed' | 'unconfirmed' | 'reset' | 'changed' | 'mixed';
  /** `unknown` when the last run carried no adapter coverage rows at all. */
  execution: 'never' | 'unknown' | 'ok' | 'partial' | 'failed' | 'off' | 'blocked';
  records: 'none' | 'fresh' | 'stale' | 'observed';
  coverage_only: boolean; overdue: boolean; last_contact_at: string | null;
};
export type InstallSummary = { id: string; machine_label: string; kind: 'companion' | 'browser'; platform: string; arch: string; settings: InstallOverride;
  paused: boolean; disabled: boolean; companion_version: string | null; created_at: string; last_seen_at: string | null; last_config_fetch_at: string | null;
  bindings: BindingSummary[]; applied_settings_version: number | null; update_available: boolean;
  cadence_minutes: CollectionSettings['cadence_minutes']; last_run_at: string | null; accepted_by_type: AcceptedByType;
  capabilities: CapabilitiesSummary; schedule: ScheduleSummary; health: HealthSummary;
  latest_run: { run_id: string; started_at: string; finished_at: string; companion_version: string; settings_version: number; coverage: AdapterCoverage[];
    accepted_buckets: number; accepted_records: number; rejected_records: number; accepted_by_type: AcceptedByType; received_at: string } | null };
export type InstallsSummary = { installs: InstallSummary[]; settings: CollectionSettings; settings_version: number; latest_companion_version: string | null; settings_updated_at: string };

const CHANNEL_RANK = "CASE channel WHEN 'provider_api' THEN 0 WHEN 'app_server' THEN 1 WHEN 'local_file' THEN 2 WHEN 'local_db' THEN 2 ELSE 3 END";
const IDENTITY_RANK = "CASE session_identity WHEN 'provider' THEN 0 WHEN 'derived' THEN 1 ELSE 2 END";
// Closed resource.access enums, so every tally states its full denominator even at zero.
const ACCESS_KINDS = ['read', 'search', 'write', 'unknown'] as const;
const EVIDENCE_BASES = ['explicit_argument', 'connector', 'indirect_shell', 'unknown'] as const;
const EVENT_OUTCOMES = ['succeeded', 'failed', 'denied', 'cancelled', 'unknown'] as const;
const tally = <K extends string>(keys: readonly K[], row: Row | undefined, prefix: string) =>
  Object.fromEntries(keys.map(key => [key, Number(row?.[`${prefix}${key}`] ?? 0)])) as Record<K, number>;

export type KnowledgeSourceSummary = {
  source_id: string | null; identity_ids: string[]; label: string | null; resource_key: string | null;
  install_id: string | null; machine_label: string | null;
  accesses: number; distinct_invocations: number; distinct_sessions: number; distinct_agents: number;
  by_access_kind: Record<typeof ACCESS_KINDS[number], number>; by_evidence_basis: Record<typeof EVIDENCE_BASES[number], number>;
  by_outcome: Record<typeof EVENT_OUTCOMES[number], number>;
  top_tools: { tool_name: string | null; tool_class: string; invocations: number }[];
  first_observed: string | null; last_observed: string | null;
};

/** Injectable database provider keeps the store testable against a disposable cluster. */
/** A capability report is current only while it names the running build and is no older than one cadence before the last envelope. */
function capabilitiesSummary(stored: Omit<CapabilitiesSummary, 'current' | 'reason'>, companionVersion: string | null, lastReceivedAt: string | undefined, cadenceMinutes: number): CapabilitiesSummary {
  if (!stored.document || !stored.reported_at) return { ...stored, current: false, reason: 'never_reported' };
  if (companionVersion && stored.document.companion_version !== companionVersion) return { ...stored, current: false, reason: 'version_mismatch' };
  if (lastReceivedAt && Date.parse(stored.reported_at) < Date.parse(lastReceivedAt) - cadenceMinutes * 60_000) return { ...stored, current: false, reason: 'stale' };
  return { ...stored, current: true, reason: null };
}

/** Pending is decided here against the desired cadence, never trusted from the companion's own flag at report time. */
function scheduleSummary(capabilities: CapabilitiesSummary, desired: number): ScheduleSummary {
  const reported = capabilities.current ? capabilities.document?.schedule ?? null : null;
  const installed = reported?.installed_interval_minutes ?? null;
  const pending = reported !== null && (reported.state === 'interval_mismatch' || (installed !== null && installed !== desired));
  const basis: ScheduleSummary['cadence_basis'] = installed !== null ? 'installed' : 'desired';
  return { mechanism: reported?.mechanism ?? null, state: reported ? (pending ? 'interval_mismatch' : reported.state) : 'unknown',
    installed_interval_minutes: installed, desired_interval_minutes: desired, pending, config_dir_pinned: reported?.config_dir_pinned ?? null,
    cadence_basis: basis, effective_cadence_minutes: installed ?? desired };
}

const executionBlocked = new Set(['prerequisite_missing', 'credential_unavailable', 'identity_changed', 'rate_limited']);
/** Providers a browser install can bind today: only the Claude collector exists (`browser/claude-quota/`), so its binding rung is judged over Claude alone. */
const BROWSER_COLLECTOR_PROVIDERS = new Set<string>(['claude']);
function healthSummary({ kind, bindings, run, capabilities, schedule, effective, lastSeenAt, now }: {
  kind: InstallSummary['kind']; bindings: BindingSummary[]; run: InstallSummary['latest_run']; capabilities: CapabilitiesSummary; schedule: ScheduleSummary;
  effective: CollectionSettings; lastSeenAt: string | null; now: number;
}): HealthSummary {
  const enabledProviders = (['claude', 'codex', 'cursor'] as const)
    .filter(provider => effective.providers[provider] && (kind !== 'browser' || BROWSER_COLLECTOR_PROVIDERS.has(provider)));
  const bound = enabledProviders.filter(provider => bindings.some(b => b.provider === provider && b.enabled));
  const binding: HealthSummary['binding'] = bound.length === 0 ? 'none' : bound.length === enabledProviders.length ? 'complete' : 'partial';
  const reported = capabilities.current ? new Map(capabilities.document?.bindings.map(b => [b.binding_id, b]) ?? []) : new Map();
  const identities = bindings.filter(b => b.enabled).map(b => reported.get(b.id)?.identity === 'changed' ? 'changed' : b.identity_state);
  const identity: HealthSummary['identity'] = identities.length === 0 ? 'none' : new Set(identities).size === 1 ? identities[0] as HealthSummary['identity'] : 'mixed';
  // Execution is judged only over adapters this build implements whose mode is on; stubs and switched-off adapters never count.
  const implemented = new Set(capabilities.current ? capabilities.document?.adapters.filter(a => a.implemented).map(a => a.adapter) ?? [] : []);
  const counted = (run?.coverage ?? []).filter(entry =>
    (capabilities.current ? implemented.has(entry.adapter) : entry.parser_version !== '0')
    && entry.state !== 'disabled_by_setting' && entry.state !== 'denied_locally'
    && !(entry.state === 'prerequisite_missing' && (entry.detail_code === 'no_binding' || entry.detail_code === 'not_implemented')));
  const execution: HealthSummary['execution'] = !run ? 'never'
    : (run.coverage ?? []).length === 0 ? 'unknown'
    : counted.length === 0 ? ((run.coverage ?? []).some(entry => executionBlocked.has(entry.state)) ? 'blocked' : 'off')
    : counted.some(entry => entry.state === 'failed') ? 'failed'
    : counted.some(entry => entry.state !== 'ok') ? 'partial' : 'ok';
  const newestAllowance = bindings.map(b => b.last_observation.allowance).filter(Boolean).sort((a, b) => Date.parse(b!.observed_at) - Date.parse(a!.observed_at))[0] ?? null;
  const newestRequest = bindings.map(b => b.last_observation.requests).filter(Boolean).sort((a, b) => Date.parse(b!) - Date.parse(a!))[0] ?? null;
  const records: HealthSummary['records'] = newestAllowance
    ? (readingFreshness({ observedAt: newestAllowance.observed_at, resetsAt: newestAllowance.resets_at, now, cadenceMinutes: schedule.effective_cadence_minutes }).stale ? 'stale' : 'fresh')
    : newestRequest ? 'observed' : 'none';
  const coverageOnly = !!run && Number(run.accepted_buckets) === 0
    && Object.values(run.accepted_by_type ?? {}).every(counts => Number(counts.accepted ?? 0) === 0);
  const contacts = [lastSeenAt, capabilities.reported_at].filter((value): value is string => !!value).map(Date.parse);
  const lastContact = contacts.length ? new Date(Math.max(...contacts)).toISOString() : null;
  const overdue = lastContact !== null
    && readingFreshness({ observedAt: lastContact, resetsAt: null, now, cadenceMinutes: schedule.effective_cadence_minutes }).stale;
  return { pairing: 'paired', binding, identity, execution, records, coverage_only: coverageOnly, overdue, last_contact_at: lastContact };
}

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
      // Every path that assigns an identity takes the same parent-row lock. This
      // serializes sibling checks across server instances without preventing old
      // duplicate rows from remaining visible for explicit reconfirmation.
      await tx`SELECT id FROM personal_hub.companion_installs WHERE id = ${install.id} FOR UPDATE`;
      await tx`INSERT INTO personal_hub.usage_accounts (id, provider, label) VALUES (${data.account_id}, ${data.provider}, ${data.account_label}) ON CONFLICT DO NOTHING`;
      const [account] = await tx`SELECT provider FROM personal_hub.usage_accounts WHERE id = ${data.account_id}`;
      if (account.provider !== data.provider) throw new RequestError('Account belongs to another provider', 409);
      const [existing] = await tx`SELECT id AS binding_id, account_id, provider, enabled, identity_hash FROM personal_hub.companion_bindings
        WHERE install_id = ${install.id} AND account_id = ${data.account_id}`;
      if (existing) return { created: false, binding: clone(existing) };
      if (data.identity_hash !== null) {
        const [sibling] = await tx`SELECT id FROM personal_hub.companion_bindings
          WHERE install_id = ${install.id} AND provider = ${data.provider} AND identity_hash = ${data.identity_hash}`;
        if (sibling) throw new RequestError('identity_taken: another binding of this install already holds that identity', 409);
      }
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

  /**
   * Sets a binding's identity when it is unset or was reset by the UI; a different existing hash is a
   * conflict. A hash another binding of the same install and provider already holds is refused too
   * (`identity_taken`): one account identity binds once per install, so readings can never be split
   * between two bindings that claim the same sign-in.
   */
  async function confirmIdentity(install: CompanionInstallRow, bindingId: string, input: unknown) {
    const data = identityRequestSchema.parse(input);
    if (!isUuid(bindingId)) throw new RequestError('Unknown binding', 404);
    const db = await sql();
    return db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      await tx`SELECT id FROM personal_hub.companion_installs WHERE id = ${install.id} FOR UPDATE`;
      const [binding] = await tx`SELECT id, provider, identity_hash, enabled FROM personal_hub.companion_bindings WHERE id = ${bindingId} AND install_id = ${install.id}`;
      if (!binding) throw new RequestError('Unknown binding', 404);
      if (binding.identity_hash === null) {
        const [sibling] = await tx`SELECT id FROM personal_hub.companion_bindings
          WHERE install_id = ${install.id} AND provider = ${binding.provider} AND id <> ${bindingId} AND identity_hash = ${data.identity_hash}`;
        if (sibling) throw new RequestError('identity_taken: another binding of this install already holds that identity', 409);
        await tx`UPDATE personal_hub.companion_bindings SET identity_hash = ${data.identity_hash}, identity_reset_at = NULL WHERE id = ${bindingId}`;
      } else if (binding.identity_hash !== data.identity_hash) {
        throw new RequestError('The binding identity changed; approve the new identity in the Observatory first', 409);
      }
      return { ok: true, binding_id: bindingId, identity_hash: data.identity_hash, enabled: binding.enabled as boolean };
    });
  }

  function rejection(install: CompanionInstallRow, binding: BindingRow | undefined, record: UsageRecord): RejectionReason | null {
    if (!binding) return 'binding_not_owned';
    if (!binding.enabled) return 'binding_not_enabled';
    if (binding.identity_hash === null && binding.identity_reset_at !== null) return 'identity_changed';
    if (isBrowserAdapter(record.adapter) !== (install.kind === 'browser')) return 'adapter_not_allowed_for_install';
    if (install.kind === 'browser' && record.record_type !== 'allowance.reading') return 'record_type_not_allowed_for_install';
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

  /** One transaction: buckets into v1, records into the seven v2 ledgers, coverage into the run record. */
  async function ingestUsage(install: CompanionInstallRow, envelope: UsageEnvelope, invalid: InvalidUsageRecord[] = []) {
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

      const rejected: { record_id: string; reason: RejectionReason }[] = [...invalid];
      // Per-type receipts, so "accepted uploads" is visible per reading kind. Buckets are v1 rows and stay in accepted_buckets.
      const byType: AcceptedByType = {};
      const count = (type: string, outcome: string, n: number) => {
        if (!n) return;
        const entry = (byType[type] ??= { accepted: 0, duplicate: 0, rejected: 0 });
        entry[outcome] = (entry[outcome] ?? 0) + n;
      };
      count('invalid', 'rejected', invalid.length); count('invalid', 'rejected:invalid', invalid.length);
      const requests: Row[] = [], usage: Row[] = [], readings: Row[] = [], money: Row[] = [];
      const agentEvents: Row[] = [], toolEvents: Row[] = [], resourceAccesses: Row[] = [];
      const projectIdentities = new Map<string, Row>();
      const observeProjectIdentity = (record: Extract<UsageRecord, { record_type: 'activity.request' }>, binding: BindingRow) => {
        const project = record.project?.key
          ? record.project
          : record.project === undefined && record.project_hash
            ? { key: record.project_hash, basis: 'working_directory' as const }
            : null;
        if (!project?.key || (project.basis !== 'working_directory' && project.basis !== 'native')) return;
        const firstSeen = record.ended_at ?? record.observed_at;
        const scope = project.basis === 'working_directory'
          ? `${install.id}:${project.key}`
          : `${binding.account_id}:${binding.provider}:${project.key}`;
        const existing = projectIdentities.get(scope);
        if (existing) {
          const before = Date.parse(existing.first_seen as string), after = Date.parse(existing.last_seen as string);
          const observed = Date.parse(firstSeen);
          if (observed < before) existing.first_seen = firstSeen;
          if (observed > after) existing.last_seen = firstSeen;
          return;
        }
        projectIdentities.set(scope, {
          id: randomUUID(), basis: project.basis, evidence_key: project.key,
          install_id: project.basis === 'working_directory' ? install.id : null,
          account_id: project.basis === 'native' ? binding.account_id : null,
          provider: project.basis === 'native' ? binding.provider : null,
          first_seen: firstSeen, last_seen: firstSeen,
        });
      };
      // A resource identity is the configured key as seen by this install. The companion keeps
      // each envelope single-version per key, so the version on the newest sighting is current.
      const resourceIdentities = new Map<string, Row>();
      const observeResourceIdentity = (record: Extract<UsageRecord, { record_type: 'resource.access' }>) => {
        const scope = `${install.id}:${record.resource_key}`;
        const existing = resourceIdentities.get(scope);
        if (existing) {
          const before = Date.parse(existing.first_seen as string), after = Date.parse(existing.last_seen as string);
          const observed = Date.parse(record.observed_at);
          if (observed < before) existing.first_seen = record.observed_at;
          if (observed >= after) {
            existing.last_seen = record.observed_at;
            existing.configuration_version = record.configuration_version ?? existing.configuration_version;
          }
          return;
        }
        resourceIdentities.set(scope, {
          id: randomUUID(), install_id: install.id, resource_key: record.resource_key,
          configuration_version: record.configuration_version, first_seen: record.observed_at, last_seen: record.observed_at,
        });
      };
      for (const record of envelope.records) {
        const binding = bindings.get(record.binding_id);
        const reason = rejection(install, binding, record);
        if (reason) { rejected.push({ record_id: record.record_id, reason }); count(record.record_type, 'rejected', 1); count(record.record_type, `rejected:${reason}`, 1); continue; }
        const base = { id: randomUUID(), account_id: binding!.account_id, binding_id: record.binding_id, provider: binding!.provider,
          adapter: record.adapter, observed_at: record.observed_at, basis: record.basis, content_hash: hash(contentSubject(record)) };
        switch (record.record_type) {
          case 'activity.request':
            observeProjectIdentity(record, binding!);
            requests.push({ ...base, channel: record.channel, record_id: record.record_id, semantic_key: record.semantic_key, product: record.product,
              surface: record.surface, execution_host: record.execution_host, session_hash: record.session_hash, session_identity: record.session_identity,
              parent_session_hash: record.parent_session_hash, model_requested: record.model_requested, model_actual: record.model_actual,
              started_at: record.started_at, ended_at: record.ended_at, input_fresh_tokens: record.tokens.input_fresh, input_cached_tokens: record.tokens.input_cached,
              input_cache_write_tokens: record.tokens.input_cache_write, output_tokens: record.tokens.output, reasoning_tokens: record.tokens.reasoning,
              reported_total_tokens: record.token_accounting?.reported_total ?? null,
              unclassified_tokens: record.token_accounting?.unclassified ?? null, token_state: record.token_accounting?.composition_state ?? null,
              reasoning_effort: record.pricing?.reasoning_effort ?? null, service_tier: record.pricing?.service_tier ?? null,
              speed: record.pricing?.speed ?? null, context_window_tokens: record.pricing?.context_window_tokens ?? null,
              cache_write_ttl: record.pricing?.cache_write_ttl ?? null,
              agent_key: record.agent?.key ?? null, agent_identity_basis: record.agent?.identity_basis ?? null,
              parent_agent_key: record.agent?.parent_key ?? null, parent_agent_identity_basis: record.agent?.parent_identity_basis ?? null,
              agent_class: record.agent?.class ?? null, agent_name: record.agent?.name ?? null, agent_depth: record.agent?.depth ?? null,
              tool_calls: record.tool_calls, tools: tx.json((record.tools ?? null) as postgres.JSONValue), project_hash: record.project_hash, client_version: record.client_version,
              project_key: record.project?.key ?? null, project_basis: record.project?.basis ?? null,
              latency_ms: record.latency_ms, outcome: record.outcome, parser_version: record.parser_version });
            break;
          case 'account.usage_bucket': {
            const { pricing, ...legacyDimensions } = record.dimensions;
            usage.push({ ...base, report_source: record.report_source, bucket_start: record.bucket_start, bucket_end: record.bucket_end,
              provider_timezone: record.provider_timezone, ...legacyDimensions,
              reasoning_effort: pricing?.reasoning_effort ?? null, service_tier: pricing?.service_tier ?? null,
              speed: pricing?.speed ?? null, context_window_tokens: pricing?.context_window_tokens ?? null,
              cache_write_ttl: pricing?.cache_write_ttl ?? null,
              dimensions_hash: hash(dimensionsSubject(record.dimensions)), ...record.measures,
              unclassified_tokens: record.token_accounting?.unclassified ?? null, token_state: record.token_accounting?.composition_state ?? null,
              provider_event_id: record.provider_event_id, provider_refreshed_at: record.provider_refreshed_at });
            break;
          }
          case 'allowance.reading':
            // Meter key, label, window, reset anchor, and raw window id are stored as the producer sent them.
            readings.push({ ...base, reader: record.reader, meter_key: record.meter_key, label: record.label, kind: record.kind, value: record.value,
              unit: record.unit, capacity: record.capacity, window_minutes: record.window_minutes, window_started_at: record.window_started_at,
              resets_at: record.resets_at, raw_window_id: record.raw_window_id });
            break;
          case 'money.entry':
            money.push({ ...base, entry_kind: record.entry_kind, amount: record.amount, unit: record.unit, source_unit: record.source_unit,
              price_basis: record.price_basis, period_start: record.period_start, period_end: record.period_end,
              reference_kind: record.reference.kind, reference_key: record.reference.key, sku: record.sku, model: record.model });
            break;
          case 'agent.event':
            agentEvents.push({ ...base, channel: record.channel, record_id: record.record_id, semantic_key: record.semantic_key,
              event_kind: record.event_kind, session_hash: record.session_hash, agent_key: record.agent.key,
              agent_identity_basis: record.agent.identity_basis, parent_agent_key: record.agent.parent_key,
              parent_agent_identity_basis: record.agent.parent_identity_basis, agent_class: record.agent.class,
              agent_name: record.agent.name, agent_depth: record.agent.depth, tool_invocation_key: record.tool_invocation_key,
              outcome: record.outcome, parser_version: record.parser_version });
            break;
          case 'tool.event':
            toolEvents.push({ ...base, channel: record.channel, record_id: record.record_id, semantic_key: record.semantic_key,
              invocation_key: record.invocation_key, event_kind: record.event_kind, session_hash: record.session_hash,
              caller_request_key: record.caller_request_key, caller_agent_key: record.caller_agent_key,
              parent_invocation_key: record.parent_invocation_key, tool_name: record.tool.name,
              tool_namespace: record.tool.namespace, tool_class: record.tool.class, outcome: record.outcome,
              parser_version: record.parser_version });
            break;
          case 'resource.access':
            observeResourceIdentity(record);
            resourceAccesses.push({ ...base, channel: record.channel, record_id: record.record_id, semantic_key: record.semantic_key,
              invocation_key: record.invocation_key, resource_key: record.resource_key,
              configuration_version: record.configuration_version, access_kind: record.access_kind,
              evidence_basis: record.evidence_basis, outcome: record.outcome, parser_version: record.parser_version });
            break;
        }
      }
      let acceptedRecords = 0;
      const workingDirectoryIdentities = [...projectIdentities.values()].filter(row => row.basis === 'working_directory');
      if (workingDirectoryIdentities.length) {
        await tx`INSERT INTO personal_hub.usage_project_identities ${tx(workingDirectoryIdentities)}
          ON CONFLICT (install_id, evidence_key) WHERE basis = 'working_directory' DO UPDATE SET
            first_seen = least(usage_project_identities.first_seen, EXCLUDED.first_seen),
            last_seen = greatest(usage_project_identities.last_seen, EXCLUDED.last_seen)`;
      }
      const nativeIdentities = [...projectIdentities.values()].filter(row => row.basis === 'native');
      if (nativeIdentities.length) {
        await tx`INSERT INTO personal_hub.usage_project_identities ${tx(nativeIdentities)}
          ON CONFLICT (account_id, provider, evidence_key) WHERE basis = 'native' DO UPDATE SET
            first_seen = least(usage_project_identities.first_seen, EXCLUDED.first_seen),
            last_seen = greatest(usage_project_identities.last_seen, EXCLUDED.last_seen)`;
      }
      if (resourceIdentities.size) {
        // The latest upload names the configuration the install currently classifies under, even
        // when it replays older transcripts, so a non-null version always replaces the stored one.
        await tx`INSERT INTO personal_hub.usage_knowledge_source_identities ${tx([...resourceIdentities.values()])}
          ON CONFLICT (install_id, resource_key) DO UPDATE SET
            first_seen = least(usage_knowledge_source_identities.first_seen, EXCLUDED.first_seen),
            last_seen = greatest(usage_knowledge_source_identities.last_seen, EXCLUDED.last_seen),
            configuration_version = coalesce(EXCLUDED.configuration_version, usage_knowledge_source_identities.configuration_version)`;
      }
      const insert = async (table: string, type: UsageRecord['record_type'], rows: Row[]) => {
        if (!rows.length) return;
        const inserted = await tx`INSERT INTO personal_hub.${tx(table)} ${tx(rows)} ON CONFLICT DO NOTHING RETURNING id`;
        acceptedRecords += inserted.length; duplicates += rows.length - inserted.length;
        count(type, 'accepted', inserted.length); count(type, 'duplicate', rows.length - inserted.length);
      };
      await insert('activity_requests', 'activity.request', requests); await insert('account_usage_buckets', 'account.usage_bucket', usage);
      await insert('allowance_readings', 'allowance.reading', readings); await insert('money_entries', 'money.entry', money);
      await insert('agent_events', 'agent.event', agentEvents); await insert('tool_events', 'tool.event', toolEvents);
      await insert('resource_accesses', 'resource.access', resourceAccesses);

      // The bodies of one run accumulate: counters add up, per-type counts merge key-wise, and coverage
      // is replaced only by a body that carries some.
      await tx`INSERT INTO personal_hub.companion_runs (id, install_id, run_id, started_at, finished_at, companion_version, settings_version, coverage,
          accepted_buckets, accepted_records, rejected_records, accepted_by_type)
        VALUES (${randomUUID()}, ${install.id}, ${envelope.run.run_id}, ${envelope.run.started_at}, ${envelope.run.finished_at}, ${envelope.run.companion_version},
          ${envelope.run.settings_version}, ${tx.json(envelope.coverage as postgres.JSONValue)}, ${acceptedBuckets}, ${acceptedRecords}, ${rejected.length},
          ${tx.json(byType as postgres.JSONValue)})
        ON CONFLICT (run_id) DO UPDATE SET
          accepted_buckets = companion_runs.accepted_buckets + EXCLUDED.accepted_buckets,
          accepted_records = companion_runs.accepted_records + EXCLUDED.accepted_records,
          rejected_records = companion_runs.rejected_records + EXCLUDED.rejected_records,
          accepted_by_type = (
            SELECT coalesce(jsonb_object_agg(totals.type, totals.counts), '{}'::jsonb) FROM (
              SELECT pairs.type, jsonb_object_agg(pairs.outcome, pairs.total) AS counts FROM (
                SELECT entry.type, entry.outcome, sum(entry.count)::int AS total FROM (
                  SELECT t.key AS type, o.key AS outcome, o.value::int AS count
                  FROM jsonb_each(companion_runs.accepted_by_type) t CROSS JOIN LATERAL jsonb_each_text(t.value) o
                  UNION ALL
                  SELECT t.key, o.key, o.value::int
                  FROM jsonb_each(EXCLUDED.accepted_by_type) t CROSS JOIN LATERAL jsonb_each_text(t.value) o
                ) entry GROUP BY entry.type, entry.outcome
              ) pairs GROUP BY pairs.type
            ) totals),
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

  /** Stores what a companion build can do; a changed digest keeps the previous one and when it flipped. */
  async function reportCapabilities(install: CompanionInstallRow, input: unknown) {
    const document = companionCapabilitiesSchema.parse(input);
    const db = await sql();
    const [row] = await db`UPDATE personal_hub.companion_installs SET
        capabilities = ${db.json(document as postgres.JSONValue)},
        capabilities_previous_digest = CASE WHEN capabilities_digest IS DISTINCT FROM ${document.capabilities_digest} THEN capabilities_digest ELSE capabilities_previous_digest END,
        capabilities_changed_at = CASE WHEN capabilities_digest IS DISTINCT FROM ${document.capabilities_digest} THEN now() ELSE capabilities_changed_at END,
        capabilities_digest = ${document.capabilities_digest},
        capabilities_reported_at = now()
      WHERE id = ${install.id} RETURNING capabilities_reported_at`;
    dashboardCache.invalidate();
    return { ok: true, capabilities_digest: document.capabilities_digest, reported_at: row.capabilities_reported_at };
  }

  async function collectionSettings() {
    const db = await sql();
    const global = await globalSettings(db);
    return { settings: mergeSettings(global.stored), settings_version: global.settings_version,
      latest_companion_version: global.latest_companion_version, updated_at: global.updated_at };
  }

  /** Privacy-safe project registry plus distinct collection and mapping coverage. */
  async function listProjects() {
    const db = await sql();
    const projects = await db`SELECT id, label, created_at, updated_at
      FROM personal_hub.usage_projects ORDER BY lower(label), created_at, id`;
    const identities = await db`SELECT i.id, i.basis, i.evidence_key, i.first_seen, i.last_seen,
        i.install_id, ci.machine_label, i.account_id, ua.label AS account_label, i.provider,
        current_mapping.project_id, project.label AS project_label
      FROM personal_hub.usage_project_identities i
      LEFT JOIN personal_hub.companion_installs ci ON ci.id = i.install_id
      LEFT JOIN personal_hub.usage_accounts ua ON ua.id = i.account_id
      LEFT JOIN LATERAL (
        SELECT revision.project_id FROM personal_hub.usage_project_mapping_revisions revision
        WHERE revision.identity_id = i.id
        ORDER BY revision.revision_order DESC LIMIT 1
      ) current_mapping ON true
      LEFT JOIN personal_hub.usage_projects project ON project.id = current_mapping.project_id
      ORDER BY i.last_seen DESC, i.id`;
    const [observations = {}] = await db`SELECT count(*)::int AS request_observations
      FROM personal_hub.activity_requests`;
    const [evidence = {}] = await db`SELECT
        count(*)::int AS canonical_requests,
        count(*) FILTER (WHERE project_basis IN ('native','working_directory') AND project_key IS NOT NULL)::int AS with_identity,
        count(*) FILTER (WHERE project_basis = 'none')::int AS no_project,
        count(*) FILTER (WHERE project_basis = 'unknown')::int AS unknown
      FROM personal_hub.activity_request_project_resolution`;
    const resolved = { project: 0, unassigned: 0, no_project: 0, unknown: 0 };
    for (const row of await db`SELECT project_state, count(*)::int AS requests
      FROM personal_hub.activity_request_project_resolution GROUP BY project_state`) {
      resolved[row.project_state as keyof typeof resolved] = Number(row.requests);
    }
    const mapped = identities.filter(identity => identity.project_id !== null).length;
    return clone({ projects, identities, coverage: {
      evidence: {
        request_observations: Number(observations.request_observations ?? 0),
        canonical_requests: Number(evidence.canonical_requests ?? 0),
        with_identity: Number(evidence.with_identity ?? 0),
        no_project: Number(evidence.no_project ?? 0),
        unknown: Number(evidence.unknown ?? 0),
      },
      mapping: { identities: identities.length, mapped, unassigned: identities.length - mapped },
      resolved_requests: resolved,
    } });
  }

  /** Appends mapping revisions so historical resolution changes without raw fact edits. */
  async function updateProjects(input: unknown) {
    const data = projectRegistryMutationSchema.parse(input);
    const db = await sql();
    const result = await db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      if (data.action === 'create') {
        const id = randomUUID();
        await tx`INSERT INTO personal_hub.usage_projects (id, label) VALUES (${id}, ${data.label})`;
        return { ok: true, action: data.action, project_id: id, label: data.label };
      }
      if (data.action === 'rename') {
        const changed = await tx`UPDATE personal_hub.usage_projects
          SET label = ${data.label}, updated_at = now() WHERE id = ${data.project_id} RETURNING id`;
        if (!changed.length) throw new RequestError('Unknown project', 404);
        return { ok: true, action: data.action, project_id: data.project_id, label: data.label };
      }
      if (data.action === 'map') {
        const project = await tx`SELECT id FROM personal_hub.usage_projects WHERE id = ${data.project_id}`;
        if (!project.length) throw new RequestError('Unknown project', 404);
      }
      const identityIds = [...data.identity_ids].sort();
      for (const identityId of identityIds) {
        const identity = await tx`SELECT id FROM personal_hub.usage_project_identities WHERE id = ${identityId} FOR UPDATE`;
        if (!identity.length) throw new RequestError('Unknown project identity', 404);
      }
      for (const identityId of identityIds) {
        await tx`INSERT INTO personal_hub.usage_project_mapping_revisions (id, identity_id, project_id, changed_at)
          VALUES (${randomUUID()}, ${identityId}, ${data.action === 'map' ? data.project_id : null}, DEFAULT)`;
      }
      return { ok: true, action: data.action, identities: data.identity_ids.length,
        project_id: data.action === 'map' ? data.project_id : null };
    });
    dashboardCache.invalidate();
    return result;
  }

  /** Privacy-safe knowledge-source registry: install-scoped resource keys, labels, and counts that disclose overlap. */
  async function listKnowledgeSources() {
    const db = await sql();
    const sources = await db`SELECT id, label, created_at, updated_at
      FROM personal_hub.usage_knowledge_sources ORDER BY lower(label), created_at, id`;
    const identities = await db`WITH sightings AS (
        SELECT identity_id,
          count(*) FILTER (WHERE current_configuration)::int AS accesses,
          count(DISTINCT invocation_key) FILTER (WHERE current_configuration)::int AS distinct_invocations,
          count(*) FILTER (WHERE NOT current_configuration)::int AS earlier_configuration_accesses
        FROM personal_hub.resource_access_source_resolution WHERE identity_id IS NOT NULL GROUP BY identity_id
      )
      SELECT i.id, i.install_id, ci.machine_label, i.resource_key, i.configuration_version, i.first_seen, i.last_seen,
        current_mapping.source_id, source.label AS source_label,
        coalesce(sightings.accesses, 0)::int AS accesses,
        coalesce(sightings.distinct_invocations, 0)::int AS distinct_invocations,
        coalesce(sightings.earlier_configuration_accesses, 0)::int AS earlier_configuration_accesses
      FROM personal_hub.usage_knowledge_source_identities i
      LEFT JOIN personal_hub.companion_installs ci ON ci.id = i.install_id
      LEFT JOIN LATERAL (
        SELECT revision.source_id FROM personal_hub.usage_knowledge_source_mapping_revisions revision
        WHERE revision.identity_id = i.id
        ORDER BY revision.revision_order DESC LIMIT 1
      ) current_mapping ON true
      LEFT JOIN personal_hub.usage_knowledge_sources source ON source.id = current_mapping.source_id
      LEFT JOIN sightings ON sightings.identity_id = i.id
      ORDER BY i.last_seen DESC, i.id`;
    // One bucket per mapped source and one per unassigned identity, over current-configuration rows only.
    // Sessions, agents, and tools come from the canonical invocation row joined by invocation_key; an
    // access without a retained invocation contributes nothing to those counts.
    const summaries = await db`WITH accesses AS (
        SELECT a.account_id, a.invocation_key, a.access_kind, a.evidence_basis, a.outcome, a.observed_at, a.source_id,
          CASE WHEN a.source_id IS NULL THEN a.identity_id END AS identity_id
        FROM personal_hub.resource_access_source_resolution a
        WHERE a.identity_id IS NOT NULL AND a.current_configuration
      ), invocations AS (
        SELECT DISTINCT ON (t.account_id, t.invocation_key)
          t.account_id, t.invocation_key, t.session_hash, t.caller_agent_key, t.tool_name, t.tool_class
        FROM personal_hub.tool_events t WHERE t.event_kind = 'invocation'
        ORDER BY t.account_id, t.invocation_key, t.observed_at DESC, t.received_at DESC, t.id DESC
      ), joined AS (
        SELECT a.*, t.session_hash, t.caller_agent_key, t.tool_name, t.tool_class
        FROM accesses a LEFT JOIN invocations t ON t.account_id = a.account_id AND t.invocation_key = a.invocation_key
      ), tools AS (
        SELECT source_id, identity_id, tool_name, tool_class, count(DISTINCT invocation_key)::int AS invocations,
          row_number() OVER (PARTITION BY source_id, identity_id ORDER BY count(DISTINCT invocation_key) DESC, tool_class, tool_name) AS rank
        FROM joined WHERE tool_class IS NOT NULL GROUP BY source_id, identity_id, tool_name, tool_class
      )
      SELECT j.source_id, j.identity_id,
        count(*)::int AS accesses,
        count(DISTINCT j.invocation_key)::int AS distinct_invocations,
        count(DISTINCT j.session_hash)::int AS distinct_sessions,
        count(DISTINCT j.caller_agent_key)::int AS distinct_agents,
        count(*) FILTER (WHERE j.access_kind = 'read')::int AS kind_read,
        count(*) FILTER (WHERE j.access_kind = 'search')::int AS kind_search,
        count(*) FILTER (WHERE j.access_kind = 'write')::int AS kind_write,
        count(*) FILTER (WHERE j.access_kind = 'unknown')::int AS kind_unknown,
        count(*) FILTER (WHERE j.evidence_basis = 'explicit_argument')::int AS basis_explicit_argument,
        count(*) FILTER (WHERE j.evidence_basis = 'connector')::int AS basis_connector,
        count(*) FILTER (WHERE j.evidence_basis = 'indirect_shell')::int AS basis_indirect_shell,
        count(*) FILTER (WHERE j.evidence_basis = 'unknown')::int AS basis_unknown,
        count(*) FILTER (WHERE j.outcome = 'succeeded')::int AS outcome_succeeded,
        count(*) FILTER (WHERE j.outcome = 'failed')::int AS outcome_failed,
        count(*) FILTER (WHERE j.outcome = 'denied')::int AS outcome_denied,
        count(*) FILTER (WHERE j.outcome = 'cancelled')::int AS outcome_cancelled,
        count(*) FILTER (WHERE j.outcome = 'unknown')::int AS outcome_unknown,
        min(j.observed_at) AS first_observed, max(j.observed_at) AS last_observed,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('tool_name', t.tool_name, 'tool_class', t.tool_class, 'invocations', t.invocations) ORDER BY t.rank), '[]'::jsonb)
          FROM tools t WHERE t.source_id IS NOT DISTINCT FROM j.source_id AND t.identity_id IS NOT DISTINCT FROM j.identity_id AND t.rank <= 5) AS top_tools
      FROM joined j GROUP BY j.source_id, j.identity_id`;
    const [observations = {}] = await db`SELECT count(*)::int AS access_rows FROM personal_hub.resource_accesses`;
    const [evidence = {}] = await db`SELECT
        count(*)::int AS canonical_accesses,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration)::int AS current_configuration_accesses,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND NOT current_configuration)::int AS earlier_configuration_accesses,
        count(DISTINCT invocation_key) FILTER (WHERE identity_id IS NOT NULL AND current_configuration)::int AS distinct_invocations,
        (SELECT count(*)::int FROM (
          SELECT 1 FROM personal_hub.resource_access_source_resolution
          WHERE identity_id IS NOT NULL AND current_configuration GROUP BY account_id, invocation_key HAVING count(*) > 1) overlap) AS overlapping_invocations,
        count(*) FILTER (WHERE source_state = 'source')::int AS resolved_source,
        count(*) FILTER (WHERE source_state = 'unassigned')::int AS resolved_unassigned,
        count(*) FILTER (WHERE source_state = 'unknown')::int AS resolved_unknown,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND access_kind = 'read')::int AS kind_read,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND access_kind = 'search')::int AS kind_search,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND access_kind = 'write')::int AS kind_write,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND access_kind = 'unknown')::int AS kind_unknown,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND evidence_basis = 'explicit_argument')::int AS basis_explicit_argument,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND evidence_basis = 'connector')::int AS basis_connector,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND evidence_basis = 'indirect_shell')::int AS basis_indirect_shell,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND evidence_basis = 'unknown')::int AS basis_unknown,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND outcome = 'succeeded')::int AS outcome_succeeded,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND outcome = 'failed')::int AS outcome_failed,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND outcome = 'denied')::int AS outcome_denied,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND outcome = 'cancelled')::int AS outcome_cancelled,
        count(*) FILTER (WHERE identity_id IS NOT NULL AND current_configuration AND outcome = 'unknown')::int AS outcome_unknown
      FROM personal_hub.resource_access_source_resolution`;
    // Detection coverage is what each install last reported for the resource dimension of an adapter:
    // state and detail code only, so the inspected/eligible ratio stays on the machine.
    const detection = await db`SELECT DISTINCT ON (run.install_id, entry->>'adapter')
        run.install_id, ci.machine_label, entry->>'adapter' AS adapter,
        capability->>'state' AS state, capability->>'detail_code' AS detail_code, run.finished_at
      FROM personal_hub.companion_runs run
      JOIN personal_hub.companion_installs ci ON ci.id = run.install_id
      CROSS JOIN LATERAL jsonb_array_elements(run.coverage) AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(entry->'capabilities') = 'array' THEN entry->'capabilities' ELSE '[]'::jsonb END) AS capability
      WHERE capability->>'dimension' = 'resource'
      ORDER BY run.install_id, entry->>'adapter', run.finished_at DESC, run.received_at DESC`;
    const sourceById = new Map(sources.map(source => [source.id as string, source]));
    const identityById = new Map(identities.map(identity => [identity.id as string, identity]));
    const bucketKey = (sourceId: unknown, identityId: unknown) => (sourceId ? `source:${sourceId}` : `identity:${identityId}`);
    const summaryByBucket = new Map(summaries.map(row => [bucketKey(row.source_id, row.identity_id), row]));
    const summarize = (sourceId: string | null, identityId: string | null): KnowledgeSourceSummary => {
      const row = summaryByBucket.get(bucketKey(sourceId, identityId));
      const identity = identityId ? identityById.get(identityId) : undefined;
      return {
        source_id: sourceId,
        identity_ids: sourceId ? identities.filter(item => item.source_id === sourceId).map(item => item.id as string) : [identityId!],
        label: sourceId ? (sourceById.get(sourceId)?.label as string) ?? null : null,
        resource_key: (identity?.resource_key as string) ?? null, install_id: (identity?.install_id as string) ?? null,
        machine_label: (identity?.machine_label as string) ?? null,
        accesses: Number(row?.accesses ?? 0), distinct_invocations: Number(row?.distinct_invocations ?? 0),
        distinct_sessions: Number(row?.distinct_sessions ?? 0), distinct_agents: Number(row?.distinct_agents ?? 0),
        by_access_kind: tally(ACCESS_KINDS, row, 'kind_'), by_evidence_basis: tally(EVIDENCE_BASES, row, 'basis_'),
        by_outcome: tally(EVENT_OUTCOMES, row, 'outcome_'),
        top_tools: (row?.top_tools ?? []) as KnowledgeSourceSummary['top_tools'],
        first_observed: (row?.first_observed as string) ?? null, last_observed: (row?.last_observed as string) ?? null,
      };
    };
    const perSource = [
      ...sources.map(source => summarize(source.id as string, null)),
      ...identities.filter(identity => identity.source_id === null).map(identity => summarize(null, identity.id as string)),
    ];
    const mapped = identities.filter(identity => identity.source_id !== null).length;
    return clone({ sources, identities, per_source: perSource, coverage: {
      evidence: {
        access_rows: Number(observations.access_rows ?? 0),
        canonical_accesses: Number(evidence.canonical_accesses ?? 0),
        current_configuration_accesses: Number(evidence.current_configuration_accesses ?? 0),
        earlier_configuration_accesses: Number(evidence.earlier_configuration_accesses ?? 0),
        distinct_invocations: Number(evidence.distinct_invocations ?? 0),
        overlapping_invocations: Number(evidence.overlapping_invocations ?? 0),
        by_access_kind: tally(ACCESS_KINDS, evidence, 'kind_'), by_evidence_basis: tally(EVIDENCE_BASES, evidence, 'basis_'),
        by_outcome: tally(EVENT_OUTCOMES, evidence, 'outcome_'),
        note: 'accesses count resource rows and distinct_invocations count tool calls: one call touching several sources or nested roots'
          + ' yields one row per source, so per-source totals overlap by accesses minus distinct_invocations. Only rows classified under'
          + ' the configuration each install most recently applied are counted; earlier-configuration rows are listed separately because'
          + ' transcripts deleted before a configuration change cannot be re-verified.',
      },
      mapping: { identities: identities.length, mapped, unassigned: identities.length - mapped },
      resolved: { source: Number(evidence.resolved_source ?? 0), unassigned: Number(evidence.resolved_unassigned ?? 0), unknown: Number(evidence.resolved_unknown ?? 0) },
      detection,
    } });
  }

  /** Appends mapping revisions so historical resolution changes without raw fact edits. */
  async function updateKnowledgeSources(input: unknown) {
    const data = knowledgeSourceMutationSchema.parse(input);
    const db = await sql();
    const result = await db.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      if (data.action === 'create') {
        const id = randomUUID();
        await tx`INSERT INTO personal_hub.usage_knowledge_sources (id, label) VALUES (${id}, ${data.label})`;
        return { ok: true, action: data.action, source_id: id, label: data.label };
      }
      if (data.action === 'rename') {
        const changed = await tx`UPDATE personal_hub.usage_knowledge_sources
          SET label = ${data.label}, updated_at = now() WHERE id = ${data.source_id} RETURNING id`;
        if (!changed.length) throw new RequestError('Unknown knowledge source', 404);
        return { ok: true, action: data.action, source_id: data.source_id, label: data.label };
      }
      if (data.action === 'map') {
        const source = await tx`SELECT id FROM personal_hub.usage_knowledge_sources WHERE id = ${data.source_id}`;
        if (!source.length) throw new RequestError('Unknown knowledge source', 404);
      }
      const identityIds = [...data.identity_ids].sort();
      for (const identityId of identityIds) {
        const identity = await tx`SELECT id FROM personal_hub.usage_knowledge_source_identities WHERE id = ${identityId} FOR UPDATE`;
        if (!identity.length) throw new RequestError('Unknown knowledge source identity', 404);
      }
      for (const identityId of identityIds) {
        await tx`INSERT INTO personal_hub.usage_knowledge_source_mapping_revisions (id, identity_id, source_id, changed_at)
          VALUES (${randomUUID()}, ${identityId}, ${data.action === 'map' ? data.source_id : null}, DEFAULT)`;
      }
      return { ok: true, action: data.action, identities: data.identity_ids.length,
        source_id: data.action === 'map' ? data.source_id : null };
    });
    dashboardCache.invalidate();
    return result;
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

  /**
   * Installs with bindings, latest run, and applied settings version, for the Connections page.
   * Each binding also carries the newest observation in its ledgers, read by `binding_id` through the
   * `(binding_id, observed_at DESC)` indexes, so freshness is judged on evidence rather than on contact,
   * and `duplicate_identity` when an enabled sibling of the same provider holds the same hash.
   */
  async function listInstalls() {
    const db = await sql();
    const global = await globalSettings(db);
    const [installs, bindings, runs, activeV1] = await Promise.all([
      db`SELECT id, machine_label, kind, platform, arch, settings, paused, disabled, companion_version, created_at, last_seen_at, last_config_fetch_at,
          capabilities, capabilities_digest, capabilities_previous_digest, capabilities_reported_at, capabilities_changed_at
        FROM personal_hub.companion_installs ORDER BY created_at, id`,
      db`SELECT b.id, b.install_id, b.account_id, b.provider, b.identity_hash, b.identity_reset_at, b.enabled, b.source_id, s.last_seen_at, s.coverage, a.label AS account_label,
          allowance.observed_at AS allowance_observed_at, allowance.resets_at AS allowance_resets_at, allowance.reader AS allowance_reader,
          (SELECT max(r.received_at) FROM personal_hub.allowance_readings r WHERE r.binding_id = b.id) AS allowance_received_at,
          requests.observed_at AS requests_observed_at,
          EXISTS (SELECT 1 FROM personal_hub.companion_bindings o
            WHERE o.install_id = b.install_id AND o.provider = b.provider AND o.id <> b.id AND o.enabled
              AND o.identity_hash IS NOT NULL AND o.identity_hash = b.identity_hash) AS duplicate_identity
        FROM personal_hub.companion_bindings b JOIN personal_hub.telemetry_sources s ON s.id = b.source_id JOIN personal_hub.usage_accounts a ON a.id = b.account_id
        LEFT JOIN LATERAL (SELECT r.observed_at, r.resets_at, r.reader FROM personal_hub.allowance_readings r
          WHERE r.binding_id = b.id ORDER BY r.observed_at DESC LIMIT 1) allowance ON true
        LEFT JOIN LATERAL (SELECT r.observed_at FROM personal_hub.activity_requests r
          WHERE r.binding_id = b.id ORDER BY r.observed_at DESC LIMIT 1) requests ON true
        ORDER BY b.created_at, b.id`,
      db`SELECT DISTINCT ON (install_id) install_id, run_id, started_at, finished_at, companion_version, settings_version, coverage,
          accepted_buckets, accepted_records, rejected_records, accepted_by_type, received_at
        FROM personal_hub.companion_runs ORDER BY install_id, finished_at DESC, received_at DESC`,
      db`SELECT id, account_id, machine_label, last_seen_at FROM personal_hub.telemetry_sources
        WHERE mode = 'local' AND NOT disabled AND last_seen_at > now() - interval '2 hours'`,
    ]);
    const now = Date.now();
    const result = installs.map(({ capabilities: rawCapabilities, capabilities_digest, capabilities_previous_digest, capabilities_reported_at, capabilities_changed_at, ...install }) => {
      const run = runs.find(r => r.install_id === install.id);
      const effective = mergeSettings(global.stored, install.settings as InstallOverride);
      const capabilities = capabilitiesSummary({ document: rawCapabilities as CompanionCapabilities | null, digest: capabilities_digest as string | null,
        previous_digest: capabilities_previous_digest as string | null, reported_at: capabilities_reported_at as string | null,
        changed_at: capabilities_changed_at as string | null }, install.companion_version as string | null, run?.received_at as string | undefined, effective.cadence_minutes);
      const schedule = scheduleSummary(capabilities, effective.cadence_minutes);
      const own = bindings.filter(b => b.install_id === install.id).map(({ allowance_observed_at, allowance_resets_at, allowance_reader, allowance_received_at, requests_observed_at, ...b }) => ({ ...b,
        identity_state: b.identity_hash ? 'confirmed' : b.identity_reset_at ? 'reset' : 'unconfirmed',
        v1_active: activeV1.filter(v => v.account_id === b.account_id).map(v => ({ id: v.id, machine_label: v.machine_label, last_seen_at: v.last_seen_at })),
        last_observation: {
          allowance: allowance_observed_at ? { observed_at: allowance_observed_at, resets_at: allowance_resets_at ?? null, reader: allowance_reader } : null,
          requests: requests_observed_at ?? null },
        last_received: { allowance: allowance_received_at ?? null } }));
      const health = healthSummary({ kind: install.kind as InstallSummary['kind'], bindings: own as unknown as BindingSummary[], run: (run ?? null) as unknown as InstallSummary['latest_run'], capabilities, schedule, effective, lastSeenAt: install.last_seen_at as string | null, now });
      return { ...install, bindings: own, latest_run: run ?? null,
        applied_settings_version: run ? Number(run.settings_version) : null,
        cadence_minutes: effective.cadence_minutes,
        last_run_at: run?.finished_at ?? null, accepted_by_type: run?.accepted_by_type ?? {},
        capabilities, schedule, health,
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

  /**
   * The v2-only read model behind /api/usage-v2 (the live page's cards read the compatibility view,
   * which unions the v1 browser samples). The current reading per (account, meter) is the newest
   * observation from an enabled binding of a live install whose reader is one this store recognizes
   * (`statusline`, `oauth_usage`, `app_server`, `usage_summary`, `embedded`, `web_backend`,
   * `dashboard_rpc`); an exact tie falls to reader rank in that order, and an unknown reader never
   * outranks a known one. Freshness is the shared rule at the binding's cadence.
   */
  async function loadDashboard() {
    const db = await sql();
    const now = Date.now();
    const [installs, ledgers, current] = await Promise.all([
      listInstalls(),
      db`SELECT
        (SELECT count(*)::int FROM personal_hub.activity_requests WHERE observed_at >= now() - interval '35 days') AS activity_requests,
        (SELECT count(*)::int FROM personal_hub.account_usage_buckets WHERE observed_at >= now() - interval '35 days') AS account_usage_buckets,
        (SELECT count(*)::int FROM personal_hub.allowance_readings WHERE observed_at >= now() - interval '35 days') AS allowance_readings,
        (SELECT count(*)::int FROM personal_hub.money_entries WHERE observed_at >= now() - interval '35 days') AS money_entries,
        (SELECT count(*)::int FROM personal_hub.agent_events WHERE observed_at >= now() - interval '35 days') AS agent_events,
        (SELECT count(*)::int FROM personal_hub.tool_events WHERE observed_at >= now() - interval '35 days') AS tool_events,
        (SELECT count(*)::int FROM personal_hub.resource_accesses WHERE observed_at >= now() - interval '35 days') AS resource_accesses`,
      db`WITH ranked AS (
        SELECT r.account_id, r.meter_key, r.label, r.kind, r.value, r.unit, r.capacity, r.window_minutes, r.window_started_at, r.resets_at,
          r.raw_window_id, r.reader, r.basis, r.observed_at, r.binding_id, i.settings AS install_settings,
          row_number() OVER (PARTITION BY r.account_id, r.meter_key ORDER BY r.observed_at DESC,
            CASE r.reader
              WHEN 'statusline' THEN 1
              WHEN 'oauth_usage' THEN 2
              WHEN 'app_server' THEN 3
              WHEN 'usage_summary' THEN 4
              WHEN 'embedded' THEN 5
              WHEN 'web_backend' THEN 6
              WHEN 'dashboard_rpc' THEN 7
            END, r.received_at DESC, r.id DESC) AS rank
        FROM personal_hub.allowance_readings r
        JOIN personal_hub.companion_bindings b ON b.id = r.binding_id AND b.enabled
        JOIN personal_hub.companion_installs i ON i.id = b.install_id AND NOT i.disabled
        WHERE r.observed_at >= now() - interval '35 days' AND r.reader IN (
          'statusline', 'oauth_usage', 'app_server', 'usage_summary', 'embedded', 'web_backend', 'dashboard_rpc'))
        SELECT account_id, meter_key, label, kind, value, unit, capacity, window_minutes, window_started_at, resets_at, raw_window_id, reader, basis,
          observed_at, binding_id, install_settings
        FROM ranked WHERE rank = 1 ORDER BY account_id, meter_key`,
    ]);
    const stored = (await globalSettings(db)).stored;
    // The driver returns timestamptz columns as Date objects; the shared rule takes instants.
    const instant = (value: unknown) => (value === null || value === undefined ? null : new Date(value as string).getTime());
    const allowance = current.map(({ install_settings, ...row }) => {
      const cadence = mergeSettings(stored, install_settings as InstallOverride).cadence_minutes;
      const freshness = readingFreshness({ observedAt: instant(row.observed_at)!, resetsAt: instant(row.resets_at), now, cadenceMinutes: cadence });
      return { ...row, cadence_minutes: cadence, stale: freshness.stale, stale_reason: freshness.reason, age_minutes: Math.round(freshness.ageMinutes) };
    });
    return clone({ ...installs, ledgers: ledgers[0], allowance, as_of: new Date(now).toISOString() });
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
        sum(input_cache_write_tokens)::float8 AS input_cache_write, sum(output_tokens)::float8 AS output, sum(observed_total_tokens)::float8 AS total
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
    collectionSettings, updateCollectionSettings, reportCapabilities, listProjects, updateProjects, listKnowledgeSources, updateKnowledgeSources, listInstalls, updateInstall,
    usageDashboard, reconcile, syncCompanionRelease };
}

export const usageStore = createUsageStore();
