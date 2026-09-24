/**
 * Line colors per model, taken from the labs' own benchmark charts (read 2026-09-24, dark-mode values,
 * because this app is dark only) and approved by the owner before use.
 *
 * Claude: Anthropic's chart palette on the Opus 5.5 announcement (--chart-orange for Opus 5.5,
 * --chart-yellow for Opus 5, --color-clay the brand accent), with OpenAI's orange ramp for the other
 * Claude models; #F4BA96 is the color OpenAI's GPT-6 Sol and Luna chart draws Claude Fable 5.1 in.
 * OpenAI: its `dotcom-chart-theme` ramps. Astra is the exact blue-4 of the GPT-6 Sol and Luna chart;
 * Sol takes the white blue-1 OpenAI gives its flagship Sol on the GPT-5.6 page; Terra is green-3 rather
 * than OpenAI's blue-3, which is nearly Astra's blue. Cursor's own chart color is its brand orange and
 * xAI charts in black and white, so Cursor's models take teal, which neither lab uses.
 */
const PALETTE: Record<string, string> = {
  'claude-opus-5-5': '#EB6834',
  'claude-fable-5-1': '#F4BA96',
  'claude-opus-5': '#EDA100',
  'claude-sonnet-5': '#AC4F23',
  'claude-haiku-4-5': '#FBE8DB',
  'claude-opus-4-8': '#87401D',
  'gpt-6-astra': '#3A83F7',
  'gpt-6-sol': '#E8F3FE',
  'gpt-6-luna': '#B897F4',
  'gpt-5.6-sol': '#A4CDFB',
  'gpt-5.6-terra': '#6BC67F',
  'gpt-5.6-luna': '#7849D1',
  'codex-auto-review': '#F68EBC',
  'gpt-5.3-codex-spark': '#CF6194',
  'cursor-grok-4.6-xhigh-fast': '#2DD4BF',
  'cursor-grok-4.6-high-fast': '#99F6E4',
  'cursor-grok-4.5-high-fast': '#0F9E8E',
};

/** Lab models under Cursor's own names, drawn in their lab's color and dashed like every model served through Cursor. */
const CURSOR_NAMED: Record<string, string> = {
  'claude-4.5-sonnet': '#D97757',
};

export const UNKNOWN_MODEL_COLOR = '#6E736F';

/** Models no rule names, in sorted order: OpenAI red-3, yellow-3, green-2, pink-2, then Anthropic cloud and heather. */
const FALLBACK = ['#FF6764', '#F6C543', '#9FDDB1', '#FBBFD7', '#C5D3E0', '#CBCADB'];

/**
 * Cursor appends the effort to a lab model's name (`gpt-5.6-sol-xhigh-fast`, `gpt-5.6-sol-medium`). Such a
 * line keeps the lab color, dashed, with a dash per effort so two efforts of one model stay apart.
 */
const CURSOR_EFFORT = /^(.+?)-(low|medium|high|xhigh|max)(?:-fast)?$/;
const DASH: Record<string, string> = { max: '10 3', xhigh: '8 4', high: '5 4', medium: '2 3', low: '1 3', fast: '6 4' };

export type ModelLineStyle = { color: string; dash?: string };

function known(model: string): ModelLineStyle | null {
  if (model === 'unknown') return { color: UNKNOWN_MODEL_COLOR };
  const color = PALETTE[model] ?? PALETTE[model.replace(/-\d{8}$/, '')];
  if (color) return { color };
  if (CURSOR_NAMED[model]) return { color: CURSOR_NAMED[model], dash: DASH.fast };
  const effort = model.match(CURSOR_EFFORT);
  if (effort && PALETTE[effort[1]]) return { color: PALETTE[effort[1]], dash: DASH[effort[2]] };
  if (model.endsWith('-fast') && PALETTE[model.slice(0, -5)]) return { color: PALETTE[model.slice(0, -5)], dash: DASH.fast };
  return null;
}

/** One style per model, stable for a set of models: named models by rule, the rest from the fallback list in sorted order. */
export function modelLineStyles(models: string[]): Map<string, ModelLineStyle> {
  const styles = new Map<string, ModelLineStyle>();
  let next = 0;
  for (const model of [...new Set(models)].sort()) {
    styles.set(model, known(model) ?? { color: FALLBACK[next++ % FALLBACK.length] });
  }
  return styles;
}
