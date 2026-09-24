/**
 * The daily briefing's structured payload, read into the shapes the native view draws. The producer
 * writes loosely typed JSON beside its HTML, so every field is read defensively: an unknown priority or
 * kind falls back rather than failing, a link is kept only when it is a web or Linear address, and a
 * revision without sections returns null so the page can fall back to the published report.
 */

export type BriefingPriority = 'urgent' | 'today' | 'soon' | 'later';
export type BriefingKind = 'reply' | 'deadline' | 'followup' | 'information';
export type BriefingLink = { label: string; href: string };
export type BriefingItem = {
  key: string; domain: string; domainLabel: string; title: string; kind: BriefingKind; priority: BriefingPriority;
  when: string; context: string; nextStep: string; project: string | null; links: BriefingLink[];
  /** How current the item is, as the producer said it: "Not refreshed September 22" and the like. */
  freshness: string | null;
  /** A tracked disposition such as "needs review", or the linked task's status. */
  status: string | null;
};
export type BriefingDomain = { key: string; label: string; items: BriefingItem[]; emptyNote: string };
export type EntryClass = 'shared' | 'own' | 'excluded';
export type CalendarEntry = { key: string; title: string; time: string; tag: string; tagLabel: string; kind: EntryClass };
export type CalendarDay = {
  date: string; dow: string; day: string; today: boolean; weekend: boolean;
  shared: number; solo: number; counted: number; entries: CalendarEntry[];
};
export type QueueRow = { id: string; title: string; priority: string; status: string; idle: string; idleDays: number | null; due: string | null; href: string | null };
export type BriefingQueue = { rows: QueueRow[]; open: number; high: number; stale: number; stages: { label: string; count: number }[]; note: string };
export type InboxSignal = {
  windowLabel: string; total: number; figures: { n: number; label: string; hint: string; hot: boolean }[];
  classes: { label: string; count: number }[]; note: string; senders: { address: string; count: number }[];
};
export type CleanupCandidate = { key: string; domain: string; sender: string; reason: string; action: string };
export type CoverageRow = { key: string; source: string; status: string; detail: string; agent: string; at: string };
export type Briefing = {
  dateLabel: string; timeLabel: string; notice: string;
  domains: BriefingDomain[]; queue: BriefingQueue | null;
  week: { days: CalendarDay[]; note: string } | null;
  inbox: InboxSignal | null; candidates: CleanupCandidate[]; coverage: CoverageRow[];
};

export const PRIORITY_ORDER: Record<BriefingPriority, number> = { urgent: 0, today: 1, soon: 2, later: 3 };
export const KIND_ORDER: Record<BriefingKind, number> = { reply: 0, deadline: 1, followup: 2, information: 3 };
export const KIND_LABEL: Record<BriefingKind, string> = { reply: 'Reply needed', deadline: 'Deadline', followup: 'Follow-up', information: 'For awareness' };
export const PRIORITY_LABEL: Record<BriefingPriority, string> = { urgent: 'Urgent', today: 'Today', soon: 'Soon', later: 'Later' };
const DOMAIN_LABEL: Record<string, string> = { work: 'Work', personal: 'Personal', aa: 'AA' };
const DOMAIN_ORDER = ['work', 'personal', 'aa'];

/** The working day the open time is measured against. Durations include overlaps, so open time can read low. */
export const WORKDAY_HOURS = 8;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.map(record).filter((row): row is Raw => row !== null) : []);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const optional = (value: unknown) => text(value) || null;

/** A link the page can open safely: a web page, or the Linear desktop app. Anything else is dropped. */
export function safeHref(value: unknown): string | null {
  const href = text(value);
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'linear:' ? url.href : null;
  } catch {
    return null;
  }
}

const humanize = (value: string) => value.replaceAll('_', ' ');

function links(row: Raw): BriefingLink[] {
  const found: BriefingLink[] = [];
  const add = (label: string, value: unknown) => {
    const href = safeHref(value);
    if (href && !found.some(link => link.href === href)) found.push({ label, href });
  };
  add(text(row.task_id) ? `${text(row.task_id)} in Linear` : 'Linear task', row.task_url);
  add(text(row.reference_label) || 'Reference', row.reference_url);
  add('Source email', row.source_url);
  return found;
}

function item(row: Raw, domain: string, index: number): BriefingItem | null {
  const title = text(row.title);
  if (!title) return null;
  const priority = text(row.priority) as BriefingPriority;
  const kind = text(row.kind) as BriefingKind;
  const status = text(row.status) ? humanize(text(row.status)) : text(row.task_status) || null;
  return {
    key: `${domain}-${index}`, domain, domainLabel: DOMAIN_LABEL[domain] ?? domain, title,
    kind: kind in KIND_ORDER ? kind : 'information', priority: priority in PRIORITY_ORDER ? priority : 'later',
    when: text(row.when), context: text(row.context), nextStep: text(row.next_step), project: optional(row.project),
    links: links(row), freshness: optional(row.observation_status), status,
  };
}

/** The tag beside a calendar entry: its attendee count, or why it is not counted in the hours. */
function entry(row: Raw, index: number, date: string): CalendarEntry {
  const tag = text(row.tag);
  const people = /^\d+$/.test(tag) ? Number(tag) : null;
  const kind: EntryClass = row.dim === true ? 'excluded' : tag === 'own' ? 'own' : 'shared';
  const tagLabel = people !== null ? `${people} ${people === 1 ? 'person' : 'people'}` : tag === 'own' ? 'own block' : tag;
  return { key: `${date}-${index}`, title: text(row.title) || 'Untitled', time: text(row.time), tag, tagLabel, kind };
}

