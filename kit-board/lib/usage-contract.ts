import { z } from 'zod';
import { bucketSchema } from './telemetry-contract';

/**
 * Envelope v2 (`POST /api/v1/usage`): the single authority for the cross-language
 * usage contract. The JSON Schema in `lib/generated/usage-v2.schema.json` is
 * generated from `usageEnvelopeSchema` (`npm run usage-schema`), vendored into the
 * companion, and diff-gated in CI. Every counter that is unknown is `null`, never 0.
 */
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const stamp = z.iso.datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 300_000, 'Observation is in the future');

export const adapters = ['claude_execution','claude_account','codex_execution','codex_account',
  'cursor_account','cursor_execution','anthropic_api','openai_api',
  'claude_browser','codex_browser','cursor_browser'] as const;
export const channels = ['local_file','local_db','app_server','provider_api','hook_snapshot','browser_session'] as const;
export const providers = ['claude','codex','cursor','anthropic_api','openai_api'] as const;
export const installKinds = ['companion','browser'] as const;
export const platforms = ['darwin','windows','linux','unknown'] as const;
export const archs = ['arm64','amd64','unknown'] as const;
const uuid = z.uuid(), sha256 = z.string().regex(/^[a-f0-9]{64}$/), code = z.string().regex(/^[a-z0-9_.:-]{1,64}$/);
const nullableCounter = counter.nullable();
const privacySafeName = z.string().regex(/^([a-zA-Z0-9_.-]{1,80}|h:[a-f0-9]{16})$/);

const header = {
  record_id: uuid,
  binding_id: uuid,
  adapter: z.enum(adapters), channel: z.enum(channels),
  observed_at: stamp,
  basis: z.enum(['exact','reported','estimated','unknown']),
  parser_version: z.string().max(30),
};

/** Optional v2 extension blocks are all-or-nothing: absent means a legacy producer. */
export const pricingEvidenceSchema = z.object({
  reasoning_effort: code.nullable(),
  service_tier: code.nullable(),
  speed: code.nullable(),
  context_window_tokens: nullableCounter,
  cache_write_ttl: code.nullable(),
}).strict();

export const tokenAccountingSchema = z.object({
  reported_total: nullableCounter,
  unclassified: nullableCounter,
  composition_state: z.enum(['complete','partial','inconsistent','unknown']),
}).strict();

export const agentAttributionSchema = z.object({
  key: sha256.nullable(),
  identity_basis: z.enum(['provider','derived','synthetic','unknown']),
  parent_key: sha256.nullable(),
  parent_identity_basis: z.enum(['provider','derived','synthetic','none','unknown']),
  class: z.enum(['main','builtin','custom','unknown']),
  name: privacySafeName.nullable(),
  depth: nullableCounter,
}).strict().superRefine((agent, ctx) => {
  if ((agent.identity_basis === 'unknown') !== (agent.key === null)) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: 'Agent key must match its identity basis' });
  }
  const parentAbsent = agent.parent_identity_basis === 'none' || agent.parent_identity_basis === 'unknown';
  if (parentAbsent !== (agent.parent_key === null)) {
    ctx.addIssue({ code: 'custom', path: ['parent_key'], message: 'Parent agent key must match its identity basis' });
  }
});

export const projectAttributionSchema = z.object({
  key: sha256.nullable(),
  basis: z.enum(['native','working_directory','none','unknown']),
}).strict().superRefine((project, ctx) => {
  const requiresKey = project.basis === 'native' || project.basis === 'working_directory';
  if (requiresKey !== (project.key !== null)) {
    ctx.addIssue({ code: 'custom', path: ['key'], message: 'Project key must match its attribution basis' });
  }
});

type TokenEvidence = { input_fresh: number | null; input_cached: number | null; input_cache_write: number | null;
  output: number | null; reasoning: number | null };
