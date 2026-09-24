"use client"

import * as React from "react"
import { cn } from "cn"

export type SectionJump = { anchor: string; label: string }

/**
 * In-page jumps for a long page. It sticks under the app header, whose height depends on how its links
 * wrap, so the offset is measured rather than assumed; the current section is the last one whose top has
 * passed under the bar. Every jump target needs a scroll margin that clears the header and this bar.
 */
export function SectionNav({ label, jumps, className }: { label: string; jumps: readonly SectionJump[]; className?: string }) {
  const [top, setTop] = React.useState(0)
  const [current, setCurrent] = React.useState<string | null>(null)
  React.useEffect(() => {
    const header = document.querySelector("[data-app-header]")
    const measure = () => setTop(header?.getBoundingClientRect().height ?? 0)
    const track = () => {
      const line = (header?.getBoundingClientRect().bottom ?? 0) + 72
      let active: string | null = null
      for (const jump of jumps) {
        const element = document.getElementById(jump.anchor)
        if (element && element.getBoundingClientRect().top <= line) active = jump.anchor
      }
      setCurrent(active)
    }
    measure()
    track()
    const observer = header ? new ResizeObserver(measure) : null
    if (header) observer?.observe(header)
    window.addEventListener("scroll", track, { passive: true })
    window.addEventListener("resize", track)
    return () => {
      observer?.disconnect()
      window.removeEventListener("scroll", track)
      window.removeEventListener("resize", track)
    }
  }, [jumps])
  // min-w-0: the link strip scrolls on its own, so it must not widen the page grid on a phone.
  return (
    <nav aria-label={label} className={cn("sticky z-30 -mx-1 min-w-0", className)} style={{ top }}>
      <div className="border-border bg-background/85 flex gap-1 overflow-x-auto rounded-[var(--radius-card)] border p-1 backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {jumps.map((jump) => (
          <a
            key={jump.anchor}
            href={`#${jump.anchor}`}
            aria-current={current === jump.anchor ? "location" : undefined}
            className={cn(
              "focus-visible:ring-ring/50 shrink-0 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px]",
              current === jump.anchor ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {jump.label}
          </a>
        ))}
      </div>
    </nav>
  )
}
