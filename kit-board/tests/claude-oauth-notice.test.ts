import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultCollectionSettings, mergeSettings } from '../lib/companion-settings';
import {
  claudeOauthFailureNotice, isClaudeOauthAlert, oauthFailureAlerts, oauthFailureInstallNotices,
} from '../lib/claude-oauth-notice';

const global = defaultCollectionSettings;
const oauthGlobal = mergeSettings({ allowance: { ...defaultCollectionSettings.allowance, claude_reader: 'oauth_usage' } });
const install = (coverage: { state: string; detail_code: string | null; capability?: { state: string; detail_code: string | null } }) => ({
  machine_label: 'desk',
  settings: {},
  capabilities: { document: { effective: { readers: { claude: 'oauth_usage' } } } },
  latest_run: {
    coverage: [{
      adapter: 'claude_account',
      state: coverage.state,
      detail_code: coverage.detail_code,
      capabilities: coverage.capability
        ? [{ dimension: 'allowance', state: coverage.capability.state, detail_code: coverage.capability.detail_code }]
        : undefined,
    }],
  },
  bindings: [{ account_id: 'claude-a', provider: 'claude', enabled: true }],
});

test('oauth notices fire only in oauth_usage and only when OAuth failed', () => {
  assert.equal(claudeOauthFailureNotice(install({
    state: 'ok', detail_code: null, capability: { state: 'complete', detail_code: null },
  }), oauthGlobal), null);
  assert.equal(claudeOauthFailureNotice({
    ...install({ state: 'partial', detail_code: 'credential_missing', capability: { state: 'partial', detail_code: 'reader_fallback_statusline' } }),
    capabilities: { document: { effective: { readers: { claude: 'statusline' } } } },
  }, global), null, 'statusline mode is not an OAuth failure');
  const fallback = claudeOauthFailureNotice(install({
    state: 'partial', detail_code: 'credential_missing', capability: { state: 'partial', detail_code: 'reader_fallback_statusline' },
  }), oauthGlobal);
  assert.equal(fallback?.title, 'Claude OAuth usage failed');
  assert.match(fallback!.body, /fell back to the statusline/);
  assert.match(fallback!.body, /Keep Claude Code signed in/);
  assert.equal(claudeOauthFailureNotice(install({
    state: 'credential_unavailable', detail_code: 'credential_expired', capability: { state: 'partial', detail_code: 'credential_expired' },
  }), oauthGlobal)?.title, 'Claude OAuth sign-in expired');
  const alerts = oauthFailureAlerts([install({
    state: 'partial', detail_code: 'credential_missing', capability: { state: 'partial', detail_code: 'reader_fallback_statusline' },
  })], oauthGlobal);
  assert.equal(alerts['claude-a']?.length, 1);
  assert.equal(isClaudeOauthAlert(alerts['claude-a'][0]), true);
  assert.equal(oauthFailureInstallNotices([install({
    state: 'partial', detail_code: 'credential_missing', capability: { state: 'partial', detail_code: 'reader_fallback_statusline' },
  })], oauthGlobal).length, 1);
});
