#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--') ? [arg.slice(2), all[index + 1]?.startsWith('--') ? true : all[index + 1] ?? true] : []).filter(row => row.length));
if (!args['report-id'] || !args.html || !args['allowed-root'] || !args.producer) {
  throw new Error('Required: --report-id --html --allowed-root --producer; optional --config --dry-run');
}
if (!/^[0-9a-f-]{36}$/i.test(args['report-id'])) throw new Error('Invalid report id');

const mediaTypes = { json: 'application/json', csv: 'text/csv', md: 'text/markdown', txt: 'text/plain', html: 'text/html' };
const maximumAssetBytes = 4_000_000;
function decodeHtmlEntities(value) {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|amp|apos|quot|lt|gt);/gi, (entity, hex, decimal) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ '&amp;': '&', '&apos;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' })[entity.toLowerCase()] ?? entity;
  });
}
function assetPathFromHref(href) {
  const path = decodeHtmlEntities(href).trim();
  if (!path || path.startsWith('#') || path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return;
  if (path.includes('\0') || path.includes('?') || path.includes('#')) return;
  return path;
}
function descriptor(path) {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const mediaType = mediaTypes[extension];
  const filename = basename(path);
  if (!mediaType || !/^[A-Za-z0-9._-]{1,200}$/.test(filename)) return;
  return { path, filename, mediaType, assetKey: createHash('sha256').update(path).digest('hex') };
}
function isInside(root, candidate) {
  const result = relative(root, candidate);
  return result !== '' && !result.startsWith(`..${sep}`) && result !== '..' && !result.startsWith(sep);
}
function hrefs(html) {
  const found = new Set();
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const path = assetPathFromHref(match[1] ?? match[2] ?? match[3] ?? '');
    const asset = path && descriptor(path);
    if (asset) found.add(asset.path);
  }
  return [...found];
}

const allowedRoot = await realpath(resolve(args['allowed-root']));
const htmlPath = await realpath(resolve(args.html));
if (!isInside(allowedRoot, htmlPath)) throw new Error('The report HTML must be inside --allowed-root');
const source = await readFile(htmlPath, 'utf8');
const assets = [];
for (const href of hrefs(source)) {
  const candidate = resolve(dirname(htmlPath), href);
  let resolved;
  try { resolved = await realpath(candidate); } catch { continue; }
  if (!isInside(allowedRoot, resolved)) throw new Error('An asset path resolves outside --allowed-root');
  const content = await readFile(resolved, 'utf8');
  if (Buffer.byteLength(content) > maximumAssetBytes) throw new Error('An asset exceeds the 4 MB upload limit');
  assets.push({ ...descriptor(href), content });
}
if (args['dry-run']) {
  console.log(JSON.stringify({ valid: true, report_id: args['report-id'], assets: assets.length }));
  process.exit(0);
}
const configPath = resolve(args.config ?? process.env.PERSONAL_HUB_CONFIG ?? `${homedir()}/.config/personal-hub/publish.json`);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const url = new URL(config.url);
if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('HTTPS is required');
const credential = config.producers?.[args.producer];
if (!credential?.key || !credential.kinds?.includes('audit')) throw new Error('No audit credential for this producer');
const endpoint = new URL(`/api/v1/reports/audit/${args['report-id']}/assets`, url);
let uploaded = 0; let duplicates = 0;
for (const asset of assets) {
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45_000),
        headers: { Authorization: `Bearer ${credential.key}`, 'Content-Type': asset.mediaType, 'X-Asset-Path': asset.path, 'X-Asset-Key': asset.assetKey, 'X-Asset-Filename': asset.filename },
        body: asset.content,
      });
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) { if (attempt === 2) throw error; }
    if (attempt < 2) await new Promise(done => setTimeout(done, 1000 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error(`Asset upload failed (${response?.status ?? 'network error'})`);
  const receipt = await response.json();
  if (!receipt.ok || receipt.assetKey !== asset.assetKey) throw new Error('The server did not return a valid asset receipt');
  uploaded++;
  if (receipt.duplicate) duplicates++;
}
console.log(JSON.stringify({ ok: true, report_id: args['report-id'], uploaded, duplicates }));
