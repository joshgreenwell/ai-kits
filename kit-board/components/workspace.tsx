import type { ReactNode } from "react"
import { cn } from "cn"

const WIDTHS = {
  /** Views read top to bottom: a comfortable column. */
  reading: "max-w-[1200px]",
  /** Dashboards lay their cards out in a grid across the window, stopping short of ultrawide. */
  dashboard: "max-w-[2560px]",
} as const

export type WorkspaceWidth = keyof typeof WIDTHS

/** The page frame: one gutter for the header, the sub-navigation, and the content, so their edges line up. */
export function pageFrame(width: WorkspaceWidth = "reading") {
  return cn("mx-auto w-full px-6", WIDTHS[width])
}

/** The single page gutter and rhythm for every private observatory view. */
export function Workspace({ children, className, width = "reading" }: { children: ReactNode; className?: string; width?: WorkspaceWidth }) {
  return (
    <main className={cn(pageFrame(width), "grid gap-8 py-8", className)}>{children}</main>
  )
}
