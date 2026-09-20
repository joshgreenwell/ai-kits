/**
 * Pure logic of the v2 browser collector, shared by the service worker and the Node tests.
 * Nothing here touches `chrome.*`, `fetch`, or storage: the worker feeds state in and
 * writes results out, so every rule below is unit-testable against the server contract
 * (`lib/usage-contract.ts`). Only `crypto.subtle` and `crypto.randomUUID` are used, which
 * exist in the extension service worker and in Node.
 */
export const VERSION = '2.0.0';
export const COLLECTOR_VERSION = 'browser-' + VERSION;
export const PARSER_VERSION = '2.0.0+browser1';
export const PROVIDER = 'claude', ADAPTER = 'claude_browser', CHANNEL = 'browser_session', READER = 'web_backend';
export const OUTBOX_LIMIT = 168;
export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,79}$/;
export const INSTALL_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The three requests one reading costs in the Claude tab: account, organizations, usage. */
export const PROBE_REQUESTS = 3;

/** A failure with a stable code the health view can name, beside the message a person reads. */
export class CollectorError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// ---- pairing -------------------------------------------------------------------------------

/** Eight characters from the unambiguous alphabet, however the person typed them. */
export function normalizePairingCode(code) {
  const normalized = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length !== 8) throw new CollectorError('invalid_code', 'The pairing code has eight characters.');
  return normalized.slice(0, 4) + '-' + normalized.slice(4);
}

/** The server's `platforms` enum from a user agent; the arch is never reported by a browser. */
export function detectPlatform(userAgent) {
  const ua = String(userAgent ?? '');
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS/i.test(ua)) return 'darwin';
  if (/Linux|CrOS/i.test(ua)) return 'linux';
  return 'unknown';
}

/** `POST /api/v1/companion/pair` body (`pairRequestSchema`), kind `browser`. */
export function pairRequest({ code, machineLabel, platform }) {
  const label = String(machineLabel ?? '').trim().slice(0, 100) || 'Browser profile';
  return { code: normalizePairingCode(code), machine_label: label, kind: 'browser', platform, arch: 'unknown' };
}

/** The install id and key the pair route returns once. Anything else is refused. */
export function parsePairResponse(json) {
  const id = json?.install_id, key = json?.key;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id) || typeof key !== 'string' || !INSTALL_KEY_PATTERN.test(key)) {
    throw new CollectorError('pair_response', 'The Observatory returned no usable install key.');
  }
  return { id, key };
}

// ---- identity and binding ------------------------------------------------------------------

const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }

/**
 * The same identity hash the companion posts for a Claude sign-in:
 * `sha256(stableJson([provider, account]))`, where the account is the claude.ai account uuid.
 * A stable JSON of two strings is exactly `JSON.stringify`, so the browser and the companion
 * agree on the hash and the Observatory treats them as the same signed-in account.
 */
export function identityHash(provider, account) { return sha256Hex(JSON.stringify([String(provider), String(account)])); }

/** `POST /api/v1/companion/bindings` body (`bindingRequestSchema`). The label never carries an email. */
export function bindingRequest({ accountId, accountLabel, identityHash: hash }) {
  const id = String(accountId ?? '').trim();
  if (!ACCOUNT_ID_PATTERN.test(id)) throw new CollectorError('invalid_account_id', 'The Observatory account id is lowercase letters, digits, and dashes (2 to 80 characters).');
  const label = String(accountLabel ?? '').trim().slice(0, 80) || id;
  if (/@/.test(label)) throw new CollectorError('label_is_email', 'Use a label, not an email address.');
  return { account_id: id, provider: PROVIDER, account_label: label, identity_hash: hash ?? null };
}

// ---- readings and the envelope -------------------------------------------------------------

/** Mirrors the companion's `window_label`: v1 labels for the pooled windows, title case for a scoped one. */
export function windowLabel(key) {
  if (key === 'five_hour') return 'Claude · 5h';
  if (key === 'seven_day') return 'Claude · weekly';
  if (key === 'extra_usage') return 'Claude · extra usage';
  const scope = key.replace(/^seven_day_/, '').split('_').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  return 'Claude · weekly · ' + scope;
}

