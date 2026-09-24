import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredReport } from '../lib/contracts';
import { DailyBriefing, FOCUS_LIMIT } from '../components/daily-briefing';
import { coverageTone, dayLoad, focusItems, hours, parseBriefing, priorityGroups, safeHref } from '../lib/daily-briefing';

const payload = {
  date_label: 'Tuesday, September 22, 2026', time_label: '09:18 Central', notice: '',
  sections: {
    // Out of the page's order on purpose: Work, Personal, AA is the order drawn.
    aa: { items: [
      { title: 'District meeting', priority: 'later', kind: 'information', when: 'Oct 14' },
      { title: 'Answer the treasurer', priority: 'today', kind: 'reply', when: 'Sep 20' },
    ] },
    work: {
      items: [
        { title: 'Review the HR notice', priority: 'today', kind: 'followup', when: 'Sep 18', observation_status: 'Thread reread; external completion unverified' },
        { title: 'Vanta tasks overdue', priority: 'urgent', kind: 'deadline', when: 'Observed Sep 21', observation_status: 'Not refreshed September 22',
          source_url: 'https://mail.example.com/1', reference_url: 'javascript:alert(1)', task_url: 'linear://team/issue/JG-1', task_id: 'JG-1' },
        { title: 'Reply to the auditor', priority: 'today', kind: 'reply', when: 'Sep 21', source_url: 'https://mail.example.com/2', reference_url: 'https://mail.example.com/2' },
        { title: 'Unknown shape', priority: 'someday', kind: 'musing' },
        { priority: 'urgent', kind: 'reply' },
      ],
      queue: [{ id: 'LUUM-1', title: 'Add terraform access', priority: 'Highest', status: 'To Do', updated: '264d', url: 'https://jira.example.com/LUUM-1' }],
      queue_summary: { open: 1, high: 1, stale: 1, stages: [{ label: 'qa', count: 1 }], note: 'STALE — last verified September 21.' },
    },
    personal: { items: [], empty_note: 'Nothing personal today.' },
  },
  week: {
    note: 'September 22–28 · America/Chicago.',
    days: [
      { date: '2026-09-22', dow: 'Tue', day: '22', today: true, shared_hours: 6, solo_hours: 3.5, entries: [
        { title: 'Sync', time: '9:30 AM', tag: '4' }, { title: 'Focus', time: '1:00 PM', tag: 'own' }, { title: 'Lunch', time: '12:00 PM', tag: 'free', dim: true },
        { title: 'One on one', time: '3:00 PM', tag: '1' },
      ] },
      { date: '2026-09-26', dow: 'Sat', day: '26', weekend: true, shared_hours: 0, solo_hours: 2, entries: [] },
    ],
  },
  inbox: { window_label: 'Historical — NOT refreshed September 22.', total: 10, figures: [{ n: 10, k: 'Arrived', hint: 'as observed' }, { n: 3, k: 'Days overdue', hot: true }],
    classes: [{ label: 'Never actionable', count: 6 }, { label: 'A person wrote it', count: 4 }], top_senders: [{ address: 'alerts@example.com', count: 5 }], note: 'Triage.' },
  candidates: [{ domain: 'work', sender: 'news@example.com', reason: 'Daily reading material.', action: 'Unsubscribe candidate.' }],
  coverage: [
    { source: 'Work · Outlook mail', status: 'Unavailable today', detail: 'No reader.', agent: 'Codex', at: '2026-09-22T14:18:00Z' },
    { source: 'Outlook calendar', status: 'Complete requested window', detail: '27 events.' },
    { source: 'AA · Gmail', status: 'Overlap complete; attachment gaps remain' },
    { source: 'Linear', status: 'Native read complete; writes held' },
  ],
};

const report = {
  id: 'r1', kind: 'tasks', producer_id: 'p', subject_key: 'daily', period_key: '2026-09-22', title: 'Daily briefing', status: 'partial',
  produced_at: '2026-09-22T14:18:00Z', received_at: '2026-09-22T14:18:00Z', content_hash: 'h', schema_version: 1,
  payload: { markdown: '# Briefing' }, html: 'available', coverage: [],
} as unknown as StoredReport;
const standup = { ...report, id: 's1', kind: 'standup', payload: { markdown: '## Yesterday\n\n- Fixed the thing' }, html: undefined } as unknown as StoredReport;

