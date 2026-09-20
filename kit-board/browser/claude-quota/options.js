import { ACCOUNT_ID_PATTERN, deriveHealth } from './collector.js';
let detected;
const el = id => document.getElementById(id);
const HUB = 'https://personal-observatory-jg.vercel.app';

/** Everything shown here is derived from stored facts; nothing is inferred from a timer. */
async function status() {
  const s = await chrome.storage.local.get(['install', 'binding', 'connection', 'pin', 'lastRead', 'lastUploadV2', 'lastUploadV1', 'lastError', 'gate', 'outbox', 'outboxV2']);
  const health = deriveHealth(s);
  el('summary').textContent = health.summary; el('summary').dataset.state = health.code;
  const list = el('health'); list.replaceChildren();
  for (const [term, detail] of health.lines) {
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = detail;
    list.append(dt, dd);
  }
  el('pair-form').hidden = !!s.install; el('paired').hidden = !s.install;
  if (s.install) el('paired-label').textContent = `Paired as “${s.install.machineLabel}” · install ${s.install.id}`;
  el('connection-label').textContent = s.connection ? `Legacy connection: upload account ${s.connection.account_id}` : 'No legacy connection';
  el('remove-legacy').hidden = !s.connection;
  if (s.binding && !el('account-id').value) el('account-id').value = s.binding.accountId;
  else if (s.connection && !el('account-id').value) el('account-id').value = s.connection.account_id;
}
async function action(type, extra = {}) {
  el('status').textContent = 'Working…';
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  el('status').textContent = r.error || r.pending || (r.ok ? `Uploaded ${r.windows} allowance windows.` : r.paired ? 'Paired. Bind the signed-in Claude account next.' : r.unpaired ? 'Unpaired.' : r.removed ? 'Legacy connection removed; this profile publishes v2 only.' : r.retained ? `Read ${r.windows} windows; ${r.retained} bodies retained for retry.` : 'Account found. Choose the organization below.');
  await status(); return r;
}
el('pair').addEventListener('click', () => action('pair', { code: el('code').value, label: el('label').value }));
el('unpair').addEventListener('click', () => { if (confirm('Unpair this profile? Disable the install in the Observatory too; its key stops working there.')) void action('unpair'); });
el('remove-legacy').addEventListener('click', () => { if (confirm('Remove the legacy v1 connection from this profile? Do this after the v1 source is disabled in the Observatory.')) void action('removeLegacy'); });
el('connection').addEventListener('change', async event => {
  try {
    const c = JSON.parse(await event.target.files[0].text());
    if (c.url !== HUB || c.provider !== 'claude' || c.mode !== 'browser' || !/^[A-Za-z0-9_-]{43}$/.test(c.key) || !c.account_id) throw new Error('Use a Claude browser connection file from this Observatory.');
    const result = await chrome.runtime.sendMessage({ type: 'import', connection: c });
    if (result.error) throw new Error(result.error);
    el('status').textContent = 'Legacy connection imported. Pin the Claude account (bind, or find and pin) next.';
    await status();
  } catch (e) { el('status').textContent = e.message; }
});
el('inspect').addEventListener('click', async () => {
  const r = await action('inspect'); if (r.error) return;
  detected = r; el('identity').textContent = `Signed in as ${r.email}`; el('organizations').replaceChildren();
  const { install, connection } = await chrome.storage.local.get(['install', 'connection']);
  for (const org of r.organizations) {
    const b = document.createElement('button'); b.textContent = install ? `Bind ${org.name}` : `Pin ${org.name}`;
    b.addEventListener('click', async () => {
      if (install) {
        const observatoryAccountId = el('account-id').value.trim();
        if (!ACCOUNT_ID_PATTERN.test(observatoryAccountId)) { el('status').textContent = 'Enter the Observatory account id first (lowercase letters, digits, dashes).'; return; }
        await action('bind', { accountId: detected.accountId, orgId: org.id, observatoryAccountId, accountLabel: el('account-label').value });
      } else if (connection) {
        await action('pin', { accountId: detected.accountId, orgId: org.id });
      } else el('status').textContent = 'Pair with the Observatory first.';
    }); el('organizations').append(b);
  }
});
el('collect').addEventListener('click', () => action('collect'));
void status();