function validateTokenAccounting(tokens: TokenEvidence, accounting: z.infer<typeof tokenAccountingSchema>,
  issue: (path: string, message: string) => void) {
  const components = [tokens.input_fresh, tokens.input_cached, tokens.input_cache_write, tokens.output];
  const known = components.filter((value): value is number => value !== null);
  const knownSum = known.reduce((sum, value) => sum + value, 0);
  const allKnown = known.length === components.length;
  const noneKnown = known.length === 0;
  const noTokenEvidence = noneKnown && tokens.reasoning === null;
  const { reported_total: reported, unclassified, composition_state: state } = accounting;
  const minimumTotal = (tokens.input_fresh ?? 0) + (tokens.input_cached ?? 0) + (tokens.input_cache_write ?? 0)
    + (tokens.output ?? tokens.reasoning ?? 0);
  const exceedsReported = reported !== null && minimumTotal > reported;
  if (state === 'complete') {
    if (!allKnown) issue('composition_state', 'Complete composition requires all exclusive token components');
    if (exceedsReported) issue('composition_state', 'Known token evidence exceeds the reported total');
    if (reported === null ? unclassified !== null : unclassified !== reported - knownSum) {
      issue('unclassified', 'Unclassified tokens must equal the reported remainder');
    }
  } else if (state === 'partial') {
    if (allKnown || (noTokenEvidence && reported === null)) issue('composition_state', 'Partial composition requires incomplete token evidence');
    if (reported !== null) {
      if (exceedsReported) issue('composition_state', 'Known token evidence exceeds the reported total');
      if (unclassified !== reported - knownSum) issue('unclassified', 'Unclassified tokens must equal the reported remainder');
    } else if (unclassified !== null) issue('unclassified', 'A partial composition without a reported total has no known remainder');
  } else if (state === 'inconsistent') {
    if (reported === null || !exceedsReported) issue('composition_state', 'Inconsistent composition requires known token evidence above a reported total');
    if (unclassified !== null) issue('unclassified', 'Inconsistent composition cannot have a remainder');
  } else {
    if (!noTokenEvidence || reported !== null || unclassified !== null) issue('composition_state', 'Unknown composition cannot contain token evidence');
  }
}

export const activityRequestSchema = z.object({ ...header, record_type: z.literal('activity.request'),
  semantic_key: sha256,
  product: code, surface: z.enum(['cli','ide','desktop','sdk','ci','cloud','unknown']),
  execution_host: z.enum(['local','cloud','self_hosted','unknown']),
  session_hash: sha256, session_identity: z.enum(['provider','derived','synthetic']),
  parent_session_hash: sha256.nullable(),
  model_requested: z.string().max(100).nullable(), model_actual: z.string().min(1).max(100).nullable(),
  started_at: stamp.nullable(), ended_at: stamp.nullable(),
  tokens: z.object({ input_fresh: nullableCounter, input_cached: nullableCounter,
    input_cache_write: nullableCounter, output: nullableCounter, reasoning: nullableCounter }).strict(),
  token_accounting: tokenAccountingSchema.optional(),
  pricing: pricingEvidenceSchema.optional(),
  agent: agentAttributionSchema.optional(),
  tool_calls: nullableCounter,
  tools: z.array(z.object({ name: privacySafeName, calls: counter }).strict()).max(50).optional(),
  project: projectAttributionSchema.optional(),
  project_hash: sha256.nullable(), client_version: z.string().max(40).nullable(),
  latency_ms: nullableCounter, outcome: z.enum(['completed','failed','cancelled','unknown']),
}).strict().superRefine((request, ctx) => {
  if (request.tokens.reasoning !== null && request.tokens.output !== null && request.tokens.reasoning > request.tokens.output) {
    ctx.addIssue({ code: 'custom', path: ['tokens','reasoning'], message: 'Reasoning is a subset of output' });
  }
  if (request.token_accounting) {
    validateTokenAccounting(request.tokens, request.token_accounting,
      (path, message) => ctx.addIssue({ code: 'custom', path: ['token_accounting', path], message }));
  }
  if (request.project) {
    const aliasMatches = request.project.basis === 'working_directory'
      ? request.project.key === request.project_hash
      : request.project_hash === null;
    if (!aliasMatches) ctx.addIssue({ code: 'custom', path: ['project_hash'], message: 'Legacy project hash must match project attribution' });
  }
});

