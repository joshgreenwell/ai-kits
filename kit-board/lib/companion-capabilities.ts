import { z } from 'zod';
import { adapters, archs, platforms } from './usage-contract';

/**
 * What a companion build can actually do (`POST /api/v1/companion/capabilities`).
 * Every field is a closed code, flag, bounded count, id, or date; the document never
 * carries a path, host, credential, or a hash of any of them. The Rust mirror lives in
 * `companion/crates/observatory-contract/src/capabilities.rs`, and both sides check
 * the same fixtures under `tests/fixtures/usage-v2/capabilities/`.
 */
const code = z.string().regex(/^[a-z0-9_.:-]{1,64}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A deny-list entry the companion recognized: an adapter id, `providers.<p>`, or a mode path. */
const modePath = z.string().regex(/^[a-z_]+(\.[a-z_]+){0,2}$/).max(64);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const scheduleStates = ['not_installed', 'installed', 'interval_mismatch', 'unreadable'] as const;
export const schedulers = ['launchd', 'task_scheduler', 'systemd'] as const;

export const companionCapabilitiesSchema = z.object({
  schema_version: z.literal(1),
  companion_version: z.string().min(1).max(30),
  /** sha256 of the stable JSON of `adapters` and `features`: the build fingerprint. */
  capabilities_digest: z.string().regex(/^[a-f0-9]{64}$/),
  build: z.object({
    platform: z.enum(platforms), arch: z.enum(archs), tls_roots: code, state_schema_version: code,
  }).strict(),
  adapters: z.array(z.object({
    adapter: z.enum(adapters), implemented: z.boolean(), modes: z.array(code).max(8),
    parser_version: z.string().max(30), denied: z.boolean(),
  }).strict()).max(adapters.length),
  features: z.object({
    detail_levels: z.array(code).max(8), tool_detail: z.array(code).max(8), project_attribution: z.array(code).max(8),
    resource_attribution: z.boolean(), include_subagents: z.boolean(), hooks: z.array(code).max(8),
    schedulers: z.array(z.enum(schedulers)).max(3),     live_mode: z.boolean(), detailed_monthly_report: z.boolean(),
    account_history: z.boolean(),
    claude_oauth_keepalive: z.boolean().default(false),
    /** Sends `name.label`, `project.catalog` and `project.membership` records (companion 2.2.0). Absent on older builds. */
    labels: z.boolean().optional(),
  }).strict(),
  effective: z.object({
    settings_version_applied: counter, config_source: z.enum(['fetched', 'cached', 'defaults']), paused: z.boolean(),
    cadence_minutes: counter, detail_level: code, tool_detail: code, project_attribution: code, include_subagents: z.boolean(),
    resource_attribution: z.enum(['on', 'no_resources', 'denied_locally', 'detail_level']), resources_configured: counter,
    readers: z.object({ claude: code, codex: code, cursor: code }).strict(),
  }).strict(),
  deny: z.array(modePath).max(32),
  deny_unrecognized: counter,
  discovered: z.object({ claude: z.boolean(), codex: z.boolean(), cursor: z.boolean() }).strict(),
  bindings: z.array(z.object({
    binding_id: z.uuid(), identity: z.enum(['confirmed', 'unconfirmed', 'changed']), conflict: z.boolean(), roots_present: counter,
  }).strict()).max(50),
  detailed_report: z.array(z.object({
    binding_id: z.uuid(), configured: z.boolean(), machine_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/).nullable(),
    last_status: code.nullable(), last_error_code: code.nullable(),
  }).strict()).max(50),
  schedule: z.object({
    mechanism: z.enum(schedulers).nullable(), state: z.enum(scheduleStates),
    installed_interval_minutes: counter.nullable(), config_dir_pinned: z.boolean(),
  }).strict(),
  queue: z.object({ records_pending: counter, records_rejected: counter, outbox_envelopes: counter }).strict(),
  backfill: z.object({ since: date.nullable(), complete: z.boolean(), last_partial_adapter: z.enum(adapters).nullable() }).strict(),
}).strict();

export type CompanionCapabilities = z.infer<typeof companionCapabilitiesSchema>;
