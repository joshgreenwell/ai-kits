import { z } from 'zod';
import { checkEnvelope, reportEnvelope, reportSchema, type ReportInput, type ReportKind } from './contracts';
import { reportContract, type ContractId, type Enforcement, type PublishedContract } from './kits';

/*
 * Each report kind's payload, as the board reads it. The envelope is shared (`contracts.ts`); these
 * contracts cover the whole request body so a producer can validate what it posts in one step.
 * Objects are loose: a producer may send fields the board does not read yet. `npm run contracts`
 * writes each one to lib/generated/contracts/ as JSON Schema, with its example beside it.
 */

const text = z.string();
const href = z.string().describe('An https:, http: or linear: URL. Any other address is dropped.');

const briefingItem = z.looseObject({
  title: z.string().min(1),
  priority: z.enum(['urgent', 'today', 'soon', 'later']).optional(),
  kind: z.enum(['reply', 'deadline', 'followup', 'information']).optional(),
  when: text.optional(),
  context: text.optional(),
  next_step: text.optional(),
  project: text.optional(),
  task_id: text.optional(),
  task_url: href.optional(),
  task_status: text.optional(),
  reference_label: text.optional(),
  reference_url: href.optional(),
  source_url: href.optional(),
  observation_status: text.optional().describe('How current the item is, such as "Not refreshed September 22".'),
  status: text.optional().describe('A tracked disposition such as needs_review.'),
});
const briefingDomain = z.looseObject({
  items: z.array(briefingItem).optional(),
  empty_note: text.optional(),
});
const workDomain = briefingDomain.extend({
  queue: z.array(z.looseObject({
    id: z.string().min(1),
    title: text.optional(),
    priority: text.optional(),
    status: text.optional(),
    updated: z.string().regex(/^\d+d$/).optional().describe('Days since the last update, as "4d".'),
    due_date: text.optional(),
    url: href.optional(),
  })).optional(),
  queue_summary: z.looseObject({
    open: z.number().optional(),
    high: z.number().optional(),
    stale: z.number().optional(),
    stages: z.array(z.looseObject({ label: z.string().min(1), count: z.number() })).optional(),
    note: text.optional(),
  }).optional(),
});
const tasksPayload = z.looseObject({
  date_label: text.optional(),
  time_label: text.optional(),
  notice: text.optional(),
  markdown: text.optional(),
  sections: z.object({ work: workDomain.optional(), personal: briefingDomain.optional(), aa: briefingDomain.optional() })
    .catchall(briefingDomain).describe('One entry per domain. work, personal and aa are drawn first, in that order.'),
  week: z.looseObject({
    days: z.array(z.looseObject({
      date: z.string().min(1),
      dow: text.optional(),
      day: text.optional(),
      today: z.boolean().optional(),
      weekend: z.boolean().optional(),
      shared_hours: z.number().optional(),
      solo_hours: z.number().optional(),
      counted_entries: z.number().optional(),
      entries: z.array(z.looseObject({
        title: text.optional(),
        time: text.optional(),
        tag: z.union([z.string(), z.number()]).optional().describe('The attendee count, or "own" for your own block.'),
        dim: z.boolean().optional().describe('True when the entry is not counted in the hours.'),
      })).optional(),
    })).optional(),
    note: text.optional(),
  }).optional(),
  inbox: z.looseObject({
    window_label: text.optional(),
    total: z.number().optional(),
    figures: z.array(z.looseObject({ n: z.number(), k: z.string().min(1), hint: text.optional(), hot: z.boolean().optional() })).optional(),
    classes: z.array(z.looseObject({ label: z.string().min(1), count: z.number() })).optional(),
    note: text.optional(),
    top_senders: z.array(z.looseObject({ address: z.string().min(1), count: z.number() })).optional(),
  }).optional(),
  candidates: z.array(z.looseObject({ domain: text.optional(), sender: z.string().min(1), reason: text.optional(), action: text.optional() })).optional(),
  coverage: z.array(z.looseObject({ source: z.string().min(1), status: text.optional(), detail: text.optional(), agent: text.optional(), at: text.optional() })).optional()
    .describe('Source coverage. The publisher also copies it into the envelope as coverage.sources.'),
});

