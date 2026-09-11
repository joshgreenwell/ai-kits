import * as React from "react"
import { cn } from "cn"

/**
 * The label / detail / action row these views repeat everywhere: a collector,
 * a connection, a feed, an artifact. One component so the alignment, the
 * monospace detail line and the failed tone cannot drift between screens.
 */
export function ListRow({
  title,
  detail,
  aside,
  tone = "default",
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode
  detail?: React.ReactNode
  aside?: React.ReactNode
  tone?: "default" | "destructive"
}) {
  return (
    <div
      data-slot="list-row"
      className={cn(
        "border-border flex flex-wrap items-center gap-4 border-b px-4 py-3 last:border-b-0",
        tone === "destructive" && "bg-destructive/8 shadow-[inset_2px_0_0_var(--destructive)]",
        className
      )}
      {...props}
    >
      <div className="min-w-[180px] flex-1">
        <div className="text-sm font-semibold">{title}</div>
        {detail ? (
          <div
            className={cn(
              "mt-0.5 font-mono text-[11px] leading-snug",
              tone === "destructive" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {detail}
          </div>
        ) : null}
      </div>
      {aside ? <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div> : null}
    </div>
  )
}

/** A bordered container for ListRows, matching the Card surface. */
export function ListRows({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="list-rows"
      className={cn("border-border overflow-hidden rounded-[var(--radius-card)] border", className)}
      {...props}
    />
  )
}
