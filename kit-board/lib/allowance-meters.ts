/**
 * Canonical card titles per meter key. Every reader stores its own label untouched (the
 * statusline writes "Claude · weekly · Sonnet", the v1 browser normalizer "Weekly · Sonnet"),
 * so the title of a meter must not flip when the current reading changes reader.
 *
 * Claude meter mapping between readers: `five_hour` and `seven_day` match. A model-scoped
 * weekly window is `seven_day_<slug of the display name>` from the statusline, the OAuth reader,
 * and the v2 browser collector (one slug rule); a statusline key built from a provider model key
 * rather than a display name can still differ and then shows as its own meter. The v2 browser
 * collector writes the companion's labels; only v1 browser samples keep "Weekly · Sonnet".
 * `extra_usage` is the weekly overspend meter. Cursor hosted usage-summary keys are `auto` (included Auto/Grok pool), `api` (named
 * API models), and the older combined `premium_requests`. Codex keys (`<limit>:<minutes>`,
 * Spark windows) keep the producer's label.
 */
export function meterLabel(meterKey: string, fallbackLabel: string): string {
  if (meterKey === 'five_hour') return 'Claude · 5h';
  if (meterKey === 'seven_day') return 'Claude · weekly';
  if (meterKey === 'extra_usage') return 'Claude · extra usage';
  if (meterKey === 'premium_requests') return 'Cursor · included';
  if (meterKey === 'auto') return 'Cursor · Auto';
  if (meterKey === 'api') return 'Cursor · API';
  if (meterKey.startsWith('seven_day_')) {
    const scope = titleCase(meterKey.slice('seven_day_'.length));
    return scope ? `Claude · weekly · ${scope}` : fallbackLabel;
  }
  return fallbackLabel;
}

// Mirrors the companion's title_case over the slug: split on underscores, upper-case the first letter of each part.
function titleCase(slug: string) {
  return slug.split('_').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