const markdownPayload = z.looseObject({ markdown: z.string().regex(/\S/, 'Must not be blank') });

const readingsPayload = markdownPayload.extend({ source: text.optional().describe('Names the task that wrote the edition.') });

/** Each kind's full request body: the envelope with that kind's payload. */
function body(payload: z.ZodType, extra: z.ZodRawShape = {}) {
  return reportEnvelope.extend({ payload, ...extra }).superRefine(checkEnvelope);
}

const produced = '2026-09-29T09:05:00-05:00';
const envelopeExample = {
  schema_version: 1, period_key: '2026-09-29', subject_key: 'example-owner', title: 'Daily briefing', produced_at: produced, status: 'complete',
} as const;

export const reportContractRegistry = {
  'report-envelope-v1': {
    id: 'report-envelope-v1',
    title: 'Report envelope',
    summary: 'What every report kind posts to /api/v1/reports/:kind. The payload is checked by the kind\'s own contract.',
    schema: body(z.record(z.string(), z.unknown())),
    example: { ...envelopeExample, idempotency_key: 'example-envelope-2026-09-29', title: 'Example report', coverage: {}, payload: { markdown: 'Example report body.' } },
  },
  'tasks-v1': {
    id: 'tasks-v1',
    title: 'Daily briefing',
    summary: 'The structured briefing /tasks draws natively. A revision without sections falls back to its HTML.',
    schema: body(tasksPayload),
    example: {
      ...envelopeExample, idempotency_key: 'example-tasks-2026-09-29', status: 'partial',
      coverage: { sources: [{ source: 'Mail', status: 'complete' }, { source: 'Calendar', status: 'stale since 08:00' }] },
      payload: {
        date_label: 'Tuesday, September 29', time_label: '9:05 AM', notice: 'Calendar was refreshed at 8:00 AM.',
        sections: {
          work: {
            items: [
              { title: 'Reply to the vendor about the renewal', priority: 'today', kind: 'reply', when: 'By noon', context: 'They asked for a decision on the annual plan.', next_step: 'Confirm the seat count.', project: 'Example project', source_url: 'https://mail.example.com/message/1' },
              { title: 'Review the deployment checklist', priority: 'soon', kind: 'followup', task_id: 'EX-12', task_url: 'https://linear.app/example/issue/EX-12', task_status: 'In Review' },
            ],
            queue: [{ id: 'EX-12', title: 'Deployment checklist', priority: 'High', status: 'In Review', updated: '3d', url: 'https://linear.app/example/issue/EX-12' }],
            queue_summary: { open: 1, high: 1, stale: 0, stages: [{ label: 'In Review', count: 1 }], note: 'One item waits on review.' },
          },
          personal: { items: [], empty_note: 'Nothing personal needs today.' },
        },
        week: {
          days: [{ date: '2026-09-29', dow: 'Tue', day: '29', today: true, weekend: false, shared_hours: 2, solo_hours: 1.5, counted_entries: 3,
            entries: [{ title: 'Team sync', time: '10:00', tag: '6' }, { title: 'Focus block', time: '13:00', tag: 'own' }] }],
          note: 'Durations include overlaps.',
        },
        inbox: { window_label: 'Last 24 hours', total: 14, figures: [{ n: 2, k: 'Need a reply', hot: true }], classes: [{ label: 'Newsletters', count: 6 }], top_senders: [{ address: 'news@example.com', count: 4 }] },
        candidates: [{ domain: 'personal', sender: 'news@example.com', reason: 'Six unread issues', action: 'Unsubscribe' }],
        coverage: [{ source: 'Mail', status: 'complete' }, { source: 'Calendar', status: 'stale since 08:00' }],
      },
    },
  },
  'standup-v1': {
    id: 'standup-v1',
    title: 'Standup',
    summary: 'The final standup text, shown above the same day\'s briefing on /tasks.',
    schema: body(markdownPayload),
    example: { ...envelopeExample, idempotency_key: 'example-standup-2026-09-29', title: 'Standup', coverage: {}, payload: { markdown: 'Yesterday: shipped the checklist.\nToday: renewal reply and review.\nBlockers: none.' } },
  },
  'readings-v1': {
    id: 'readings-v1',
    title: 'Daily readings',
    summary: 'The readings edition as markdown. /readings parses its sections; the HTML edition is optional.',
    schema: body(readingsPayload),
    example: {
      ...envelopeExample, idempotency_key: 'example-readings-2026-09-29', title: 'Daily readings', coverage: { window: '2026-09-28T09:00:00-05:00/2026-09-29T09:00:00-05:00' },
      payload: { source: 'Example scheduled task', markdown: '# Daily Tech / AI / Crypto Snapshot — 2026-09-29\n\n## Executive Snapshot\n- A model release and a protocol update.\n\n## Worth Looking At\n**[AI] An example release — Example Lab**\nLink: [Notes](https://example.com/notes)\nSummary: What changed and why it matters.\n' },
    },
  },
  'audit-v1': {
    id: 'audit-v1',
    title: 'AI audit',
    summary: 'An HTML report, served sandboxed. coverage.presentation "full-audit" marks the report /audit opens by default.',
    schema: body(z.looseObject({ markdown: text.optional() }), {
      html: z.string().min(1).max(3_500_000),
      coverage: z.looseObject({ presentation: text.optional().describe('"full-audit" for a complete scored assessment.') }).default({}),
    }),
    example: {
      ...envelopeExample, idempotency_key: 'example-audit-2026-09-29', title: 'AI audit · September 29', coverage: { presentation: 'full-audit' },
      payload: { markdown: 'Summary of the audit.' }, html: '<!doctype html><title>Example audit</title><h1>Example audit</h1>',
    },
  },
} as const satisfies Partial<Record<ContractId, PublishedContract>>;

