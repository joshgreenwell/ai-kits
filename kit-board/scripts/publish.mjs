#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';

// Every job uses the same client, with its own producer credential. Payloads and
// credentials never go into command arguments or normal logs.
const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith('--') ? [arg.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true] : []).filter(row => row.length));
if (!args.kind || !args.file || !args.producer) throw new Error('Required: --kind --producer --file; optional --html --period --subject --title --produced-at --status --config --dry-run');
const kinds = ['usage', 'tasks', 'standup', 'readings', 'audit'];
if (!kinds.includes(args.kind)) throw new Error('Unknown report kind');
const text = await readFile(resolve(args.file), 'utf8');
let payload;
try { payload = JSON.parse(text); } catch { payload = { markdown: text }; }
const html = args.html ? await readFile(resolve(args.html), 'utf8') : undefined;
const contentHash = createHash('sha256').update(JSON.stringify({ payload, html, period: args.period, subject: args.subject, title: args.title, produced_at: args['produced-at'], status: args.status })).digest('hex');
const input = args.kind === 'usage' ? payload : {
  schema_version: 1,
  period_key: args.period,
  subject_key: args.subject ?? 'josh',
  idempotency_key: contentHash,
  title: args.title ?? args.kind,
  produced_at: args['produced-at'],
  status: args.status ?? 'complete',
  coverage: Array.isArray(payload.coverage) ? { sources: payload.coverage } : payload.coverage ?? {},
  payload,
  ...(html ? { html } : {}),
};
if (args.kind !== 'usage' && (!args.period || !args['produced-at'])) throw new Error('Non-usage reports require their real --period and --produced-at, including timezone; do not replace observation time with upload time');
const body = JSON.stringify(input);
if (Buffer.byteLength(body) > 4_000_000) throw new Error('Report exceeds the 4 MB upload limit');
if (args['dry-run']) { console.log(JSON.stringify({ valid: true, kind: args.kind, bytes: Buffer.byteLength(body), content_hash: contentHash })); process.exit(0); }
const configPath = resolve(args.config ?? process.env.PERSONAL_HUB_CONFIG ?? `${homedir()}/.config/personal-hub/publish.json`);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const url = new URL(config.url);
if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('HTTPS is required');
const credential = config.producers[args.producer];
if (!credential?.key || !credential.kinds.includes(args.kind)) throw new Error('No credential for this producer and report kind');
const endpoint = new URL(args.kind === 'usage' ? '/api/reports' : `/api/v1/reports/${args.kind}`, url);
const spool = resolve(dirname(configPath), 'outbox', `${args.kind}-${contentHash}.json`);
await mkdir(dirname(spool), { recursive: true, mode: 0o700 });
// A failed upload can be replayed without rescanning mailboxes or rerunning audits.
await writeFile(spool, body, { mode: 0o600 });
let response;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.key}` }, body, signal: AbortSignal.timeout(45_000), redirect: 'error' });
    if (response.status < 500 && response.status !== 429) break;
  } catch (error) { if (attempt === 2) throw error; }
  if (attempt < 2) await new Promise(done => setTimeout(done, 1000 * (attempt + 1)));
}
if (!response?.ok) throw new Error(`Upload failed (${response?.status ?? 'network error'}). The report is retained in the local outbox.`);
const receipt = await response.json();
if (!receipt.ok || !receipt.id) throw new Error('The server did not return a valid publication receipt');
await mkdir(resolve(dirname(configPath), 'receipts'), { recursive: true, mode: 0o700 });
await writeFile(resolve(dirname(configPath), 'receipts', `${args.kind}-${contentHash}.json`), JSON.stringify({ ...receipt, kind: args.kind, at: new Date().toISOString(), content_hash: contentHash }), { mode: 0o600 });
await rename(spool, spool + '.published');
console.log(JSON.stringify({ ok: true, id: receipt.id, duplicate: receipt.duplicate, url: new URL('/' + args.kind, url).href }));
