import { readFile, writeFile } from 'node:fs/promises';

const palette = `
:root{color-scheme:dark;--paper:#07100b;--deep:#040906;--panel:#0e1913;--ink:#edf7ef;--muted:#91a099;--line:#26362d;--mint:#a8f3c2;--green:#63df95;--violet:#9b82ff;--lilac:#211b38;--orange:#ff9a6c}
*{box-sizing:border-box}html{background:var(--paper);scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 10% -10%,#152d20 0,transparent 30rem),var(--paper);color:var(--ink);font:16px/1.7 Manrope,Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}a{color:var(--mint);text-underline-offset:3px}a:hover{color:var(--green)}a:focus-visible{outline:2px solid var(--mint);outline-offset:3px}.shell{max-width:1060px;margin:0 auto;padding:36px 28px 72px}.eyebrow,.meta{font:12px/1.4 "DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}header{border-top:3px solid var(--green);padding:22px 0 25px}h1{font-size:clamp(2rem,5vw,3.8rem);line-height:1.02;letter-spacing:-.055em;margin:9px 0 14px;max-width:16ch}header p{max-width:75ch;color:var(--muted);margin:0}nav{display:flex;gap:8px;flex-wrap:wrap;padding:13px 0 27px;border-block:1px solid var(--line)}nav a{font:12px/1.2 "DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:none;border:1px solid var(--line);padding:7px 10px;border-radius:999px}nav a:hover{border-color:var(--green);background:#10271a}article{max-width:900px}section{scroll-margin-top:20px;border-top:1px solid var(--line);padding:34px 0 4px}section:first-child{border-top:0;padding-top:34px}h2{font-size:clamp(1.45rem,3vw,2.25rem);line-height:1.15;letter-spacing:-.035em;margin:0 0 18px}p{margin:0 0 16px}.bullets{list-style:none;padding:0;margin:0 0 18px}.bullets li{position:relative;padding:0 0 12px 20px}.bullets li::before{content:"";position:absolute;left:0;top:.7em;width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px #63df9580}.rule{height:1px;background:var(--line);margin:25px 0}.source{font:12px/1.5 "DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin-top:34px;padding-top:16px;border-top:1px solid var(--line)}strong{color:var(--ink)}em{color:#c5d3ca}code{font:13px/1.4 "DM Mono",ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--deep);padding:.1em .32em;border-radius:3px}@media(max-width:620px){.shell{padding:24px 18px 48px}header{padding-top:18px}nav{padding-block:12px 20px}section{padding-top:27px}}
`;

function usage() {
  throw new Error('Usage: node scripts/render-readings.mjs --file source.json --output report.html');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function escapeHtml(value) {
  return value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function inline(markdown) {
  const tokenized = [];
  const token = html => `\u0000${tokenized.push(html) - 1}\u0000`;
  let value = escapeHtml(markdown);
  value = value.replace(/&lt;(https:\/\/[^|&\s]+)\|([^&]*)&gt;/g, (_match, url, label) => {
    const href = safeUrl(url);
    return href ? token(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${inline(label)}</a>`) : label;
  });
  value = value.replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    const href = safeUrl(url);
    return href ? token(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${inline(label)}</a>`) : label;
  });
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
  value = value.replace(/_([^_]+)_/g, '<em>$1</em>');
  return value.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokenized[Number(index)]);
}

function headingCandidate(line) {
  const clean = line.replace(/^#{1,6}\s+/, '').trim();
  return clean.length > 1 && clean.length <= 88 && !/[.!?:;]$/.test(clean) && !/[<>{}]/.test(clean) && !/^[-•*]/.test(clean) && /^[\p{L}\p{N} /&+—–-]+$/u.test(clean);
}

function headingId(title, used) {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '') || 'section';
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function splitSections(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const title = lines.find(line => line.trim())?.trim() ?? 'Daily readings';
  const start = lines.findIndex(line => line.trim() === title) + 1;
  const source = lines.slice(start);
  const used = new Map();
  const sections = [];
  let current = { title: '', id: 'readings', lines: [] };
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const isHeading = /^#{1,6}\s+/.test(line) || (headingCandidate(line) && (!source[index - 1]?.trim() || !source[index + 1]?.trim() || source[index + 1]?.trim().startsWith('•') || source[index + 1]?.trim().startsWith('*')));
    if (isHeading) {
      if (current.lines.some(item => item.trim())) sections.push(current);
      const text = line.replace(/^#{1,6}\s+/, '').trim();
      current = { title: text, id: headingId(text, used), lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.some(line => line.trim())) sections.push(current);
  return { title, sections };
}

function renderLines(lines) {
  const rendered = [];
  let paragraph = [];
  let bullets = [];
  const flushParagraph = () => {
    if (paragraph.length) rendered.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets.length) rendered.push(`<ul class="bullets">${bullets.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
    bullets = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushParagraph(); flushBullets(); continue; }
    const bullet = line.match(/^(?:[•*]|[-–])\s+(.+)$/);
    if (bullet) { flushParagraph(); bullets.push(bullet[1]); continue; }
    flushBullets();
    paragraph.push(line);
  }
  flushParagraph(); flushBullets();
  return rendered.join('\n');
}

function render(input) {
  if (!input || typeof input.markdown !== 'string' || !input.markdown.trim()) throw new Error('Input JSON needs a non-empty markdown string.');
  const { title, sections } = splitSections(input.markdown);
  const nav = sections.filter(section => section.id !== 'readings').map(section => `<a href="#${section.id}">${escapeHtml(section.title)}</a>`).join('');
  const body = sections.map(section => `<section id="${section.id}">${section.title ? `<h2>${escapeHtml(section.title)}</h2>` : ''}${renderLines(section.lines)}</section>`).join('\n');
  const source = typeof input.source === 'string' ? `<p class="source">Source: ${escapeHtml(input.source)}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)}</title><style>${palette}</style></head><body><main class="shell"><header><p class="eyebrow">Daily technology intelligence</p><h1>${escapeHtml(title)}</h1></header><nav aria-label="Reading sections">${nav}</nav><article>${body}</article>${source}</main></body></html>`;
}

const inputPath = argument('--file');
const outputPath = argument('--output');
if (!inputPath || !outputPath || process.argv.length !== 6) usage();
try {
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  await writeFile(outputPath, render(input), 'utf8');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
