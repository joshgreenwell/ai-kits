import type { ReactNode } from "react"
import { cn } from "cn"

/** The single page gutter and rhythm for every private observatory view. */
export function Workspace({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={cn("mx-auto grid max-w-[1200px] gap-8 px-6 py-8", className)}>{children}</main>
  )
}
