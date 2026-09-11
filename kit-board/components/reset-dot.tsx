import { cn } from "cn"

/**
 * Reset markers, on the token palette.
 *
 * Shape carries the type as well as colour, so the calendar stays readable in
 * greyscale and for colour-blind readers: filled circle, square, outline,
 * diamond. Used by both the calendar grid and the record list so a marker
 * always means the same thing in both.
 */
const MARKERS: Record<string, string> = {
  global: "bg-primary border-primary rounded-full",
  banked: "bg-info border-info rounded-xs",
  window_flush: "bg-warning border-warning rounded-full",
  reset: "bg-warning border-warning rounded-full",
  announcement: "bg-transparent border-warning rounded-full",
  signal: "bg-chart-2 border-chart-2 rotate-45",
  forecast: "bg-transparent border-muted-foreground",
  credits: "bg-warning border-warning",
}

export function ResetDot({ marker, className }: { marker: string; className?: string }) {
  return (
    <i
      aria-hidden="true"
      className={cn(
        "inline-block size-[6px] shrink-0 border",
        MARKERS[marker] ?? "bg-primary border-primary rounded-full",
        className
      )}
    />
  )
}
