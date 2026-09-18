import { mergeSettings, type CollectionSettings, type InstallOverride } from './companion-settings';

/**
 * Website copy when `oauth_usage` could not collect and the companion fell back
 * to statusline. Codes stay closed; sentences never include a path, email, or token.
 */
const OAUTH_FAILURE_DETAILS = new Set([
  'reader_fallback_statusline',
  'credential_expired',
  'credential_missing',
  'http_unauthorized',
  'reader_unavailable',
  'executable_missing',
]);

export type ClaudeOauthNotice = { title: string; body: string; detail_code: string };

type CoverageEntry = {
  adapter: string;
  state: string;
  detail_code: string | null;
  capabilities?: { dimension: string; state: string; detail_code?: string | null }[];
};

export type OauthInstallView = {
  id?: string;
  machine_label: string;
  settings: InstallOverride;
  capabilities: { document: { effective: { readers: { claude: string } } } | null };
  latest_run: { coverage: CoverageEntry[] } | null;
  bindings: { account_id: string; provider: string; enabled: boolean }[];
};

function copy(detail: string): ClaudeOauthNotice {
  if (detail === 'reader_fallback_statusline') {
    return {
      title: 'Claude OAuth usage failed',
      body: 'This machine could not read Claude allowance through the signed-in Claude Code OAuth interface. Observatory fell back to the statusline hook, so window usage still collects while Claude Code is running. Tokens, model, and effort metadata are collected; conversation text is never uploaded. Sign in with Claude Code (`claude auth login`) or turn on Keep Claude Code signed in under Collection settings.',
      detail_code: detail,
    };
  }
  if (detail === 'credential_expired') {
    return {
      title: 'Claude OAuth sign-in expired',
      body: 'The Claude Code sign-in used for oauth_usage is expired, so Observatory did not collect OAuth allowance. Statusline is the fallback when the hook has samples. Sign in with Claude Code, or turn on Keep Claude Code signed in so the collector can ask Claude Code to refresh its own store.',
      detail_code: detail,
    };
  }
  if (detail === 'credential_missing') {
    return {
      title: 'Claude OAuth sign-in missing',
      body: 'oauth_usage found no Claude Code sign-in on this machine. Statusline is the fallback when the hook has samples. Sign in with Claude Code (`claude auth login`). Conversation text is never uploaded.',
      detail_code: detail,
    };
  }
  return {
    title: 'Claude OAuth usage failed',
    body: `oauth_usage could not complete (${detail.replaceAll('_', ' ')}). Observatory uses the statusline fallback when the hook has samples. Conversation text is never uploaded.`,
    detail_code: detail,
  };
}

export function isClaudeOauthAlert(text: string) {
  return text.startsWith('Claude OAuth');
}

export function claudeReaderForInstall(install: Pick<OauthInstallView, 'settings' | 'capabilities'>, global: CollectionSettings): string {
  return install.capabilities.document?.effective.readers.claude
    ?? mergeSettings(global, install.settings).allowance.claude_reader;
}

function claudeCoverage(run: OauthInstallView['latest_run']) {
  for (const entry of run?.coverage ?? []) {
    if (entry.adapter !== 'claude_account') continue;
    const capability = entry.capabilities?.find(row => row.dimension === 'allowance');
    return { entry, capability: capability ?? null };
  }
  return null;
}

/** A notice when oauth_usage is selected and this run could not collect through OAuth. */
export function claudeOauthFailureNotice(install: Pick<OauthInstallView, 'settings' | 'capabilities' | 'latest_run'>, global: CollectionSettings): ClaudeOauthNotice | null {
  if (claudeReaderForInstall(install, global) !== 'oauth_usage') return null;
  const found = claudeCoverage(install.latest_run);
  const detail = found?.capability?.detail_code ?? found?.entry.detail_code ?? null;
  if (found?.capability?.state === 'complete' && !detail) return null;
  if (detail && OAUTH_FAILURE_DETAILS.has(detail)) return copy(detail);
  if (found?.entry.state === 'credential_unavailable' && found.entry.detail_code) return copy(found.entry.detail_code);
  return null;
}

export function claudeOauthAlertText(machineLabel: string, notice: ClaudeOauthNotice) {
  return `${notice.title} on ${machineLabel}: ${notice.body}`;
}

/** Per-account Allowances accordion alerts for OAuth fallback on each Claude binding. */
export function oauthFailureAlerts(installs: OauthInstallView[] | null | undefined, global: CollectionSettings): Record<string, string[]> {
  const alerts: Record<string, string[]> = {};
  for (const install of installs ?? []) {
    const notice = claudeOauthFailureNotice(install, global);
    if (!notice) continue;
    const text = claudeOauthAlertText(install.machine_label, notice);
    for (const binding of install.bindings) {
      if (!binding.enabled || binding.provider !== 'claude') continue;
      if (!(alerts[binding.account_id] ??= []).includes(text)) alerts[binding.account_id].push(text);
    }
  }
  return alerts;
}

/** Page-level list: one row per install that failed OAuth usage. */
export function oauthFailureInstallNotices(installs: OauthInstallView[] | null | undefined, global: CollectionSettings) {
  const rows: { machine_label: string; notice: ClaudeOauthNotice }[] = [];
  for (const install of installs ?? []) {
    const notice = claudeOauthFailureNotice(install, global);
    if (notice) rows.push({ machine_label: install.machine_label, notice });
  }
  return rows;
}
