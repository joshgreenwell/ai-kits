import { z } from 'zod';
import type { Adapter, Provider } from './usage-contract';

/**
 * The collection settings document (section 1.4). Settings are stored in the
 * Observatory, edited in the UI, fetched by every install on every run, and
 * further restrictable by a local deny list. A setting can only turn a mode on or
 * off within this schema; it can never name a path, an endpoint, or a command.
 */
export const collectionSettingsSchema = z.object({
  schema_version: z.literal(1),
  paused: z.boolean(),                                           // global kill switch
  cadence_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  providers: z.object({ claude: z.boolean(), codex: z.boolean(), cursor: z.boolean(),
    anthropic_api: z.boolean(), openai_api: z.boolean() }).strict(),
  execution: z.object({
    claude_local_logs: z.boolean(), codex_local_history: z.boolean(), cursor_local_state: z.boolean(),
    include_subagents: z.boolean(),
    detail_level: z.enum(['buckets_only','requests','requests_with_tools']),
    tool_detail: z.enum(['off','builtin_only','hashed_custom']),
    project_attribution: z.enum(['off','hashed']),
  }).strict(),
  allowance: z.object({
    claude_reader: z.enum(['off','statusline','oauth_usage']),   // oauth_usage keeps statusline as passive fallback
    codex_reader: z.enum(['off','embedded','app_server','web_backend']),
    cursor_reader: z.enum(['off','usage_summary','dashboard_rpc']),
  }).strict(),
  account_history: z.object({ cursor_usage_events: z.boolean(), lookback_days: z.number().int().min(1).max(90) }).strict(),
  billing: z.object({ anthropic_admin_api: z.boolean(), openai_admin_api: z.boolean() }).strict(),
  hooks: z.object({ claude_statusline: z.boolean(), cursor_project_hooks: z.boolean() }).strict(),
  browser: z.object({ claude_web: z.boolean(), chatgpt_web: z.boolean(), cursor_web: z.boolean() }).strict(),
  detailed_monthly_report: z.boolean(),                          // existing analyzer adapter, per install
  live_mode: z.boolean(),                                        // serve subcommand; later phase
  local_raw_retention_days: z.union([z.literal(0), z.literal(7), z.literal(14), z.literal(30)]),
  update_notice: z.enum(['off','notify']),                       // never 'auto'
}).strict();
export const installOverrideSchema = collectionSettingsSchema.partial().strict();
export type CollectionSettings = z.infer<typeof collectionSettingsSchema>;
export type InstallOverride = z.infer<typeof installOverrideSchema>;

export const defaultCollectionSettings: CollectionSettings = {
  schema_version: 1, paused: false, cadence_minutes: 60,
  providers: { claude: true, codex: true, cursor: false, anthropic_api: false, openai_api: false },
  execution: { claude_local_logs: true, codex_local_history: true, cursor_local_state: true, include_subagents: true,
    detail_level: 'buckets_only', tool_detail: 'builtin_only', project_attribution: 'off' },
  allowance: { claude_reader: 'statusline', codex_reader: 'app_server', cursor_reader: 'off' },
  account_history: { cursor_usage_events: false, lookback_days: 30 },
  billing: { anthropic_admin_api: false, openai_admin_api: false },
  hooks: { claude_statusline: true, cursor_project_hooks: false },
  browser: { claude_web: false, chatgpt_web: false, cursor_web: false },
  detailed_monthly_report: false, live_mode: false, local_raw_retention_days: 14, update_notice: 'notify',
};

/** Defaults, then the stored global document, then an install override. A present group replaces the whole group. */
export function mergeSettings(global?: Partial<CollectionSettings> | null, override?: InstallOverride | null): CollectionSettings {
  const clean = (value: Partial<CollectionSettings> | null | undefined) =>
    Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v !== undefined)) as Partial<CollectionSettings>;
  return { ...defaultCollectionSettings, ...clean(global), ...clean(override), schema_version: 1 };
}