export type ReportContractId = keyof typeof reportContractRegistry;

export type ContractIssue = { path: (string | number)[]; message: string };
export type ContractResult = { id: ContractId; enforcement: Enforcement; valid: boolean; issues: ContractIssue[] };

const MAX_ISSUES = 20;
const issuesOf = (error: z.ZodError): ContractIssue[] =>
  error.issues.slice(0, MAX_ISSUES).map(({ path, message }) => ({ path: path.map(part => typeof part === 'symbol' ? String(part) : part), message }));

/** Checks an envelope-valid report against its kind's payload contract. */
export function checkReportContract(kind: Exclude<ReportKind, 'usage'>, report: ReportInput | unknown): ContractResult {
  const { contract: id, enforcement } = reportContract(kind);
  const result = reportContractRegistry[id as ReportContractId].schema.safeParse(report);
  return { id, enforcement, valid: result.success, issues: result.success ? [] : issuesOf(result.error) };
}

export type ReportValidation = {
  kind: Exclude<ReportKind, 'usage'>;
  /** Whether ingestion would store this body today: a valid envelope, and a matching payload unless the contract is only observed. */
  accepted: boolean;
  envelope: { valid: boolean; issues: ContractIssue[] };
  contract: ContractResult;
};

/** What POST /api/v1/reports/:kind would decide about a body, without storing it. */
export function validateReport(kind: Exclude<ReportKind, 'usage'>, body: unknown): ReportValidation {
  const envelope = reportSchema.safeParse(body);
  // Ingestion checks the contract against the parsed envelope, defaults applied; so does this.
  const contract = checkReportContract(kind, envelope.success ? envelope.data : body);
  return {
    kind,
    accepted: envelope.success && (contract.valid || contract.enforcement === 'observe'),
    envelope: { valid: envelope.success, issues: envelope.success ? [] : issuesOf(envelope.error) },
    contract,
  };
}
