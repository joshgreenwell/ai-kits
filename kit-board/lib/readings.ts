// Parses the daily readings markdown into a typed outline for ReadingsView.
// Pure and dependency-free so it runs on the client and in node:test alike.
// The producer's format has drifted (Slack mrkdwn, bare headings, `#` headings,
// split "(1/2)" sections), so every rule here is tolerant rather than strict.

export type Evidence = 'strong' | 'medium' | 'weak';
export type ReadingLink = { label: string; href: string };
export type ReadingPoint = { label: string | null; text: string; children: string[] };
export type ReadingItem = {
  tag: string | null;
  title: string;
  source: string | null;
  link: string | null;
  links: ReadingLink[];
  evidence: Evidence | null;
  evidenceLabel: string | null;
  summary: string | null;
  points: ReadingPoint[];
  notes: string[];
};
export type ReadingBullet = { lead: string | null; text: string; note: string | null; children: string[] };
export type SectionKind = 'snapshot' | 'worth' | 'lane' | 'watchlist' | 'skipped' | 'actions' | 'other';
export type ReadingSection = {
  id: string;
  title: string;
  kind: SectionKind;
  items: ReadingItem[];
  bullets: ReadingBullet[];
  paragraphs: string[];
};
export type Readings = {
  title: string | null;
  meta: { label: string; value: string }[];
  overall: string | null;
  snapshot: string[];
  sections: ReadingSection[];
  // False when neither a snapshot nor any item was found; the view then falls back to Prose.
  recognized: boolean;
};