export type Gate = { enabled: boolean; provider_enabled: boolean; mode_path: string };

/** The server value of one adapter's mode: provider switch AND the adapter's own mode AND not paused. */
export function adapterGate(settings: CollectionSettings, adapter: Adapter): Gate {
  const provider = adapterProviderOf(adapter);
  const provider_enabled = settings.providers[provider];
  const [on, mode_path] = ((): [boolean, string] => {
    switch (adapter) {
      case 'claude_execution': return [settings.execution.claude_local_logs, 'execution.claude_local_logs'];
      case 'codex_execution': return [settings.execution.codex_local_history, 'execution.codex_local_history'];
      case 'cursor_execution': return [settings.execution.cursor_local_state, 'execution.cursor_local_state'];
      case 'claude_account': return [settings.allowance.claude_reader === 'oauth_usage', `allowance.claude_reader.${settings.allowance.claude_reader}`];
      case 'codex_account': return [settings.allowance.codex_reader === 'app_server' || settings.allowance.codex_reader === 'web_backend', `allowance.codex_reader.${settings.allowance.codex_reader}`];
      case 'cursor_account': return [settings.allowance.cursor_reader !== 'off' || settings.account_history.cursor_usage_events, `allowance.cursor_reader.${settings.allowance.cursor_reader}`];
      case 'anthropic_api': return [settings.billing.anthropic_admin_api, 'billing.anthropic_admin_api'];
      case 'openai_api': return [settings.billing.openai_admin_api, 'billing.openai_admin_api'];
      case 'claude_browser': return [settings.browser.claude_web, 'browser.claude_web'];
      case 'codex_browser': return [settings.browser.chatgpt_web, 'browser.chatgpt_web'];
      case 'cursor_browser': return [settings.browser.cursor_web, 'browser.cursor_web'];
    }
  })();
  return { enabled: provider_enabled && on && !settings.paused, provider_enabled, mode_path };
}
function adapterProviderOf(adapter: Adapter): Provider {
  if (adapter === 'anthropic_api' || adapter === 'openai_api') return adapter;
  if (adapter.startsWith('claude_')) return 'claude';
  if (adapter.startsWith('codex_')) return 'codex';
  return 'cursor';
}

/** The matrix the settings page renders: one row per setting, grouped, with its control kind. */
export type SettingRow =
  | { path: string; label: string; kind: 'switch'; note?: string }
  | { path: string; label: string; kind: 'select'; options: readonly (string | number)[]; note?: string }
  | { path: string; label: string; kind: 'number'; min: number; max: number; note?: string };