const PRIORITY_RANK: Record<string, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
export const queuePriorityRank = (priority: string) => PRIORITY_RANK[priority.toLowerCase()] ?? 5;

export function parseBriefing(payload: unknown): Briefing | null {
  const root = record(payload);
  const sections = record(root?.sections);
  if (!root || !sections) return null;
  const keys = [...DOMAIN_ORDER.filter(key => key in sections), ...Object.keys(sections).filter(key => !DOMAIN_ORDER.includes(key))];
  const domains = keys.flatMap(key => {
    const section = record(sections[key]);
    if (!section) return [];
    const items = list(section.items).map((row, index) => item(row, key, index)).filter((row): row is BriefingItem => row !== null);
    return [{ key, label: DOMAIN_LABEL[key] ?? key, items, emptyNote: text(section.empty_note) }];
  });

  const work = record(sections.work);
  const summary = record(work?.queue_summary);
  const queueRows = list(work?.queue).map(row => {
    const idle = text(row.updated);
    const days = /^(\d+)d$/.exec(idle);
    return {
      id: text(row.id), title: text(row.title), priority: text(row.priority), status: text(row.status),
      idle, idleDays: days ? Number(days[1]) : null, due: optional(row.due_date), href: safeHref(row.url),
    };
  }).filter(row => row.id);
  const queue = summary || queueRows.length ? {
    rows: queueRows, open: summary ? count(summary.open) : queueRows.length, high: count(summary?.high), stale: count(summary?.stale),
    stages: list(summary?.stages).map(stage => ({ label: text(stage.label), count: count(stage.count) })).filter(stage => stage.label),
    note: text(summary?.note),
  } : null;

  const week = record(root.week);
  const days = list(week?.days).map(day => {
    const date = text(day.date);
    return {
      date, dow: text(day.dow), day: text(day.day), today: day.today === true, weekend: day.weekend === true,
      shared: count(day.shared_hours), solo: count(day.solo_hours), counted: count(day.counted_entries),
      entries: list(day.entries).map((row, index) => entry(row, index, date)),
    };
  }).filter(day => day.date);

  const inbox = record(root.inbox);
  return {
    dateLabel: text(root.date_label), timeLabel: text(root.time_label), notice: text(root.notice), domains, queue,
    week: days.length ? { days, note: text(week?.note) } : null,
    inbox: inbox ? {
      windowLabel: text(inbox.window_label), total: count(inbox.total),
      figures: list(inbox.figures).map(figure => ({ n: count(figure.n), label: text(figure.k), hint: text(figure.hint), hot: figure.hot === true })).filter(figure => figure.label),
      classes: list(inbox.classes).map(row => ({ label: text(row.label), count: count(row.count) })).filter(row => row.label),
      note: text(inbox.note),
      senders: list(inbox.top_senders).map(row => ({ address: text(row.address), count: count(row.count) })).filter(row => row.address),
    } : null,
    candidates: list(root.candidates).map((row, index) => ({
      key: `candidate-${index}`, domain: text(row.domain), sender: text(row.sender), reason: text(row.reason), action: text(row.action),
    })).filter(row => row.sender),
    coverage: list(root.coverage).map((row, index) => ({
      key: `coverage-${index}`, source: text(row.source), status: text(row.status), detail: text(row.detail), agent: text(row.agent), at: text(row.at),
    })).filter(row => row.source),
  };
}

const byRank = (a: BriefingItem, b: BriefingItem) =>
  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

/**
 * What needs the day: everything marked urgent or for today, across every domain, urgent first and then
 * replies, deadlines, follow-ups and notices. Within a rank the producer's own order stands.
 */
export function focusItems(briefing: Briefing): BriefingItem[] {
  return briefing.domains.flatMap(domain => domain.items)
    .filter(row => row.priority === 'urgent' || row.priority === 'today')
    .map((row, index) => ({ row, index }))
    .sort((a, b) => byRank(a.row, b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/** A domain's items grouped under their priority, in priority order, each group ranked the same way. */
export function priorityGroups(items: BriefingItem[]) {
  return (Object.keys(PRIORITY_ORDER) as BriefingPriority[]).map(priority => ({
    priority,
    items: items.map((row, index) => ({ row, index })).filter(({ row }) => row.priority === priority)
      .sort((a, b) => KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] || a.index - b.index).map(({ row }) => row),
  })).filter(group => group.items.length);
}

/**
 * A day's hours: time with others, your own blocks, and on a weekday what an eight-hour day leaves open.
 * The producer counts overlapping entries in full, so open time is floored at zero rather than negative.
 */
export function dayLoad(day: Pick<CalendarDay, 'shared' | 'solo' | 'weekend'>) {
  const booked = day.shared + day.solo;
  return { booked, open: day.weekend ? null : Math.max(0, WORKDAY_HOURS - booked), scale: Math.max(WORKDAY_HOURS, booked) };
}

export const hours = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)}h`;

/** How a coverage status reads: settled, degraded, or missing. */
export function coverageTone(status: string): 'complete' | 'partial' | 'missing' {
  const value = status.toLowerCase();
  if (/unavailable|failed|error|http \d{3}/.test(value)) return 'missing';
  if (/stale|partial|pending|gap|not refreshed/.test(value)) return 'partial';
  return 'complete';
}
