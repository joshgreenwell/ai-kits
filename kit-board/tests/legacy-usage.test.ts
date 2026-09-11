import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLegacyUsage, parseLegacyUsageConfig, usageReportFromLegacyEnvelope } from '../lib/legacy-usage';

const envelope = {
  schema_version: 4,
  machine_id: 'pc-workstation',
  machine_name: 'Windows Machine',
  report: {
    generated_at_local: '2026-09-01T09:30:14.186-05:00',
    current: {
      month: '2026-08',
      totals: { total_tokens: 100, fresh_non_cached_tokens: 40, calls: 2, threads: 1 },
      exclusive_composition: { cached_input_tokens: 60 },
      ratios: { custom_agent_share_of_total: 0.1 },
      agent_orchestration: { spawns: { total: 2, custom: 1 } },
      knowledge_brain: { game_design_tokens: 3, direct_tool_calls: 0 },
      by_work_mode: [],
    },
  },
};

test('legacy usage keeps the source observation and uses a canonical envelope idempotency key', () => {
  const report = usageReportFromLegacyEnvelope(envelope);
  assert.equal(report.period_key, '2026-08');
  assert.equal(report.subject_key, 'pc-workstation');
  assert.equal(report.produced_at, '2026-09-01T14:30:14.186Z');
  assert.match(report.idempotency_key, /^[a-f0-9]{64}$/);
});

test('legacy bridge permits only the expected HTTPS read endpoint', () => {
  const base = { api_key: 'key', sites_bypass_token: 'token' };
  assert.equal(parseLegacyUsageConfig(JSON.stringify({ ...base, endpoint: 'https://token-observatory-jg.josh470070.chatgpt.site/api/reports' })).endpoint, 'https://token-observatory-jg.josh470070.chatgpt.site/api/reports');
  assert.throws(() => parseLegacyUsageConfig(JSON.stringify({ ...base, endpoint: 'https://example.com/api/reports' })), /not allowed/);
  assert.throws(() => parseLegacyUsageConfig(JSON.stringify({ ...base, endpoint: 'https://token-observatory-jg.josh470070.chatgpt.site/api/reports?month=2026-08' })), /not allowed/);
});

test('legacy fetch validates its destination before sending either credential', async () => {
  let called = false;
  await assert.rejects(() => fetchLegacyUsage({ endpoint: 'https://example.com/api/reports', apiKey: 'key', sitesBypassToken: 'token' }, async () => {
    called = true;
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }), /not allowed/);
  assert.equal(called, false);
});


test('detailed hourly reports preserve partial and finalized coverage through compatibility ingestion', () => {
  assert.equal(usageReportFromLegacyEnvelope(envelope).status, 'complete');
  for (const period_state of ['partial', 'complete'] as const) {
    const detailed = { ...envelope, report: { ...envelope.report, collection: { kind: 'hourly_detailed_report', period_state } } };
    const parsed = usageReportFromLegacyEnvelope(detailed);
    assert.equal(parsed.status, period_state);
    assert.deepEqual(parsed.payload, detailed);
  }
  assert.throws(() => usageReportFromLegacyEnvelope({ ...envelope, report: { ...envelope.report, collection: { kind: 'hourly_detailed_report', period_state: 'unknown' } } }), /invalid report/);
});