export const accountUsageBucketSchema = z.object({ ...header, record_type: z.literal('account.usage_bucket'),
  report_source: code,
  bucket_start: stamp, bucket_end: stamp, provider_timezone: z.string().max(40).nullable(),
  dimensions: z.object({ model: z.string().max(100).nullable(), product: code.nullable(), client: code.nullable(),
    user_ref: sha256.nullable(), workspace_ref: sha256.nullable(), api_key_ref: sha256.nullable(),
    pricing: pricingEvidenceSchema.optional() }).strict(),
  measures: z.object({ requests: nullableCounter, input_tokens: nullableCounter, cached_tokens: nullableCounter,
    cache_write_tokens: nullableCounter, output_tokens: nullableCounter, reasoning_tokens: nullableCounter,
    total_tokens: nullableCounter }).strict(),
  token_accounting: tokenAccountingSchema.optional(),
  provider_event_id: z.string().max(120).nullable(), provider_refreshed_at: stamp.nullable(),
}).strict().superRefine((bucket, ctx) => {
  if (Date.parse(bucket.bucket_end) <= Date.parse(bucket.bucket_start)) {
    ctx.addIssue({ code: 'custom', path: ['bucket_end'], message: 'Empty bucket' });
  }
  if (bucket.measures.reasoning_tokens !== null && bucket.measures.output_tokens !== null
    && bucket.measures.reasoning_tokens > bucket.measures.output_tokens) {
    ctx.addIssue({ code: 'custom', path: ['measures','reasoning_tokens'], message: 'Reasoning is a subset of output' });
  }
  if (bucket.token_accounting) {
    if (bucket.token_accounting.reported_total !== bucket.measures.total_tokens) {
      ctx.addIssue({ code: 'custom', path: ['token_accounting','reported_total'], message: 'Accounting total must match the provider measure' });
    }
    validateTokenAccounting({ input_fresh: bucket.measures.input_tokens, input_cached: bucket.measures.cached_tokens,
      input_cache_write: bucket.measures.cache_write_tokens, output: bucket.measures.output_tokens,
      reasoning: bucket.measures.reasoning_tokens }, bucket.token_accounting,
    (path, message) => ctx.addIssue({ code: 'custom', path: ['token_accounting', path], message }));
  }
});

export const allowanceReadingSchema = z.object({ ...header, record_type: z.literal('allowance.reading'),
  meter_key: z.string().regex(/^[a-zA-Z0-9._:-]{1,100}$/),
  label: z.string().min(1).max(120),
  kind: z.enum(['percent_used','count_remaining','credits_remaining','currency_allowance','unlimited','unavailable']),
  value: z.number().nullable(), unit: z.enum(['percent','requests','credits','USD']).nullable(),
  capacity: z.number().nullable(),
  window_minutes: z.number().int().positive().max(525600).nullable(),
  window_started_at: stamp.nullable(), resets_at: z.iso.datetime({ offset: true }).nullable(),
  reader: z.enum(['statusline','oauth_usage','app_server','embedded','web_backend','usage_summary','dashboard_rpc']),
  raw_window_id: z.string().max(120).nullable(),
}).strict().refine(r => r.kind !== 'percent_used' || (r.value !== null && r.value >= 0 && r.value <= 100), 'Percent out of range')
  .refine(r => !r.resets_at || Date.parse(r.resets_at) > Date.parse(r.observed_at), 'Expired reading')
  // A window resets within its own length (plus a day of slack); a far-future reset would pin the forecast for weeks.
  .refine(r => !r.resets_at || Date.parse(r.resets_at) <= Date.parse(r.observed_at) + ((r.window_minutes ?? 90 * 1440) * 60 + 86_400) * 1000, 'Reset beyond window');

export const moneyEntrySchema = z.object({ ...header, record_type: z.literal('money.entry'),
  entry_kind: z.enum(['estimate','included_usage','metered_charge','credit_grant','credit_consumption','adjustment','invoice_line']),
  amount: z.string().regex(/^-?\d{1,12}(\.\d{1,6})?$/),
  unit: z.enum(['USD','credits']), source_unit: code.nullable(),
  price_basis: code,
  period_start: stamp.nullable(), period_end: stamp.nullable(),
  reference: z.object({ kind: z.enum(['activity_request','usage_bucket','provider_event','none']), key: z.string().max(160).nullable() }).strict(),
  sku: code.nullable(), model: z.string().max(100).nullable(),
}).strict();

const eventOutcome = z.enum(['succeeded','failed','denied','cancelled','unknown']);

/** Agent lifecycle evidence remains independent from token-bearing requests. */
export const agentEventSchema = z.object({ ...header, record_type: z.literal('agent.event'),
  semantic_key: sha256,
  event_kind: z.enum(['spawn','start','resume','finish']),
  session_hash: sha256.nullable(),
  agent: agentAttributionSchema,
  tool_invocation_key: sha256.nullable(),
  outcome: eventOutcome,
}).strict().superRefine((event, ctx) => {
  const childMustExist = event.event_kind !== 'spawn' || event.outcome === 'succeeded';
  if (childMustExist && event.agent.key === null) {
    ctx.addIssue({ code: 'custom', path: ['agent','key'], message: 'Observed agent lifecycle events require an agent key' });
  }
});

