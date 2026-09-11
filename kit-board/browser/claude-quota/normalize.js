const SESSION = 300, WEEKLY = 10080;

const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function sample(key, label, minutes, percent, resetsAt, observedAt) {
  // Above 100 is dropped rather than clamped: the contract caps used_percent at
  // 100, and one out-of-range window would reject the whole upload.
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const reset = Date.parse(resetsAt);
  if (!Number.isFinite(reset) || reset <= Date.parse(observedAt)) return null;
  return { window_key: key, label, observed_at: observedAt, used_percent: percent,
    resets_at: new Date(reset).toISOString(), window_minutes: minutes };
}

/** `limits` is authoritative and the only place a model-scoped window appears. */
function fromLimits(limits, observedAt) {
  const quotas = [];
  for (const row of Array.isArray(limits) ? limits : []) {
    if (!row || typeof row !== 'object') continue;
    if (row.kind === 'session') quotas.push(sample('five_hour', '5-hour allowance', SESSION, row.percent, row.resets_at, observedAt));
    else if (row.kind === 'weekly_all') quotas.push(sample('seven_day', 'Weekly · all models', WEEKLY, row.percent, row.resets_at, observedAt));
    else if (row.kind === 'weekly_scoped') {
      // Keys must stay stable between readings or the pace segments break apart.
      const name = row.scope?.model?.display_name ?? row.scope?.model?.id ??
        row.scope?.surface?.display_name ?? (typeof row.scope?.surface === 'string' ? row.scope.surface : null);
      if (name) quotas.push(sample('seven_day_' + slug(name), 'Weekly · ' + name, WEEKLY, row.percent, row.resets_at, observedAt));
    }
  }
  return quotas.filter(Boolean);
}

/** Legacy top-level view, kept for accounts Claude has not migrated. */
function fromTopLevel(usage, observedAt) {
  const quotas = [];
  for (const [key, value] of Object.entries(usage ?? {})) {
    const minutes = key === 'five_hour' ? SESSION : key.startsWith('seven_day') ? WEEKLY : null;
    if (!minutes || !value || typeof value !== 'object') continue;
    const label = key === 'five_hour' ? '5-hour allowance' : key === 'seven_day' ? 'Weekly · all models'
      : 'Weekly · ' + key.slice(10).replaceAll('_', ' ');
    quotas.push(sample(key, label, minutes, value.utilization, value.resets_at, observedAt));
  }
  return quotas.filter(Boolean);
}

/** Extra-usage credits are an overspend allowance for the weekly window. They
 *  carry no reset of their own, so they inherit the weekly anchor and are
 *  skipped outright when no weekly window is available to anchor to. */
function fromExtraUsage(extra, weeklyReset, observedAt) {
  if (!extra || typeof extra !== 'object' || extra.is_enabled !== true || !weeklyReset) return [];
  return [sample('extra_usage', 'Extra usage credits', WEEKLY, extra.utilization, weeklyReset, observedAt)].filter(Boolean);
}

export function normalizeQuota(usage, observedAt) {
  const quotas = [], seen = new Set();
  for (const quota of [...fromLimits(usage?.limits, observedAt), ...fromTopLevel(usage, observedAt)]) {
    // One reading per window; `limits` wins so a scoped window is never
    // shadowed by the legacy duplicate of the same key.
    if (seen.has(quota.window_key)) continue;
    seen.add(quota.window_key); quotas.push(quota);
  }
  // Anchored to the validated weekly reading rather than to a claimed date.
  const weekly = quotas.find(quota => quota.window_key === 'seven_day');
  for (const quota of fromExtraUsage(usage?.extra_usage, weekly?.resets_at, observedAt)) {
    if (seen.has(quota.window_key)) continue;
    seen.add(quota.window_key); quotas.push(quota);
  }
  if (!quotas.length) throw new Error('Claude returned no recognized, current allowance windows. Open Settings → Usage and try again.');
  return quotas;
}
