import { normalizeQuota } from './normalize.js';
import { CollectorError, COLLECTOR_VERSION, INSTALL_KEY_PATTERN, bindingRequest, buildEnvelope, detectPlatform, drainOutbox, enqueue,
  failureEnvelope, identityHash, pairRequest, parsePairResponse, settingsGate, summarizeReceipt } from './collector.js';
const HUB = 'https://personal-observatory-jg.vercel.app';
const ALARM = 'hourly-quota';
let running = false;
const platform = () => detectPlatform(globalThis.navigator?.userAgent);
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { cadenceMinutes } = await chrome.storage.local.get('cadenceMinutes');
  await ensureAlarm(cadenceMinutes ?? 60);
}
/** One alarm at the Observatory's cadence; recreated only when the period changes. */
async function ensureAlarm(minutes) {
  const period = [15, 30, 60].includes(minutes) ? minutes : 60;
  const existing = await chrome.alarms.get(ALARM);
  if (existing?.periodInMinutes === period) return;
  await chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
void initialize();

// Runs in an existing Claude tab, with its normal browser session. No cookie API.
async function readClaude(orgId) {
  async function read(path) {
    const r = await fetch(path, { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { __error: 'sign_in' };
    return r.json();
  }
  const account = await read('/api/account');
  if (account?.__error) return { error: 'sign_in', message: 'Open Claude and complete any sign-in or verification in the browser.' };
  const organizations = await read('/api/organizations');
  const accountId = account.uuid ?? account.id;
  if (!accountId || !Array.isArray(organizations)) return { error: 'shape', message: 'Claude account format changed. No reading was uploaded.' };
  const orgs = organizations.map(o => ({ id: o.uuid ?? o.id, name: o.name ?? 'Claude organization' })).filter(o => o.id);
  if (orgId && !orgs.some(o => o.id === orgId)) return { error: 'org_unavailable', message: 'Pinned organization is not available in this account.' };
  const usage = orgId ? await read('/api/organizations/' + encodeURIComponent(orgId) + '/usage') : null;
  if (usage?.__error) return { error: 'sign_in', message: 'Claude usage could not be read. Open the Claude usage page and retry.' };
  return { accountId, email: account.email_address ?? account.email ?? 'Signed-in Claude account', organizations: orgs, usage, observedAt: new Date().toISOString() };
}
async function readTab(orgId) {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (!tabs.length) throw new CollectorError('no_tab', 'Keep a signed-in Claude tab open in this browser profile for collection.');
  const results = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: readClaude, args: [orgId ?? null] });
  const result = results[0]?.result;
  if (!result) throw new CollectorError('shape', 'Could not read Claude usage. Open the Claude usage page and retry.');
  if (result.error) throw new CollectorError(result.error, result.message);
  return result;
}

/** One Observatory request. Returns the status and parsed body; a network fault throws. */
async function api(path, { method = 'GET', key = null, body = undefined, headers = {} } = {}) {
  const r = await fetch(HUB + path, { method, redirect: 'error', credentials: 'omit',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: 'Bearer ' + key } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const status = r.status;
  const json = status === 304 ? null : await r.json().catch(() => null);
  return { status, json, etag: r.headers?.get?.('etag') ?? null };
}
const unauthorized = status => status === 401 || status === 403;

/** The effective settings for this install; the cached copy stands in when the Observatory is unreachable. */
async function fetchConfig(install, cached, etag) {
  try {
    const r = await api('/api/v1/companion/config', { key: install.key, headers: etag ? { 'If-None-Match': etag } : {} });
    if (unauthorized(r.status)) throw new CollectorError('unauthorized', 'The Observatory refused the install key.', { status: r.status });
    if (r.status === 304 && cached) return { config: cached, etag, source: 'server' };
    if (r.status === 200 && r.json) {
      const { install: i, bindings, settings, settings_version } = r.json;
      const config = { install: i, bindings, settings, settings_version };
      await chrome.storage.local.set({ config, configEtag: r.etag, configFetchedAt: new Date().toISOString() });
      return { config, etag: r.etag, source: 'server' };
    }
  } catch (error) { if (error instanceof CollectorError && error.code === 'unauthorized') throw error; }
  return { config: cached ?? null, etag, source: cached ? 'cache' : 'none' };
}

/** Confirms the local identity on the binding when the Observatory holds none (a fresh binding or an approved re-confirmation). */
async function reconfirmIdentity(install, binding, serverHash) {
  if (serverHash === undefined || !binding?.identityHash) return binding;
  if (serverHash === binding.identityHash) return binding.identityConfirmed ? binding : { ...binding, identityConfirmed: true };
  if (serverHash !== null) throw new CollectorError('identity_changed', 'The Observatory holds a different identity for this binding.');
  const r = await api('/api/v1/companion/bindings/' + encodeURIComponent(binding.id) + '/identity', { method: 'POST', key: install.key, body: { identity_hash: binding.identityHash } });
  if (unauthorized(r.status)) throw new CollectorError('unauthorized', 'The Observatory refused the install key.', { status: r.status });
  if (r.status === 409) throw new CollectorError(/identity_taken/.test(r.json?.error ?? '') ? 'identity_taken' : 'identity_changed', r.json?.error ?? 'Identity refused.');
  return r.status === 200 ? { ...binding, identityConfirmed: true } : binding;
}

async function collect() {
  if (running) return { skipped: true };
  running = true;
  const startedAt = new Date().toISOString(), started = Date.now();
  const patch = {};
  const fail = error => {
    const e = error instanceof CollectorError ? error : new CollectorError('failed', error instanceof Error ? error.message : 'Collection failed');
    patch.lastError = { code: e.code, message: e.message, status: e.status ?? null, observedAt: e.observedAt ?? null, at: new Date().toISOString() };
    return e;
  };
  try {
    const state = await chrome.storage.local.get(['install', 'binding', 'connection', 'pin', 'outbox', 'outboxV2', 'config', 'configEtag']);
    const v2 = !!(state.install && state.binding);
    if (!v2 && !state.connection) return { pending: state.install ? 'Bind the signed-in Claude account first.' : 'Pair with the Observatory (or import a legacy connection) first.' };
    if (!state.pin) return { pending: 'Pin the Claude account first.' };
    let gate = { collect: false, reason: null, cadenceMinutes: 60, serverIdentityHash: undefined }, binding = state.binding ?? null;
    let settingsVersion = 0;
    if (v2) {
      try {
        const { config } = await fetchConfig(state.install, state.config, state.configEtag);
        gate = settingsGate(config, binding.id); settingsVersion = config?.settings_version ?? 0;
        patch.gate = { reason: gate.reason, at: new Date().toISOString() };
        patch.cadenceMinutes = gate.cadenceMinutes; await ensureAlarm(gate.cadenceMinutes);
        if (gate.collect) { binding = await reconfirmIdentity(state.install, binding, gate.serverIdentityHash); patch.binding = binding; }
      } catch (error) { fail(error); gate = { ...gate, collect: false }; }
    }
    const publishV2 = v2 && gate.collect, publishV1 = !!state.connection;
    let snapshot = null, quotas = null, readError = null;
    if (publishV2 || publishV1) {
      try {
        snapshot = await readTab(state.pin.orgId);
        if (snapshot.accountId !== state.pin.accountId) throw new CollectorError('account_mismatch', 'Claude account changed. Collection paused to prevent mixing accounts.');
        try { quotas = normalizeQuota(snapshot.usage, snapshot.observedAt); }
        catch (error) { throw new CollectorError('no_windows', error instanceof Error ? error.message : 'No recognized windows.'); }
        patch.lastRead = { observedAt: snapshot.observedAt, windows: quotas.map(q => q.window_key), accountMatch: true };
      } catch (error) { readError = fail(error); }
    }
    const finishedAt = new Date().toISOString(), durationMs = Date.now() - started;
    let outboxV2 = state.outboxV2 ?? [], outbox = state.outbox ?? [];
    if (publishV2 && quotas) {
      outboxV2 = enqueue(outboxV2, await buildEnvelope({ bindingId: binding.id, quotas, startedAt, finishedAt, platform: platform(), settingsVersion, durationMs }));
    }
    if (publishV1 && quotas) {
      outbox = enqueue(outbox, { schema_version: 1, observed_at: snapshot.observedAt, buckets: [], quotas, coverage: { collector_version: COLLECTOR_VERSION } });
    }
    await chrome.storage.local.set({ outbox, outboxV2 });
    // v2 first: it is the reading of record. A body the server rejects permanently is dropped (WEB-6).
    if (v2 && (publishV2 || outboxV2.length)) {
      const drained = await drainOutbox(outboxV2, async body => { const r = await api('/api/v1/usage', { method: 'POST', key: state.install.key, body }); return { status: r.status, receipt: r.json }; });
      outboxV2 = drained.queue; await chrome.storage.local.set({ outboxV2 });
      if (drained.delivered.length) patch.lastUploadV2 = summarizeReceipt(drained.delivered.at(-1), new Date().toISOString());
      if (drained.dropped.length) { const d = drained.dropped.at(-1); fail(new CollectorError('rejected', d.error ?? `Observatory rejected a body (${d.status}).`, { status: d.status, observedAt: d.observed_at })); }
      if (drained.stopped) fail(new CollectorError(drained.stopped.reason === 'unauthorized' ? 'unauthorized' : 'retry', drained.stopped.message ?? `Upload deferred (${drained.stopped.status ?? 'network'}); ${outboxV2.length} retained.`, { status: drained.stopped.status }));
    }
    if (publishV2 && readError && !quotas && readError.code !== 'unauthorized') {
      // Coverage only, so Connections can show why: no tab, signed out, account mismatch, or an unrecognized shape. Never queued.
      try { await api('/api/v1/usage', { method: 'POST', key: state.install.key, body: failureEnvelope({ startedAt, finishedAt, platform: platform(), settingsVersion, code: readError.code, durationMs }) }); } catch { /* best effort */ }
    }
    if (publishV1 && outbox.length) {
      const drained = await drainOutbox(outbox, async body => {
        const r = await api('/api/v1/telemetry', { method: 'POST', key: state.connection.key, body });
        // A 2xx without a receipt id is treated as a server fault: the body is kept.
        return { status: r.status >= 200 && r.status < 300 && !(r.json?.ok && r.json?.id) ? 502 : r.status, receipt: r.json };
      });
      outbox = drained.queue; await chrome.storage.local.set({ outbox });
      if (drained.delivered.length) patch.lastUploadV1 = { at: new Date().toISOString() };
      if (drained.dropped.length) { const d = drained.dropped.at(-1); fail(new CollectorError('rejected', d.error ?? `Legacy upload rejected (${d.status}).`, { status: d.status, observedAt: d.observed_at })); }
      if (drained.stopped) fail(new CollectorError(drained.stopped.reason === 'unauthorized' ? 'v1_unauthorized' : 'retry', drained.stopped.message ?? `Legacy upload deferred (${drained.stopped.status ?? 'network'}); ${outbox.length} retained.`, { status: drained.stopped.status }));
    }
    if (readError) throw readError;
    if (!patch.lastError && quotas) { patch.lastError = null; patch.lastSuccess = snapshot.observedAt; patch.lastWindows = quotas.length; }
    return { ok: !patch.lastError, windows: quotas?.length ?? 0, retained: outboxV2.length + outbox.length, error: patch.lastError?.message };
  } catch (error) {
    const e = fail(error);
    return { error: e.message, code: e.code };
  } finally {
    await chrome.storage.local.set(patch);
    running = false;
  }
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void collect(); });

/** Setup mutations run under the same lock as collection so credentials never change mid-upload. */
async function exclusive(fn) {
  if (running) throw new Error('Collection is running. Retry setup after it finishes.');
  running = true;
  try { return await fn(); } finally { running = false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url?.startsWith('https://')) return false;
  (async () => {
    if (message.type === 'inspect') return readTab(null);
    if (message.type === 'collect') return collect();
    if (message.type === 'pair') {
      return exclusive(async () => {
        const state = await chrome.storage.local.get(['install']);
        if (state.install) throw new Error('This profile is already paired. Unpair it first to pair again.');
        const body = pairRequest({ code: message.code, machineLabel: message.label, platform: platform() });
        const r = await api('/api/v1/companion/pair', { method: 'POST', body });
        if (r.status !== 201) throw new Error(r.json?.error ?? `Pairing failed (${r.status}).`);
        const { id, key } = parsePairResponse(r.json);
        const install = { id, key, machineLabel: body.machine_label, url: HUB, pairedAt: new Date().toISOString() };
        await chrome.storage.local.set({ install, binding: null, outboxV2: [], config: null, configEtag: null, gate: null, lastError: null, lastUploadV2: null });
        return { paired: true, installId: id };
      });
    }
    if (message.type === 'bind') {
      return exclusive(async () => {
        const state = await chrome.storage.local.get(['install', 'pin', 'binding']);
        if (!state.install) throw new Error('Pair with the Observatory first.');
        const fresh = await readTab(message.orgId);
        if (fresh.accountId !== message.accountId) throw new Error('Account changed during setup. Inspect again.');
        if (state.pin && (state.pin.accountId !== fresh.accountId || state.pin.orgId !== message.orgId)) throw new Error('This profile is pinned to a different Claude account or organization. Unpair (and remove the legacy connection) to collect another one.');
        const hash = await identityHash('claude', fresh.accountId);
        const body = bindingRequest({ accountId: message.observatoryAccountId, accountLabel: message.accountLabel, identityHash: hash });
        const r = await api('/api/v1/companion/bindings', { method: 'POST', key: state.install.key, body });
        if (unauthorized(r.status)) throw new Error('The install key was refused. Unpair and pair again.');
        if (r.status !== 200 && r.status !== 201) throw new Error(r.json?.error ?? `Binding failed (${r.status}).`);
        const server = r.json;
        if (!server?.binding_id) throw new Error('The Observatory returned no binding id.');
        let binding = { id: server.binding_id, accountId: server.account_id ?? body.account_id, identityHash: hash, identityConfirmed: server.identity_hash === hash };
        binding = await reconfirmIdentity(state.install, binding, server.identity_hash ?? null);
        await chrome.storage.local.set({ binding, pin: { accountId: fresh.accountId, orgId: message.orgId }, lastError: null, gate: null });
      }).then(collect);
    }
    if (message.type === 'unpair') {
      return exclusive(async () => {
        const { connection } = await chrome.storage.local.get(['connection']);
        await chrome.storage.local.set({ install: null, binding: null, outboxV2: [], config: null, configEtag: null, gate: null, lastUploadV2: null, lastError: null, ...(connection ? {} : { pin: null, lastRead: null }) });
        return { unpaired: true };
      });
    }
    if (message.type === 'removeLegacy') {
      // The cutover step: after the v1 source is disabled in the Observatory, the profile publishes v2 only.
      return exclusive(async () => {
        const { install } = await chrome.storage.local.get(['install']);
        await chrome.storage.local.set({ connection: null, outbox: [], lastUploadV1: null, ...(install ? {} : { pin: null }) });
        return { removed: true };
      });
    }
    if (message.type === 'import') {
      // Legacy v1 connection file. Kept for the reconciliation period; the pin survives when the profile is already bound.
      return exclusive(async () => {
        const c = message.connection;
        if (c?.url !== HUB || c.provider !== 'claude' || c.mode !== 'browser' || !INSTALL_KEY_PATTERN.test(c.key) || !c.account_id || !c.source_id) throw new Error('Use a Claude browser connection file from this Observatory.');
        const { binding } = await chrome.storage.local.get(['binding']);
        await chrome.storage.local.set({ connection: c, outbox: [], lastSuccess: null, lastError: null, lastUploadV1: null, ...(binding ? {} : { pin: null }) });
        return { imported: true };
      });
    }
    if (message.type === 'pin') {
      return exclusive(async () => {
        const state = await chrome.storage.local.get(['connection', 'install', 'pin']);
        if (!state.connection && !state.install) throw new Error('Pair with the Observatory or import a connection first.');
        const fresh = await readTab(message.orgId);
        if (fresh.accountId !== message.accountId) throw new Error('Account changed during setup. Inspect again.');
        if (state.pin && (state.pin.accountId !== fresh.accountId || state.pin.orgId !== message.orgId)) throw new Error('Use a new Observatory account connection to collect a different Claude account or organization.');
        await chrome.storage.local.set({ pin: { accountId: fresh.accountId, orgId: message.orgId }, lastError: null });
      }).then(collect);
    }
    throw new Error('Unknown action');
  })().then(respond, e => respond({ error: e.message, code: e.code }));
  return true;
});