/** Invocation and result evidence share an invocation key without inflating call counts. */
export const toolEventSchema = z.object({ ...header, record_type: z.literal('tool.event'),
  semantic_key: sha256,
  invocation_key: sha256,
  event_kind: z.enum(['invocation','result']),
  session_hash: sha256.nullable(),
  caller_request_key: sha256.nullable(),
  caller_agent_key: sha256.nullable(),
  parent_invocation_key: sha256.nullable(),
  tool: z.object({
    name: privacySafeName.nullable(),
    namespace: code.nullable(),
    class: z.enum(['builtin','mcp','function','custom','unknown']),
  }).strict(),
  outcome: eventOutcome,
}).strict().superRefine((event, ctx) => {
  const isInvocationIdentity = event.semantic_key === event.invocation_key;
  if ((event.event_kind === 'invocation') !== isInvocationIdentity) {
    ctx.addIssue({ code: 'custom', path: ['semantic_key'], message: 'Invocation and result event identities must remain distinct' });
  }
});

/** Only a configured key and typed evidence leave the machine; never paths, arguments, results, or content. */
export const resourceAccessSchema = z.object({ ...header, record_type: z.literal('resource.access'),
  semantic_key: sha256,
  invocation_key: sha256,
  resource_key: code,
  configuration_version: code.nullable(),
  access_kind: z.enum(['read','search','write','unknown']),
  evidence_basis: z.enum(['explicit_argument','connector','indirect_shell','unknown']),
  outcome: eventOutcome,
}).strict();

export const capabilityCoverageSchema = z.object({
  dimension: z.enum(['requests','token_composition','pricing','project','agent','tool','resource','allowance']),
  state: z.enum(['complete','partial','unsupported','disabled_by_setting','unknown']),
  detail_code: code.nullable(),
}).strict();

export const adapterCoverageSchema = z.object({
  adapter: z.enum(adapters),
  state: z.enum(['ok','partial','disabled_by_setting','denied_locally','prerequisite_missing',
    'credential_unavailable','identity_changed','rate_limited','failed']),
  detail_code: code.nullable(),
  stores_discovered: counter, files: counter, bytes_read: counter, records_emitted: counter,
  malformed: counter, rejected_by_server: counter, duration_ms: counter,
  cursor_state: z.enum(['complete','more','unknown']), probe_requests: counter, parser_version: z.string().max(30),
  capabilities: z.array(capabilityCoverageSchema).max(8).optional(),
}).strict().superRefine((coverage, ctx) => {
  const dimensions = coverage.capabilities?.map(capability => capability.dimension) ?? [];
  if (new Set(dimensions).size !== dimensions.length) {
    ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'Capability dimensions must be unique' });
  }
});

export const usageRecordSchema = z.discriminatedUnion('record_type',
  [activityRequestSchema, accountUsageBucketSchema, allowanceReadingSchema, moneyEntrySchema,
    agentEventSchema, toolEventSchema, resourceAccessSchema]);

export const usageEnvelopeSchema = z.object({
  schema_version: z.literal(2),
  run: z.object({ run_id: uuid, started_at: stamp, finished_at: stamp, companion_version: z.string().max(30),
    platform: z.enum(platforms), arch: z.enum(archs), settings_version: counter }).strict(),
  buckets: z.array(z.object({ binding_id: uuid, bucket: bucketSchema }).strict()).max(500).default([]),
  records: z.array(usageRecordSchema).max(2000).default([]),
  coverage: z.array(adapterCoverageSchema).max(32),
}).strict();

/** Input mode: the defaulted `buckets` and `records` arrays are optional, as zod accepts them. */
export const usageSchemaJson = z.toJSONSchema(usageEnvelopeSchema, { io: 'input' });

