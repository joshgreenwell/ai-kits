import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrationMethod, calibrationPreview, calibrationRequest, cloudEstimate, intervalTokens, type Calibration, type EstimateData } from '../lib/cloud-estimate';

const now = Date.parse('2026-09-09T18:00:00Z');
const time = (hour: number) => new Date(Date.parse('2026-09-09T00:00:00Z') + hour * 3_600_000).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(): EstimateData {
  return {
    accounts: [{ id: 'claude-primary', provider: 'claude', label: 'Claude' }, { id: 'other-account', provider: 'claude', label: 'Other' }],
    sources: [{ id: 'source', account_id: 'claude-primary', mode: 'local', disabled: false, last_seen_at: time(18), coverage: { since: '2026-09-01' } }],
    hourly: Array.from({ length: 10 }, (_, i) => ({ account_id: 'claude-primary', hour: time(i + 8), total_tokens: 1000 })),
    quotas: Array.from({ length: 10 }, (_, i) => ({ id: id(i), account_id: 'claude-primary', window_key: 'seven_day', label: 'Weekly', observed_at: time(i + 8),
      used_percent: i <= 2 ? i * 5 : 10 + (i - 2) * 10, resets_at: time(24), window_minutes: 10080 })),
  };
}
function baseline(data = fixture()): Calibration {
  const preview = calibrationPreview(data, 'claude-primary', id(0), id(2), now);
  if (!preview.ok) throw new Error(preview.reason);
  return { id: id(100), ...preview.value, confirmed_at: time(11), revoked_at: null };
}

test('calibration derives its coefficient from account-scoped local totals and observed points', () => {
  const data = fixture();
  data.hourly.push({ account_id: 'other-account', hour: time(8), total_tokens: 1_000_000 });
  const saved = baseline(data);
  assert.equal(saved.local_tokens, 2000); assert.equal(saved.tokens_per_point, 200);
  assert.equal(saved.method_version, calibrationMethod);
  assert.equal(intervalTokens(data.hourly, 'claude-primary', Date.parse(time(8.5)), Date.parse(time(9.5))), 1000);
  assert.equal(calibrationRequest.safeParse({ account_id: 'claude-primary', start_sample_id: id(0), end_sample_id: id(2), confirm_local_only: false }).success, false);
  assert.equal(calibrationRequest.safeParse({ account_id: 'claude-primary', start_sample_id: id(0), end_sample_id: id(2), confirm_local_only: true, tokens_per_point: 1e9 }).success, false);
});

test('baseline rejects resets, decreases, conflicting readings, wrong accounts/scopes and weak evidence', () => {
  const invalid: ((data: EstimateData) => void)[] = [
    d => { d.quotas[1].resets_at = time(25); },
    d => { d.quotas[1].used_percent = 11; },
    d => { d.quotas[2].used_percent = 2; },
    d => { d.quotas.splice(1, 1); },
    d => { d.quotas[2].account_id = 'other-account'; },
    d => { d.quotas.forEach(q => q.window_key = 'seven_day_sonnet'); },
    d => { d.quotas.push({ ...d.quotas[1], id: id(80), used_percent: 4 }); },
    d => { d.sources[0].coverage!.malformed_lines = 1; },
    d => { d.sources[0].last_seen_at = time(15); },
    d => { d.sources[0].coverage!.since = '2026-09-10'; },
    d => { d.hourly = []; },
  ];
  for (const change of invalid) {
    const data = fixture(); change(data);
    assert.equal(calibrationPreview(data, 'claude-primary', id(0), id(2), now).ok, false);
  }
  assert.equal(calibrationPreview(fixture(), 'claude-primary', id(0), id(1), now).ok, false);
  const gap = fixture(); gap.quotas = [gap.quotas[0], gap.quotas[4], gap.quotas[8]];
  assert.equal(calibrationPreview(gap, 'claude-primary', id(0), id(8), now).ok, false);
});

