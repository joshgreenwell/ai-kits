import * as React from "react"
import { cn } from "cn"

/**
 * A compact reading: what it is, the figure, and what the figure means.
 * The caption is not optional by convention - a number with no statement of
 * the decision it serves is the thing this product is trying not to ship.
 */
export function Stat({
  label,
  value,
  caption,
  tone = "default",
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode
  value: React.ReactNode
  caption?: React.ReactNode
  tone?: "default" | "primary" | "warning" | "destructive"
}) {
  const toneClass = {
    default: "",
    primary: "text-primary",
    warning: "text-warning",
    destructive: "text-destructive",
  }[tone]

  return (
    <div data-slot="stat" className={cn("grid gap-1.5 p-4", className)} {...props}>
      <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
        {label}
      </span>
      <span
        className={cn(
          "font-mono text-xl leading-none font-medium tracking-tight tabular-nums",
          toneClass
        )}
      >
        {value}
      </span>
      {caption ? (
        <span className="text-muted-foreground font-mono text-[10.5px] leading-snug">{caption}</span>
      ) : null}
    </div>
  )
}

/** A row of Stats, divided rather than spaced - they are one instrument. */
export function StatGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-group"
      className={cn(
        "grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))]",
        "[&>[data-slot=stat]]:border-l [&>[data-slot=stat]]:border-border",
        "[&>[data-slot=stat]:first-child]:border-l-0",
        className
      )}
      {...props}
    />
  )
}
