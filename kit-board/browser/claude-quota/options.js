let detected;
const el = id => document.getElementById(id);
async function status() {
  const s = await chrome.storage.local.get(['connection', 'pin', 'lastSuccess', 'lastError', 'lastWindows']);
  el('connection-label').textContent = s.connection ? `Upload account: ${s.connection.account_id}` : 'No connection imported';
  el('health').textContent = s.lastError || (s.lastSuccess ? `Last upload: ${new Date(s.lastSuccess).toLocaleString()} · ${s.lastWindows} windows` : 'Waiting for first reading');
}
async function action(type, extra = {}) {
  el('status').textContent = 'Working…';
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  el('status').textContent = r.error || r.pending || (r.ok ? `Uploaded ${r.windows} allowance windows.` : 'Account found. Confirm the organization below.');
  await status(); return r;
}
el('connection').addEventListener('change', async event => {
  try {
    const c = JSON.parse(await event.target.files[0].text());
    if (c.url !== 'https://personal-observatory-jg.vercel.app' || c.provider !== 'claude' || c.mode !== 'browser' || !/^[A-Za-z0-9_-]{43}$/.test(c.key) || !c.account_id) throw new Error('Use a Claude browser connection file from this Observatory.');
    const result = await chrome.runtime.sendMessage({ type: 'import', connection: c });
    if (result.error) throw new Error(result.error);
    el('status').textContent = 'Connection imported. Verify and pin the Claude account next.';
    await status();
  } catch (e) { el('status').textContent = e.message; }
});
el('inspect').addEventListener('click', async () => {
  const r = await action('inspect'); if (r.error) return;
  detected = r; el('identity').textContent = r.email; el('organizations').replaceChildren();
  for (const org of r.organizations) {
    const b = document.createElement('button'); b.textContent = `Pin ${org.name}`;
    b.addEventListener('click', async () => {
      const { connection } = await chrome.storage.local.get('connection');
      if (!connection) { el('status').textContent = 'Import an Observatory connection first.'; return; }
      await action('pin', { accountId: detected.accountId, orgId: org.id });
    }); el('organizations').append(b);
  }
});
el('collect').addEventListener('click', () => action('collect'));
void status();