test('cloud extrapolation subtracts measured local tokens once and never includes the baseline itself', () => {
  const data = fixture(), result = cloudEstimate(data, 'claude-primary', [baseline(data)], now);
  assert.ok(result.ok); if (!result.ok) return;
  assert.equal(result.value.estimated_unobserved_tokens, 7000);
  assert.equal(result.value.local_tokens, 7000); assert.equal(result.value.estimated_total_tokens, 14000);
  assert.equal(result.value.covered_hours, 7); assert.equal(result.value.started_at, time(10));
  // Other accounts and model-specific quota meters do not increase the estimate.
  data.quotas.push(...data.quotas.map(q => ({ ...q, id: id(200 + Number(q.id.slice(-2))), account_id: 'other-account' })),
    ...data.quotas.map(q => ({ ...q, id: id(300 + Number(q.id.slice(-2))), window_key: 'seven_day_sonnet' })));
  assert.deepEqual(cloudEstimate(data, 'claude-primary', [baseline()], now), result);
});

test('unavailable, stale, revoked, expired or mismatched baselines never produce a cloud number', () => {
  const data = fixture(), saved = baseline();
  assert.equal(cloudEstimate({ ...data, quotas: [] }, 'claude-primary', [], now).ok, false);
  assert.equal(cloudEstimate(data, 'claude-primary', [], now).ok, false);
  assert.equal(cloudEstimate(data, 'claude-primary', [{ ...saved, revoked_at: time(12) }], now).ok, false);
  assert.equal(cloudEstimate(data, 'claude-primary', [{ ...saved, ended_at: '2026-08-01T00:00:00Z' }], now).ok, false);
  assert.equal(cloudEstimate(data, 'claude-primary', [{ ...saved, account_id: 'other-account' }], now).ok, false);
  assert.equal(cloudEstimate(data, 'claude-primary', [saved], now + 3 * 3_600_000).ok, false);
  data.hourly.forEach(r => { r.total_tokens = 9000; });
  const mismatch = cloudEstimate(data, 'claude-primary', [saved], now);
  assert.equal(mismatch.ok, false); if (!mismatch.ok) assert.match(mismatch.reason, /exceeds/);
});

test('resets and missing intervals reduce coverage; incomplete local collection cannot become cloud usage', () => {
  const saved = baseline(), data = fixture();
  data.quotas.splice(5, 1); // Still <=3h: represents a real longer sampled interval, no fabricated hour placement.
  data.quotas.filter(q => Date.parse(q.observed_at) >= Date.parse(time(14))).forEach(q => { q.resets_at = time(26); q.used_percent -= 40; });
  const result = cloudEstimate(data, 'claude-primary', [saved], now);
  assert.ok(result.ok); if (result.ok) assert.equal(result.value.covered_hours, 5); // Excludes the 12–14 reset crossing.
  data.sources[0].coverage!.unavailable_roots = 1;
  assert.equal(cloudEstimate(data, 'claude-primary', [saved], now).ok, false);
});

test('one allowance scope is used and overlapping baseline confirmations do not inflate evidence', () => {
  const data = fixture(), saved = baseline();
  const overlap = { ...saved, id: id(101), confirmed_at: time(12) };
  const five = { ...saved, id: id(102), window_key: 'five_hour', window_minutes: 300, confirmed_at: time(10) };
  const result = cloudEstimate(data, 'claude-primary', [saved, overlap, five], now);
  assert.ok(result.ok); if (result.ok) { assert.equal(result.value.baseline_count, 1); assert.equal(result.value.window_key, 'seven_day'); }
  const conflict = { ...saved, id: id(103), tokens_per_point: 1000, started_at: time(4), ended_at: time(6), confirmed_at: time(12) };
  const uncertain = cloudEstimate(data, 'claude-primary', [saved, conflict], now);
  assert.equal(uncertain.ok, false); if (!uncertain.ok) assert.match(uncertain.reason, /disagree/);
});