export function httpsHref(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// "(1/3)", "(2/2)", "(continued)", "(cont.)" and a trailing colon mark a split or
// decorated copy of one section; they are dropped so the parts merge.
const partSuffix = /\s*\((?:\d+\s*\/\s*\d+|cont(?:inued|'d|\.)?)\)\s*$/i;
const baseTitle = (text: string) => text.replace(/:\s*$/, '').replace(partSuffix, '').replace(/:\s*$/, '').trim();
const normalize = (text: string) =>
  baseTitle(text).normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function kindOf(title: string): SectionKind | null {
  const name = normalize(title);
  if (/^(?:executive )?(?:snapshot|summary)$|^tl ?dr$|^key takeaways$/.test(name)) return 'snapshot';
  if (/^worth (?:looking at|reading|a look|watching)\b/.test(name)) return 'worth';
  if (/\blane$|^hacker news\b|\bbuilder sentiment$/.test(name)) return 'lane';
  if (/^watch ?list$|^on (?:the )?watch$|^watching$/.test(name)) return 'watchlist';
  if (/^skipped\b|^noise\b/.test(name)) return 'skipped';
  if (/^(?:suggested |recommended )?(?:actions?|next steps)$/.test(name)) return 'actions';
  return null;
}

// Wrapped lines: **x**, *x*, _x_. The inner text is what matters for headings and item titles.
function unwrap(line: string): { inner: string; wrapped: boolean } {
  const match = /^(\*\*|\*|__|_)(?!\s)(.+?)(?<!\s)\1$/.exec(line);
  if (match && !match[2].includes(match[1])) return { inner: match[2].trim(), wrapped: true };
  return { inner: line, wrapped: false };
}

// The renderer's rule for a bare legacy heading: short, no sentence punctuation, no markup.
function headingLike(text: string) {
  const clean = text.trim();
  return clean.length >= 2 && clean.length <= 88 && !/[.!?;]$/.test(clean) && !/[<>{}[\]`*]/.test(clean)
    && /^\p{Lu}/u.test(clean) && clean.split(/\s+/).length <= 8 && /^[\p{L}\p{N} /&+—–():,'-]+$/u.test(clean);
}

const bulletPattern = /^(\s*)(?:[-•*–+]|\d+[.)])\s+(.+)$/;
const fieldPattern = /^(Link|Links|Source|Evidence|Summary):\s*(.*)$/i;
const metaPattern = /^([A-Z][\w /-]{1,30}):\s+(.+)$/;
const noise = /^\s*[*_]{0,2}Sent (?:using|via)[*_]{0,2}\s+(?:<[^>]*>|\S+)\s*$/i;

function headingOf(line: string, previousBlank: boolean, next: string | undefined): string | null {
  const hash = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  if (hash) return hash[1].trim();
  const { inner, wrapped } = unwrap(line);
  if (inner.startsWith('[')) return null;
  if (kindOf(inner)) return inner;
  // An unknown wrapped heading (legacy `_Title_`) never carries a source dash like an item title.
  if (wrapped && line.startsWith('_') && headingLike(inner) && !/ [—–] /.test(inner)) return inner;
  if (!wrapped && previousBlank && headingLike(inner) && !/ [—–] /.test(inner)) {
    const following = next?.trim() ?? '';
    if (!following || /^[•*-]\s/.test(following) || /^(\*\*|\*|_)\[/.test(following)) return inner;
  }
  return null;
}

// Item title lines: "**[Tag] Title — Source**" and its * / _ / tagless variants. A tagged
// title may carry its gist on the same line: "*[Tag] Title* — see the item above".
function itemTitle(line: string) {
  const trailing = /^(\*\*|\*|__|_)(\[[^\]]+\].+?)\1\s*[—–:]\s+(.+)$/.exec(line);
  const { inner, wrapped } = trailing ? { inner: trailing[2].trim(), wrapped: true } : unwrap(line);
  if (!wrapped) return null;
  const tagged = /^\[([^\]]+)\]\s*(.+)$/.exec(inner);
  if (!tagged && !/ [—–] /.test(inner)) return null;
  const rest = (tagged ? tagged[2] : inner).trim();
  // The last dash separates the source, so "Title — disputed — Source" keeps its middle.
  const cut = Math.max(rest.lastIndexOf(' — '), rest.lastIndexOf(' – '));
  let title = rest;
  let source: string | null = null;
  if (cut > 0) {
    const candidate = rest.slice(cut + 3).trim();
    // "Name — a self-hosted search engine for…" is a description, not a publisher ("arXiv 2609…" is).
    const descriptive = /^\p{Ll}+\s/u.test(candidate) && candidate.split(/\s+/).length >= 4;
    if (candidate && !descriptive) {
      title = rest.slice(0, cut).trim();
      source = candidate;
    }
  }
  return { tag: tagged ? tagged[1].trim() : null, title, source, summary: trailing ? trailing[3].trim() : null };
}

type Found = { index: number; end: number; label: string; url: string };
// Every link form the producer has used: [label](url), <url|label>, <url>, and bare URLs.
function findLinks(text: string): Found[] {
  const found: Found[] = [];
  const taken = (index: number) => found.some(item => index >= item.index && index < item.end);
  const markdown = /\[([^\]]+)\]\(/g;
  for (let match; (match = markdown.exec(text));) {
    let depth = 1;
    let cursor = match.index + match[0].length;
    for (; cursor < text.length && depth; cursor++) {
      if (text[cursor] === '(') depth++;
      else if (text[cursor] === ')') depth--;
    }
    if (depth) continue;
    found.push({ index: match.index, end: cursor, label: match[1], url: text.slice(match.index + match[0].length, cursor - 1) });
  }
  for (const match of text.matchAll(/<([a-z][a-z0-9+.-]*:[^|>\s]+)(?:\|([^>]*))?>/gi)) {
    if (!taken(match.index)) found.push({ index: match.index, end: match.index + match[0].length, label: match[2] || match[1], url: match[1] });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>|)\]]+/g)) {
    if (!taken(match.index)) found.push({ index: match.index, end: match.index + match[0].length, label: match[0], url: match[0].replace(/[.,;:!?'"]+$/, '') });
  }
  return found.sort((a, b) => a.index - b.index);
}

function parseLinkLine(value: string, item: ReadingItem) {
  const found = findLinks(value);
  for (const link of found) {
    const href = httpsHref(link.url);
    if (href && !item.links.some(existing => existing.href === href)) item.links.push({ label: link.label.trim(), href });
  }
  item.link = item.links[0]?.href ?? null;
  // Keep anything that is not a link or a joiner ("(preprint; …)", or a non-https link) as a note.
  let residual = value;
  for (const link of [...found].reverse()) {
    if (httpsHref(link.url)) residual = residual.slice(0, link.index) + ' ' + residual.slice(link.end);
  }
  residual = residual.replace(/(?:^|\s)(?:\/|and|—|–|-|,|;|\|)(?=\s|$)/g, ' ').trim();
  if (/[\p{L}\p{N}]/u.test(residual)) item.notes.push(item.links.length ? residual : value.trim());
}

// The earliest strength word wins: "Mostly marketing (…) / Medium evidence (…)" is weak.
function parseEvidence(value: string): Evidence | null {
  const word = /\b(strong|medium|moderate|weak|low|speculative|marketing)\b/i.exec(value)?.[1].toLowerCase();
  if (!word) return null;
  return word === 'strong' ? 'strong' : word === 'medium' || word === 'moderate' ? 'medium' : 'weak';
}

// Index just past the ")" that closes the "(" at `open`, or -1.
function closeParen(text: string, open: number) {
  let depth = 0;
  for (let cursor = open; cursor < text.length; cursor++) {
    if (text[cursor] === '(') depth++;
    else if (text[cursor] === ')' && !--depth) return cursor + 1;
  }
  return -1;
}

function parsePoint(text: string): ReadingPoint {
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*(.*)$/.exec(text);
  if (bold) {
    const label = bold[1].trim();
    let rest = bold[2];
    if (label.endsWith(':')) return { label: label.slice(0, -1).trim(), text: rest.trim(), children: [] };
    if (rest.startsWith(':')) return { label, text: rest.slice(1).trim(), children: [] };
    // "**Community reaction** ([HN, 219 points](url)): text" moves the aside to the end.
    if (rest.startsWith('(')) {
      const end = closeParen(rest, 0);
      const after = end > 0 ? rest.slice(end).trimStart() : '';
      if (end > 0 && after.startsWith(':')) {
        rest = `${after.slice(1).trim()} ${rest.slice(0, end)}`.trim();
        return { label, text: rest, children: [] };
      }
    }
    return { label: null, text, children: [] };
  }
  const plain = /^([A-Z][\w/&+' -]{1,32}):\s+(.+)$/.exec(text);
  if (plain && plain[1].trim().split(/\s+/).length <= 4) return { label: plain[1].trim(), text: plain[2].trim(), children: [] };
  return { label: null, text, children: [] };
}

function parseBullet(text: string): ReadingBullet {
  let body = text.trim();
  let note: string | null = null;
  const watch = /\s*\bOn watch:\s*/i.exec(body);
  if (watch) {
    note = body.slice(watch.index + watch[0].length).trim() || null;
    body = body.slice(0, watch.index).trim();
  }
  const trim = (value: string) => value.replace(/^[\s,;:—–-]+/, '').trim();
  const lead = /^(\*\*|__|\*|_)(?!\s)(.+?)(?<!\s)\1(?![\w*_])\s*(.*)$/.exec(body);
  if (lead) {
    const title = lead[2].trim();
    const rest = lead[3];
    return { lead: title.replace(/:$/, ''), text: trim(rest), note, children: [] };
  }
  return { lead: null, text: body, note, children: [] };
}

const slug = (text: string) =>
  text.normalize('NFKD').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

export function parseReadings(markdown: string): Readings {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').filter(line => !noise.test(line));
  const result: Readings = { title: null, meta: [], overall: null, snapshot: [], sections: [], recognized: false };
  const ids = new Map<string, number>();
  let section: ReadingSection | null = null;
  let item: ReadingItem | null = null;
  let lastBullet: ReadingBullet | null = null;
  let lastPoint: ReadingPoint | null = null;
  let previousBlank = true;
  const preamble: string[] = [];

  // Split parts ("Worth Looking At (2/2)") reopen the section they continue.
  const open = (heading: string): ReadingSection => {
    const title = baseTitle(heading);
    const existing = result.sections.find(candidate => normalize(candidate.title) === normalize(title));
    if (existing) return existing;
    const base = slug(title);
    const count = (ids.get(base) ?? 0) + 1;
    ids.set(base, count);
    const created: ReadingSection = { id: count > 1 ? `${base}-${count}` : base, title, kind: kindOf(title) ?? 'other', items: [], bullets: [], paragraphs: [] };
    result.sections.push(created);
    return created;
  };
  const flushPreamble = () => {
    if (preamble.length) open('Notes').paragraphs.push(...preamble.splice(0));
  };

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) { previousBlank = true; continue; }
    const next = lines.slice(index + 1).find(candidate => candidate.trim());
    const wasBlank = previousBlank;
    previousBlank = false;

    if (!section) {
      const first = result.title === null && !result.meta.length && result.overall === null && !preamble.length;
      const hash = /^#\s+(.+)$/.exec(line);
      const candidate = unwrap(hash ? hash[1].trim() : line).inner;
      if (first && (hash || !metaPattern.test(line)) && !/^#{2,}\s/.test(line) && !kindOf(candidate)) {
        result.title = candidate;
        continue;
      }
      const meta = metaPattern.exec(line);
      if (meta && !kindOf(line)) {
        if (/^overall(?: read)?$/i.test(meta[1].trim())) result.overall = meta[2].trim();
        else result.meta.push({ label: meta[1].trim(), value: meta[2].trim() });
        continue;
      }
    }

    const heading = headingOf(line, wasBlank, next);
    if (heading) {
      flushPreamble();
      section = open(heading);
      item = null;
      lastBullet = null;
      lastPoint = null;
      continue;
    }
    if (!section) { preamble.push(line); continue; }

    const bullet = bulletPattern.exec(raw);
    const nested = !!bullet && bullet[1].replace(/\t/g, '  ').length >= 2;

    if (section.kind === 'snapshot' || section.kind === 'watchlist' || section.kind === 'skipped' || section.kind === 'actions') {
      // Older reports wrote these as blank-separated paragraphs; each paragraph is one entry.
      if (nested && lastBullet) lastBullet.children.push(bullet[2].trim());
      else {
        const text = bullet ? bullet[2].trim() : line;
        // The snapshot is read as sentences, so it keeps its bold inline rather than splitting a lead.
        lastBullet = section.kind === 'snapshot' ? { lead: null, text, note: null, children: [] } : parseBullet(text);
        section.bullets.push(lastBullet);
      }
      continue;
    }

    const title = itemTitle(line);
    if (title) {
      item = { ...title, link: null, links: [], evidence: null, evidenceLabel: null, points: [], notes: [] };
      section.items.push(item);
      lastPoint = null;
      continue;
    }

    const field = item ? fieldPattern.exec(line) : null;
    if (item && field) {
      const name = field[1].toLowerCase();
      const value = field[2].trim();
      if (name === 'evidence') {
        item.evidence = parseEvidence(value);
        item.evidenceLabel = value || null;
      } else if (name === 'summary') {
        item.summary = item.summary ? `${item.summary} ${value}` : value || null;
      } else parseLinkLine(value, item);
      continue;
    }

    if (bullet) {
      const text = bullet[2].trim();
      if (item) {
        if (nested && lastPoint) lastPoint.children.push(text);
        else item.points.push((lastPoint = parsePoint(text)));
      } else if (nested && lastBullet) lastBullet.children.push(text);
      else section.bullets.push((lastBullet = parseBullet(text)));
      continue;
    }

    // Free text: a missing summary first, then the notes of an item with points,
    // otherwise a section-level remark ("No fourth paper cleared the bar…").
    if (item && !item.summary && !item.points.length && !item.notes.length) item.summary = line;
    else if (item && (item.points.length || !wasBlank)) item.notes.push(line);
    else {
      section.paragraphs.push(line);
      item = null;
    }
  }

  flushPreamble();
  result.snapshot = result.sections.find(candidate => candidate.kind === 'snapshot')?.bullets.map(entry => entry.text) ?? [];
  result.recognized = result.snapshot.length > 0 || result.sections.some(candidate => candidate.items.length > 0);
  return result;
}