test('a payload without sections is not a structured briefing, so the page keeps the published report', () => {
  assert.equal(parseBriefing(null), null);
  assert.equal(parseBriefing({ markdown: '# Briefing' }), null);
  assert.equal(parseBriefing({ sections: [] }), null, 'an array is not a record of sections');
});

test('items are read defensively: unknown values fall back, untitled rows drop, and only safe links survive', () => {
  const briefing = parseBriefing(payload)!;
  assert.deepEqual(briefing.domains.map(domain => domain.key), ['work', 'personal', 'aa']);
  const work = briefing.domains[0].items;
  assert.equal(work.length, 4, 'the untitled row is dropped');
  const unknown = work.find(row => row.title === 'Unknown shape')!;
  assert.equal(unknown.priority, 'later');
  assert.equal(unknown.kind, 'information');
  const vanta = work.find(row => row.title === 'Vanta tasks overdue')!;
  assert.deepEqual(vanta.links.map(link => link.label), ['JG-1 in Linear', 'Source email'], 'the javascript: reference is dropped');
  const auditor = work.find(row => row.title === 'Reply to the auditor')!;
  assert.equal(auditor.links.length, 1, 'a reference that repeats the source email is shown once');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('data:text/html,hi'), null);
  assert.equal(safeHref('linear://team/issue/JG-1'), 'linear://team/issue/JG-1');
  assert.equal(briefing.domains[1].emptyNote, 'Nothing personal today.');
  assert.equal(briefing.queue?.rows[0].idleDays, 264);
});

test('focus is everything urgent or for today across areas: urgent first, then replies, deadlines and follow-ups', () => {
  const briefing = parseBriefing(payload)!;
  assert.deepEqual(focusItems(briefing).map(row => row.title), ['Vanta tasks overdue', 'Reply to the auditor', 'Answer the treasurer', 'Review the HR notice']);
  assert.deepEqual(priorityGroups(briefing.domains[0].items).map(group => group.priority), ['urgent', 'today', 'later'], 'empty groups are left out');
});

test('a day reads as time with others, own blocks, and what an eight-hour day leaves open', () => {
  const [tuesday, saturday] = parseBriefing(payload)!.week!.days;
  assert.deepEqual(dayLoad(tuesday), { booked: 9.5, open: 0, scale: 9.5 }, 'overlaps can overbook a day; open time is floored at zero');
  assert.equal(dayLoad(saturday).open, null, 'a weekend has no working day to leave open');
  assert.deepEqual(tuesday.entries.map(entry => `${entry.kind}:${entry.tagLabel}`), ['shared:4 people', 'own:own block', 'excluded:free', 'shared:1 person']);
  assert.equal(hours(2), '2h');
  assert.equal(hours(1.25), '1.3h');
});

test('a coverage status reads as complete, partial or missing', () => {
  assert.deepEqual(parseBriefing(payload)!.coverage.map(row => coverageTone(row.status)), ['missing', 'complete', 'partial', 'complete']);
  assert.equal(coverageTone('HTTP 504 on both requests'), 'missing');
  assert.equal(coverageTone('Stale snapshot'), 'partial');
});

test('the page leads with what needs you today, beside the day and the standup', () => {
  const briefing = parseBriefing(payload)!;
  const html = renderToStaticMarkup(createElement(DailyBriefing, { report, briefing, standup }));
  const titles = [...html.matchAll(/data-slot="card-title"[^>]*>([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(titles, ['Focus today', 'Your day', 'Standup', 'Everything in the briefing', 'Jira queue', 'Inbox signal', 'Sources and coverage'], 'every card renders, in reading order');
  const focus = [...html.matchAll(/data-testid="focus-([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(focus, ['work-1', 'work-2', 'aa-1', 'work-0']);
  assert.ok(focus.length <= FOCUS_LIMIT);
  assert.match(html, /4 items need you today across Work, AA/);
  assert.match(html, />Urgent<\/span><span[^>]*text-destructive[^>]*>1</);
  assert.match(html, /not refreshed/, 'a stale reading is flagged');
  assert.match(html, /href="\/api\/artifacts\/r1"[^>]*target="_blank"/, 'the authored report opens on its sandboxed route');
  assert.match(html, /aria-current="date"/);
  assert.match(html, /2 of 4 sources read in full for this briefing, 1 partial or stale, 1 unavailable\./);
  assert.match(html, />QA</, 'a short stage label reads as an initialism');
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.doesNotMatch(html, /<iframe/, 'the authored HTML is never embedded');
});