/** A stable record id per (binding, reader, meter, observation) so a retried body is a duplicate, never a second reading. */
export async function recordId(bindingId, meterKey, observedAt) {
  const digest = await sha256Hex(`${bindingId}\n${CHANNEL}\n${READER}:${meterKey}:${observedAt}`);
  const variant = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  const h = digest.slice(0, 12) + '5' + digest.slice(13, 16) + variant + digest.slice(17, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** One `allowance.reading` from one normalized window (`normalize.js` output). Percent, window, and reset are carried untouched. */
export async function allowanceRecord(bindingId, quota) {
  return {
    record_id: await recordId(bindingId, quota.window_key, quota.observed_at), binding_id: bindingId,
    adapter: ADAPTER, channel: CHANNEL, observed_at: quota.observed_at, basis: 'reported', parser_version: PARSER_VERSION,
    record_type: 'allowance.reading', meter_key: quota.window_key, label: windowLabel(quota.window_key),
    kind: 'percent_used', value: quota.used_percent, unit: 'percent', capacity: null,
    window_minutes: quota.window_minutes, window_started_at: null, resets_at: quota.resets_at,
    reader: READER, raw_window_id: quota.window_key,
  };
}

/** The `claude_browser` coverage row; `capabilities` names the allowance dimension so the site can badge it. */
export function coverageEntry({ state, detailCode = null, recordsEmitted = 0, malformed = 0, probeRequests = PROBE_REQUESTS, durationMs = 0 }) {
  const allowanceState = state === 'ok' ? 'complete' : state === 'disabled_by_setting' ? 'disabled_by_setting' : 'unsupported';
  return { adapter: ADAPTER, state, detail_code: detailCode, stores_discovered: 0, files: 0, bytes_read: 0,
    records_emitted: recordsEmitted, malformed, rejected_by_server: 0, duration_ms: Math.max(0, Math.round(durationMs)),
    cursor_state: state === 'ok' ? 'complete' : 'unknown', probe_requests: probeRequests, parser_version: PARSER_VERSION,
    capabilities: [{ dimension: 'allowance', state: allowanceState, detail_code: detailCode }] };
}

/**
 * Envelope v2 for `POST /api/v1/usage`: the run header, no buckets (a browser install may not
 * send any), one reading per recognized window, and the adapter's coverage. Nothing from the
 * tab beyond the percentages and reset anchors reaches this body.
 */
export async function buildEnvelope({ bindingId, quotas, startedAt, finishedAt, platform, settingsVersion = 0, runId = crypto.randomUUID(), durationMs = 0 }) {
  const records = [];
  for (const quota of quotas) records.push(await allowanceRecord(bindingId, quota));
  return { schema_version: 2,
    run: { run_id: runId, started_at: startedAt, finished_at: finishedAt, companion_version: COLLECTOR_VERSION, platform, arch: 'unknown', settings_version: settingsVersion },
    buckets: [], records,
    coverage: [coverageEntry({ state: 'ok', recordsEmitted: records.length, durationMs })] };
}

/** A coverage-only envelope that states why no reading was produced; it is contact, never a reading. */
export function failureEnvelope({ startedAt, finishedAt, platform, settingsVersion = 0, code, runId = crypto.randomUUID(), durationMs = 0 }) {
  const detail = FAILURE_COVERAGE[code] ?? { state: 'failed', detailCode: 'read_failed' };
  return { schema_version: 2,
    run: { run_id: runId, started_at: startedAt, finished_at: finishedAt, companion_version: COLLECTOR_VERSION, platform, arch: 'unknown', settings_version: settingsVersion },
    buckets: [], records: [], coverage: [coverageEntry({ ...detail, malformed: code === 'no_windows' ? 1 : 0, probeRequests: code === 'no_tab' ? 0 : PROBE_REQUESTS, durationMs })] };
}
const FAILURE_COVERAGE = {
  no_tab: { state: 'prerequisite_missing', detailCode: 'no_tab' },
  sign_in: { state: 'credential_unavailable', detailCode: 'sign_in_required' },
  account_mismatch: { state: 'identity_changed', detailCode: 'account_mismatch' },
  org_unavailable: { state: 'identity_changed', detailCode: 'organization_unavailable' },
  no_windows: { state: 'failed', detailCode: 'unrecognized_shape' },
  shape: { state: 'failed', detailCode: 'unrecognized_shape' },
};

// ---- settings gate -------------------------------------------------------------------------

/**
 * What the install's config document (`GET /api/v1/companion/config`) allows. The store merges
 * the global settings, the install override, and the install's own pause into `settings`, so
 * `settings.paused` covers disabled-by-kill-switch and paused-in-Connections; the provider
 * switch and the binding's own enabled flag are honoured too. No document means no gate.
 */
export function settingsGate(config, bindingId) {
  const cadence = [15, 30, 60].includes(config?.settings?.cadence_minutes) ? config.settings.cadence_minutes : 60;
  if (!config) return { collect: true, reason: null, cadenceMinutes: cadence, serverIdentityHash: undefined };
  const binding = Array.isArray(config.bindings) ? config.bindings.find(b => b.binding_id === bindingId) : undefined;
  const serverIdentityHash = binding ? binding.identity_hash ?? null : undefined;
  if (config.settings?.paused === true) return { collect: false, reason: 'paused', cadenceMinutes: cadence, serverIdentityHash };
  if (config.settings?.providers && config.settings.providers[PROVIDER] === false) return { collect: false, reason: 'provider_off', cadenceMinutes: cadence, serverIdentityHash };
  if (binding && binding.enabled === false) return { collect: false, reason: 'binding_disabled', cadenceMinutes: cadence, serverIdentityHash };
  if (!binding) return { collect: false, reason: 'binding_missing', cadenceMinutes: cadence, serverIdentityHash };
  return { collect: true, reason: null, cadenceMinutes: cadence, serverIdentityHash };
}

// ---- outbox --------------------------------------------------------------------------------

/**
 * WEB-6: what to do with the queued body after one attempt. A server or network fault keeps
 * the body and stops the drain (5xx, 429, 408, no response); an invalid key stops the drain
 * without dropping anything (401, 403); any other 4xx is a permanently rejected body, which is
 * dropped so it can no longer block the readings behind it.
 */
export function uploadDisposition(status) {
  if (status === null || status === undefined || !Number.isFinite(status)) return 'retain';
  if (status >= 200 && status < 300) return 'done';
  if (status === 401 || status === 403) return 'stop_auth';
  if (status === 408 || status === 429 || status >= 500) return 'retain';
  if (status >= 400) return 'drop';
  return 'retain';
}

/** The observation a queued body carries, for the error it leaves behind when dropped. */
export function bodyObservedAt(body) {
  if (typeof body?.observed_at === 'string') return body.observed_at;
  const first = Array.isArray(body?.records) ? body.records[0] : undefined;
  return first?.observed_at ?? body?.run?.finished_at ?? null;
}

/** A bounded queue that keeps the newest bodies and their real capture times. */
export function enqueue(queue, body) { return [...(Array.isArray(queue) ? queue : []), body].slice(-OUTBOX_LIMIT); }

/**
 * Drains a queue oldest first through `send(body) -> { status, receipt }` (a thrown error is a
 * network fault). Returns the remaining queue, every receipt delivered, the bodies dropped with
 * their status and observation, and why the drain stopped, if it did.
 */
export async function drainOutbox(queue, send) {
  const remaining = [...(Array.isArray(queue) ? queue : [])], delivered = [], dropped = [];
  let stopped = null;
  while (remaining.length) {
    let outcome;
    try { outcome = await send(remaining[0]); }
    catch (error) { stopped = { reason: 'network', status: null, message: error instanceof Error ? error.message : String(error) }; break; }
    const disposition = uploadDisposition(outcome?.status);
    if (disposition === 'done') { delivered.push(outcome.receipt ?? null); remaining.shift(); continue; }
    if (disposition === 'drop') { dropped.push({ status: outcome.status, observed_at: bodyObservedAt(remaining[0]), error: outcome.receipt?.error ?? null }); remaining.shift(); continue; }
    stopped = { reason: disposition === 'stop_auth' ? 'unauthorized' : 'retry', status: outcome.status, message: outcome.receipt?.error ?? null };
    break;
  }
  return { queue: remaining, delivered, dropped, stopped };
}

/** The part of a v2 receipt worth keeping for the options page. */
export function summarizeReceipt(receipt, at) {
  if (!receipt || typeof receipt !== 'object') return { at, accepted: null, duplicates: null, rejected: [] };
  const rejected = Array.isArray(receipt.rejected) ? receipt.rejected.map(r => r?.reason).filter(Boolean) : [];
  return { at, accepted: receipt.accepted?.records ?? null, duplicates: receipt.duplicates ?? null, rejected: [...new Set(rejected)] };
}

// ---- health --------------------------------------------------------------------------------

const ERROR_TEXT = {
  no_tab: 'Unsupported right now: no claude.ai tab is open in this browser profile.',
  sign_in: 'Unsupported right now: the Claude tab is signed out or waiting for verification.',
  account_mismatch: 'Unsupported: the signed-in Claude account is not the pinned account. Collection is paused so accounts never mix.',
  org_unavailable: 'Unsupported: the pinned organization is not available in the signed-in account.',
  no_windows: 'Unsupported: Claude returned no recognized allowance windows (the usage shape may have changed).',
  shape: 'Unsupported: the Claude account response has an unrecognized shape.',
  unauthorized: 'The install key was refused (401/403). Disable this install in the Observatory and pair again.',
  identity_changed: 'The Observatory holds a different identity for this binding. Approve re-confirmation in Connections, then collect again.',
  identity_taken: 'Another binding of this install already holds this Claude account.',
  rejected: 'The Observatory rejected a body permanently; it was dropped so newer readings can flow.',
};

/**
 * The truthful state of this profile for the options page, derived only from stored facts:
 * pairing, binding, the last read (windows and observation time), the last upload receipt,
 * the last error with its code, and the legacy bridge.
 */
export function deriveHealth(state, now = Date.now()) {
  const { install, binding, connection, pin, lastRead, lastUploadV2, lastUploadV1, lastError, gate, outbox, outboxV2 } = state ?? {};
  const lines = [];
  const pairing = install ? `paired as “${install.machineLabel}” (install ${String(install.id).slice(0, 8)}…) since ${when(install.pairedAt)}` : 'not paired with the Observatory (v2)';
  lines.push(['Pairing', pairing]);
  lines.push(['Bound account', binding ? `${binding.accountId} · identity ${binding.identityConfirmed ? 'confirmed' : 'not yet confirmed'}` : pin ? 'Claude account pinned; not bound to an Observatory account yet' : 'no Claude account pinned']);
  lines.push(['Recognized windows', lastRead?.windows?.length ? lastRead.windows.join(', ') : 'none yet']);
  lines.push(['Last observation', lastRead?.observedAt ? `${when(lastRead.observedAt)} (${age(lastRead.observedAt, now)})` : 'never']);
  lines.push(['Last v2 upload', lastUploadV2 ? receiptText(lastUploadV2) : 'none']);
  if (connection) lines.push(['Legacy v1 bridge', `connection for ${connection.account_id} still configured · last upload ${lastUploadV1?.at ? when(lastUploadV1.at) : 'none'}`]);
  const pendingV1 = Array.isArray(outbox) ? outbox.length : 0, pendingV2 = Array.isArray(outboxV2) ? outboxV2.length : 0;
  if (pendingV1 || pendingV2) lines.push(['Retained for retry', `${pendingV2} v2 · ${pendingV1} v1`]);
  if (gate?.reason) lines.push(['Observatory settings', GATE_TEXT[gate.reason] ?? gate.reason]);
  lines.push(['Last error', lastError ? errorText(lastError) : 'none']);

  let code, summary;
  if (!install && !connection) { code = 'unpaired'; summary = 'Pair with the Observatory to start.'; }
  else if (install && !binding) { code = 'unbound'; summary = 'Paired. Bind the signed-in Claude account next.'; }
  else if (!pin) { code = 'unpinned'; summary = 'Pin the Claude account to collect.'; }
  else if (lastError?.code === 'unauthorized') { code = 'key_invalid'; summary = ERROR_TEXT.unauthorized; }
  else if (gate?.reason && gate.reason !== 'binding_missing') { code = gate.reason; summary = GATE_TEXT[gate.reason]; }
  else if (lastError && ERROR_TEXT[lastError.code]) { code = lastError.code; summary = ERROR_TEXT[lastError.code]; }
  else if (lastError && lastError.at && (!lastRead?.observedAt || Date.parse(lastError.at) >= Date.parse(lastRead.observedAt))) { code = 'error'; summary = errorText(lastError); }
  else if (!lastRead?.observedAt) { code = 'waiting'; summary = 'Waiting for the first reading.'; }
  else if (pendingV2 || pendingV1) { code = 'retrying'; summary = `Read ${lastRead.windows.length} windows; ${pendingV2 + pendingV1} bodies retained for retry.`; }
  else { code = 'ok'; summary = `Read ${lastRead.windows.length} windows ${age(lastRead.observedAt, now)}; last upload ${lastUploadV2?.at ? when(lastUploadV2.at) : when(lastUploadV1?.at)}.`; }
  return { code, summary, lines };
}
const GATE_TEXT = {
  paused: 'Paused in the Observatory (kill switch or install pause); nothing is collected until it is resumed.',
  provider_off: 'Claude collection is switched off for this install in Settings → Collection.',
  binding_disabled: 'This binding is disabled in Connections; readings are not uploaded.',
  binding_missing: 'The Observatory no longer lists this binding; bind again.',
};
function receiptText(upload) {
  const parts = [when(upload.at)];
  if (upload.accepted !== null && upload.accepted !== undefined) parts.push(`${upload.accepted} accepted`);
  if (upload.duplicates) parts.push(`${upload.duplicates} duplicate`);
  if (upload.rejected?.length) parts.push(`rejected: ${upload.rejected.join(', ')}`);
  return parts.join(' · ');
}
function errorText(error) {
  const base = ERROR_TEXT[error.code] ?? error.message ?? 'Collection failed';
  const detail = [error.status ? `HTTP ${error.status}` : null, error.observedAt ? `reading of ${when(error.observedAt)}` : null, error.at ? `at ${when(error.at)}` : null].filter(Boolean);
  return detail.length ? `${base} (${detail.join(', ')})` : base;
}
function when(value) { const t = value ? Date.parse(value) : NaN; return Number.isFinite(t) ? new Date(t).toLocaleString() : 'unknown'; }
function age(value, now) {
  const minutes = Math.round((now - Date.parse(value)) / 60_000);
  return !Number.isFinite(minutes) ? 'at an unknown time' : minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/**
 * Dual-publication policy. While a profile publishes both v1 (`/api/v1/telemetry`) and v2
 * (`/api/v1/usage`) from the same read, both bodies carry the same observation time, value, and
 * reset anchor per window. The compatibility view shows such a pair once, as the v2 reading, so
 * on a tie the v2 reading wins; the v1 sample stays in its ledger as preserved history. The
 * cutover step is `removeLegacy`, which deletes the v1 connection and its outbox on this profile
 * after the v1 source was disabled in the Observatory.
 */
export const DUPLICATE_POLICY = 'v2_wins_on_tie';