export type Adapter = typeof adapters[number];
export type Channel = typeof channels[number];
export type Provider = typeof providers[number];
export type InstallKind = typeof installKinds[number];
export type UsageEnvelope = z.infer<typeof usageEnvelopeSchema>;
export type UsageRecord = UsageEnvelope['records'][number];
export type ActivityRequest = z.infer<typeof activityRequestSchema>;
export type AccountUsageBucket = z.infer<typeof accountUsageBucketSchema>;
export type AllowanceReading = z.infer<typeof allowanceReadingSchema>;
export type MoneyEntry = z.infer<typeof moneyEntrySchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type ToolEvent = z.infer<typeof toolEventSchema>;
export type ResourceAccess = z.infer<typeof resourceAccessSchema>;
export type AdapterCoverage = z.infer<typeof adapterCoverageSchema>;

export type InvalidUsageRecord = { record_id: string; reason: 'invalid' };

/**
 * Parses envelope metadata strictly while allowing identifiable bad records to be
 * rejected individually. A record without a valid observation id still rejects the
 * whole body because the sender could not acknowledge and retire it safely.
 */
export function parseUsageEnvelope(input: unknown): { envelope: UsageEnvelope; invalid: InvalidUsageRecord[] } {
  if (!input || typeof input !== 'object' || !('records' in input) || !Array.isArray((input as { records?: unknown }).records)) {
    return { envelope: usageEnvelopeSchema.parse(input), invalid: [] };
  }
  const candidate = input as Record<string, unknown> & { records: unknown[] };
  if (candidate.records.length > 2000) return { envelope: usageEnvelopeSchema.parse(input), invalid: [] };
  const records: UsageRecord[] = [], invalid: InvalidUsageRecord[] = [];
  for (const value of candidate.records) {
    const parsed = usageRecordSchema.safeParse(value);
    if (parsed.success) records.push(parsed.data);
    else {
      const identity = z.object({ record_id: uuid }).passthrough().safeParse(value);
      if (!identity.success) return { envelope: usageEnvelopeSchema.parse(input), invalid: [] };
      invalid.push({ record_id: identity.data.record_id, reason: 'invalid' });
    }
  }
  return { envelope: usageEnvelopeSchema.parse({ ...candidate, records }), invalid };
}

/** Why one record was refused. A rejected record is never retried by the install. */
export const rejectionReasons = ['binding_not_owned', 'binding_not_enabled', 'identity_changed', 'adapter_not_allowed_for_install',
  'record_type_not_allowed_for_install', 'adapter_provider_mismatch', 'invalid'] as const;
export type RejectionReason = typeof rejectionReasons[number];

/** `claude_*` → claude, `codex_*` → codex, `cursor_*` → cursor, and the two API providers. */
export function adapterProvider(adapter: Adapter): Provider {
  if (adapter === 'anthropic_api' || adapter === 'openai_api') return adapter;
  if (adapter.startsWith('claude_')) return 'claude';
  if (adapter.startsWith('codex_')) return 'codex';
  return 'cursor';
}
export function isBrowserAdapter(adapter: Adapter) { return adapter.endsWith('_browser'); }

/**
 * The value whose stable JSON is hashed into `content_hash`: the record without its
 * observation identity (`record_id`, `binding_id`, `observed_at`, `parser_version`) and,
 * for usage buckets, without `provider_refreshed_at`. The same measurement twice is
 * a duplicate; a changed measurement is a revision.
 */
export function contentSubject(record: UsageRecord): Record<string, unknown> {
  const { record_id: _id, binding_id: _binding, observed_at: _observed, parser_version: _parser, ...rest } = record;
  if (rest.record_type === 'account.usage_bucket') { const { provider_refreshed_at: _refreshed, ...bucket } = rest; return bucket; }
  return rest;
}

/** Pairing and install-side write bodies (section 1.3). */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normalizePairingCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const accountIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
export const pairRequestSchema = z.object({
  code: z.string().trim().min(8).max(9), machine_label: z.string().trim().min(1).max(100),
  kind: z.enum(installKinds), platform: z.enum(platforms), arch: z.enum(archs),
}).strict();
export const bindingRequestSchema = z.object({
  account_id: accountIdSchema, provider: z.enum(providers), account_label: z.string().trim().min(1).max(80),
  identity_hash: sha256.nullable(),
}).strict();
export const identityRequestSchema = z.object({ identity_hash: sha256 }).strict();
export const issuePairingCodeSchema = z.object({ kind: z.enum(installKinds).default('companion'), machine_label: z.string().trim().min(1).max(100) }).strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;
export type BindingRequest = z.infer<typeof bindingRequestSchema>;
