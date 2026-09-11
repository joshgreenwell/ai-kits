import { normalizeQuota } from './normalize.js';
const HUB = 'https://personal-observatory-jg.vercel.app';
let running = false;
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (!(await chrome.alarms.get('hourly-quota'))) await chrome.alarms.create('hourly-quota', { periodInMinutes: 60, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(initialize);
chrome.runtime.onStartup.addListener(initialize);
void initialize();

// Runs in an existing Claude tab, with its normal browser session. No cookie API.
async function readClaude(orgId) {
  async function read(path) {
    const r = await fetch(path, { credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Open Claude and complete any sign-in or verification in the browser.');
    return r.json();
  }
  const account = await read('/api/account');
  const organizations = await read('/api/organizations');
  const accountId = account.uuid ?? account.id;
  if (!accountId || !Array.isArray(organizations)) throw new Error('Claude account format changed. No reading was uploaded.');
  const orgs = organizations.map(o => ({ id: o.uuid ?? o.id, name: o.name ?? 'Claude organization' })).filter(o => o.id);
  if (orgId && !orgs.some(o => o.id === orgId)) throw new Error('Pinned organization is not available in this account.');
  const usage = orgId ? await read('/api/organizations/' + encodeURIComponent(orgId) + '/usage') : null;
  return { accountId, email: account.email_address ?? account.email ?? 'Signed-in Claude account', organizations: orgs, usage, observedAt: new Date().toISOString() };
}
async function readTab(orgId) {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (!tabs.length) throw new Error('Keep a signed-in Claude tab open in this browser profile for hourly collection.');
  const results = await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, func: readClaude, args: [orgId ?? null] });
  if (!results[0]?.result) throw new Error('Could not read Claude usage. Open the Claude usage page and retry.');
  return results[0].result;
}
async function collect() {
  if (running) return { skipped: true };
  running = true;
  try {
    const state = await chrome.storage.local.get(['connection', 'pin', 'outbox']);
    if (!state.connection || !state.pin) return { pending: 'Import a connection and pin the Claude account first.' };
    const snapshot = await readTab(state.pin.orgId);
    if (snapshot.accountId !== state.pin.accountId) throw new Error('Claude account changed. Collection paused to prevent mixing accounts.');
    const quotas = normalizeQuota(snapshot.usage, snapshot.observedAt);
    const body = { schema_version: 1, observed_at: snapshot.observedAt, buckets: [], quotas,
      coverage: { collector_version: 'browser-1.0.0' } };
    // A bounded offline queue retains actual capture times. Server deduplicates retries.
    const queue = [...(state.outbox ?? []), body].slice(-168);
    await chrome.storage.local.set({ outbox: queue });
    while (queue.length) {
      const r = await fetch(HUB + '/api/v1/telemetry', { method: 'POST', redirect: 'error', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.connection.key },
        body: JSON.stringify(queue[0]), signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`Observatory upload failed (${r.status}). Reading retained for retry.`);
      const receipt = await r.json();
      if (!receipt.ok || !receipt.id) throw new Error('No valid receipt; reading retained.');
      queue.shift(); await chrome.storage.local.set({ outbox: queue });
    }
    await chrome.storage.local.set({ lastSuccess: snapshot.observedAt, lastError: null, lastWindows: quotas.length });
    return { ok: true, windows: quotas.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Collection failed';
    await chrome.storage.local.set({ lastError: error }); return { error };
  } finally { running = false; }
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'hourly-quota') void collect(); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url?.startsWith('https://')) return false;
  (async () => {
    if (message.type === 'inspect') return readTab(null);
    if (message.type === 'collect') return collect();
    if (message.type === 'import') {
      // All connection and outbox mutations run through this worker's lock.
      if (running) throw new Error('Collection is running. Retry setup after it finishes.');
      running = true;
      try {
        const c = message.connection;
        if (c?.url !== HUB || c.provider !== 'claude' || c.mode !== 'browser' || !/^[A-Za-z0-9_-]{43}$/.test(c.key) || !c.account_id || !c.source_id) throw new Error('Use a Claude browser connection file from this Observatory.');
        await chrome.storage.local.set({ connection: c, pin: null, outbox: [], lastSuccess: null, lastError: null });
        return { imported: true };
      } finally { running = false; }
    }
    if (message.type === 'pin') {
      if (running) throw new Error('Collection is running. Retry setup after it finishes.');
      running = true;
      try {
        const state = await chrome.storage.local.get(['connection', 'pin']);
        if (!state.connection) throw new Error('Import a connection first.');
        const fresh = await readTab(message.orgId);
        if (fresh.accountId !== message.accountId) throw new Error('Account changed during setup. Inspect again.');
        if (state.pin && (state.pin.accountId !== fresh.accountId || state.pin.orgId !== message.orgId)) throw new Error('Use a new Observatory account connection to collect a different Claude account or organization.');
        await chrome.storage.local.set({ pin: { accountId: fresh.accountId, orgId: message.orgId }, lastError: null });
      } finally { running = false; }
      return collect();
    }
    throw new Error('Unknown action');
  })().then(respond, e => respond({ error: e.message }));
  return true;
});
