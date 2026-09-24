import { CalendarClock, Coins, PiggyBank, Radar, RefreshCw, RotateCcw, TimerReset, type LucideIcon } from "lucide-react"
import { cn } from "cn"
import { providerColor, providerTypeColor } from "@/lib/provider-colors"
import type { ResetEventType } from "@/lib/reset-calendar"

/**
 * Reset markers. In the record, the provider is the tile's border and what happened is the glyph and its
 * tint: every type keeps one color and one glyph there, so a Codex global reset and a Claude one read as
 * the same kind of thing with different owners. The type colors stay clear of the provider borders: green
 * and a neutral for resets, violet for banked, amber for a Claude window flush, pink for credits, steel for
 * a signal, grey for a forecast.
 *
 * The calendar's markers are too small to carry a ring, so each provider and type pair takes one color
 * from the provider's own family (lib/provider-colors.ts), the way the charts shade each model within its
 * lab: every Claude marker is warm and every Codex marker is blue or violet. Shape still carries the type
 * so a marker stays readable in greyscale and for colour-blind readers: a circle for a reset, a square for
 * banked resets and credits, a diamond for a watch signal. An entry that is announced or forecast rather
 * than reported draws as an outline around a faint fill, and as a dashed border on the record's tile.
 */
export const RESET_TYPE_STYLES: Record<ResetEventType, { color: string; icon: LucideIcon; shape: string }> = {
  global: { color: "var(--primary)", icon: RotateCcw, shape: "rounded-full" },
  reset: { color: "#C9CDCA", icon: RefreshCw, shape: "rounded-full" },
  banked: { color: "#B897F4", icon: PiggyBank, shape: "rounded-[2px]" },
  window_flush: { color: "var(--warning)", icon: TimerReset, shape: "rounded-full" },
  credits: { color: "#F68EBC", icon: Coins, shape: "rounded-[2px]" },
  signal: { color: "var(--chart-2)", icon: Radar, shape: "rotate-45 rounded-[1px]" },
  forecast: { color: "var(--muted-foreground)", icon: CalendarClock, shape: "rounded-full" },
}

/** A provider and type pair's color on the calendar, or the type's own color for a provider without a family. */
export function resetMarkerColor(provider: string, type: ResetEventType) {
  return providerTypeColor(provider, type) ?? RESET_TYPE_STYLES[type].color
}

/** The calendar's marker and its legend swatch: the type's shape in the pair's color, solid once reported and outlined before. */
export function ResetMarker({ type, provider, planned = false, className }: { type: ResetEventType; provider: string; planned?: boolean; className?: string }) {
  const color = resetMarkerColor(provider, type)
  return (
    <i
      aria-hidden="true"
      className={cn("inline-block size-[9px] shrink-0 border-[1.5px]", RESET_TYPE_STYLES[type].shape, className)}
      style={{ borderColor: color, background: planned ? `color-mix(in oklab, ${color} 22%, transparent)` : color }}
    />
  )
}

/** A provider's ring without a type: the marker beside an agent or caller on the Tokens page. */
export function ProviderRing({ provider, className }: { provider: string; className?: string }) {
  return <i aria-hidden="true" className={cn("inline-block size-2.5 shrink-0 rounded-full border-2", className)} style={{ borderColor: providerColor(provider) }} />
}

/** The record's icon: the type's glyph and tint on a tile bordered in the provider's color. */
export function ResetIcon({ type, provider, planned = false, className }: { type: ResetEventType; provider: string; planned?: boolean; className?: string }) {
  const { color, icon: Icon } = RESET_TYPE_STYLES[type]
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-8 shrink-0 place-items-center rounded-md border-2", planned && "border-dashed", className)}
      style={{ borderColor: providerColor(provider), background: `color-mix(in oklab, ${color} ${planned ? 8 : 14}%, transparent)`, color }}
    >
      <Icon className={cn("size-4", planned && "opacity-70")} strokeWidth={2} />
    </span>
  )
}