export const settingsMatrix: { group: string; rows: SettingRow[] }[] = [
  { group: 'Collection', rows: [
    { path: 'paused', label: 'Paused (kill switch)', kind: 'switch', note: 'Stops every adapter on the next run.' },
    { path: 'cadence_minutes', label: 'Cadence (minutes)', kind: 'select', options: [15, 30, 60] },
  ] },
  { group: 'Providers', rows: [
    { path: 'providers.claude', label: 'Claude', kind: 'switch' },
    { path: 'providers.codex', label: 'Codex', kind: 'switch' },
    { path: 'providers.cursor', label: 'Cursor', kind: 'switch', note: 'On only when discovered and confirmed at setup.' },
    { path: 'providers.anthropic_api', label: 'Anthropic API (Admin key)', kind: 'switch' },
    { path: 'providers.openai_api', label: 'OpenAI API (Admin key)', kind: 'switch' },
  ] },
  { group: 'Execution readers', rows: [
    { path: 'execution.claude_local_logs', label: 'Claude Code transcripts', kind: 'switch' },
    { path: 'execution.codex_local_history', label: 'Codex CLI rollouts', kind: 'switch' },
    { path: 'execution.cursor_local_state', label: 'Cursor local state', kind: 'switch' },
    { path: 'execution.include_subagents', label: 'Include subagent transcripts', kind: 'switch' },
    { path: 'execution.detail_level', label: 'Detail level', kind: 'select', options: ['buckets_only', 'requests', 'requests_with_tools'] },
    { path: 'execution.tool_detail', label: 'Tool names', kind: 'select', options: ['off', 'builtin_only', 'hashed_custom'] },
    { path: 'execution.project_attribution', label: 'Project attribution', kind: 'select', options: ['off', 'hashed'], note: 'hashed sends a hash of each request’s working directory, never the path; `observatory projects` on the machine maps hash to folder. Local and desktop sessions only; see docs/usage-coverage.md.' },
  ] },
  { group: 'Allowance readers', rows: [
    { path: 'allowance.claude_reader', label: 'Claude reader', kind: 'select', options: ['off', 'statusline', 'oauth_usage'], note: 'oauth_usage uses your existing Claude Code sign-in (private interface); statusline stays as a fallback.' },
    { path: 'allowance.codex_reader', label: 'Codex reader', kind: 'select', options: ['off', 'embedded', 'app_server', 'web_backend'], note: 'app_server uses the Codex CLI’s own login through its app-server.' },
    { path: 'allowance.cursor_reader', label: 'Cursor reader', kind: 'select', options: ['off', 'usage_summary', 'dashboard_rpc'], note: 'usage_summary uses your existing Cursor sign-in (private interface).' },
  ] },
  { group: 'Account history', rows: [
    { path: 'account_history.cursor_usage_events', label: 'Cursor usage events', kind: 'switch' },
    { path: 'account_history.lookback_days', label: 'Lookback (days)', kind: 'number', min: 1, max: 90 },
  ] },
  { group: 'Billing', rows: [
    { path: 'billing.anthropic_admin_api', label: 'Anthropic Admin usage and cost reports', kind: 'switch', note: 'Needs an Admin key in the install’s secrets.json.' },
    { path: 'billing.openai_admin_api', label: 'OpenAI Admin usage and cost reports', kind: 'switch', note: 'Needs an Admin key in the install’s secrets.json.' },
  ] },
  { group: 'Hooks', rows: [
    { path: 'hooks.claude_statusline', label: 'Claude Code statusline hook', kind: 'switch' },
    { path: 'hooks.cursor_project_hooks', label: 'Cursor project hooks', kind: 'switch' },
  ] },
  { group: 'Browser collector', rows: [
    { path: 'browser.claude_web', label: 'claude.ai', kind: 'switch', note: 'Uses the signed-in tab (private interface).' },
    { path: 'browser.chatgpt_web', label: 'chatgpt.com', kind: 'switch', note: 'Uses the signed-in tab (private interface).' },
    { path: 'browser.cursor_web', label: 'cursor.com', kind: 'switch', note: 'Uses the signed-in tab (private interface).' },
  ] },
  { group: 'Other', rows: [
    { path: 'detailed_monthly_report', label: 'Detailed monthly report (analyzer)', kind: 'switch' },
    { path: 'live_mode', label: 'Live mode (serve)', kind: 'switch', note: 'A later phase; no effect yet.' },
    { path: 'local_raw_retention_days', label: 'Raw observation retention (days)', kind: 'select', options: [0, 7, 14, 30] },
    { path: 'update_notice', label: 'Update notice', kind: 'select', options: ['off', 'notify'] },
  ] },
];

type Doc = Record<string, unknown>;
/** Reads a dotted path of depth one or two. */
export function getSetting(settings: Doc, path: string): unknown {
  const [group, key] = path.split('.');
  const value = settings[group];
  return key ? (value && typeof value === 'object' ? (value as Doc)[key] : undefined) : value;
}
/** Writes a dotted path, replacing the whole group (the override semantics). */
export function setSetting<T extends Doc>(settings: T, path: string, value: unknown, base?: Doc): T {
  const [group, key] = path.split('.');
  if (!key) return { ...settings, [group]: value };
  const current = (settings[group] ?? base?.[group] ?? {}) as Doc;
  return { ...settings, [group]: { ...current, [key]: value } };
}
