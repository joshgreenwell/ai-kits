import type { ResetEventType } from './reset-calendar';

/**
 * One identity color per provider, drawn as a ring or border wherever a row belongs to a provider, so
 * Claude, Codex, and Cursor read apart at a glance. Each is the family its models already chart in
 * (lib/model-colors.ts): Anthropic's clay for Claude, OpenAI's blue-4 for Codex, and the teal Cursor's
 * own models take. The APIs take the lighter step of the same family, so an API row sits next to its lab
 * without being mistaken for the subscription.
 */
const PROVIDER_COLORS: Record<string, string> = {
  claude: '#D97757',
  codex: '#3A83F7',
  cursor: '#2DD4BF',
  anthropic_api: '#F4BA96',
  openai_api: '#A4CDFB',
};

export const UNKNOWN_PROVIDER_COLOR = '#6E736F';

export function providerColor(provider: string | null | undefined): string {
  return (provider && PROVIDER_COLORS[provider]) || UNKNOWN_PROVIDER_COLOR;
}

/**
 * The calendar's marker colors, one per provider and type, the way the charts give each model its own
 * shade of its lab's family: Claude's reset types take clay, amber, and peach, Codex's take blue and
 * violet with the pinks its Codex models chart in, and Cursor's take teal. Each provider's most common
 * type takes its identity color, a forecast takes a pale step, and no two types of one provider share a
 * color. Claude's watch signal is the one derived step (between #EB6834 and #F4BA96), because the family
 * has no seventh step light enough to read on the card, and Cursor's ramp continues Tailwind's teal.
 */
const PROVIDER_TYPE_COLORS: Record<string, Record<ResetEventType, string>> = {
  claude: { window_flush: '#D97757', forecast: '#F4BA96', global: '#EDA100', reset: '#AC4F23', banked: '#EB6834', credits: '#FBE8DB', signal: '#F09165' },
  codex: { global: '#3A83F7', reset: '#A4CDFB', forecast: '#E8F3FE', window_flush: '#F68EBC', banked: '#B897F4', credits: '#7849D1', signal: '#CF6194' },
  cursor: { global: '#2DD4BF', reset: '#99F6E4', window_flush: '#0F9E8E', forecast: '#CCFBF1', banked: '#5EEAD4', credits: '#0D9488', signal: '#14B8A6' },
};

/** A provider's color for one reset type, or null for a provider the calendar has no family for. */
export function providerTypeColor(provider: string | null | undefined, type: ResetEventType): string | null {
  return (provider && PROVIDER_TYPE_COLORS[provider]?.[type]) || null;
}
