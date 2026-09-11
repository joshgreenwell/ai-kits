import * as React from "react"
import { cn } from "cn"

export type ReconciliationSource = {
  label: string
  value: React.ReactNode
  detail?: React.ReactNode
}

/**
 * Two sources that disagree, shown as two sources that disagree.
 *
 * The board does not average them and does not pick a winner. The difference
 * is the finding, so it gets its own row, its own tone, and a detail line that
 * names what it points at.
 */
export function Reconciliation({
  sources,
  difference,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  sources: ReconciliationSource[]
  difference: ReconciliationSource
  actions?: React.ReactNode
}) {
  return (
    <div data-slot="reconciliation" className={cn("grid", className)} {...props}>
      {sources.map((s) => (
        <Row key={s.label} source={s} />
      ))}
      <Row source={difference} tone="warning" />
      {actions ? (
        <div className="border-border flex flex-wrap gap-2 border-t p-3">{actions}</div>
      ) : null}
    </div>
  )
}

function Row({ source, tone }: { source: ReconciliationSource; tone?: "warning" }) {
  return (
    <div
      className={cn(
        "border-border flex flex-wrap items-center gap-4 border-b px-4 py-3 last:border-b-0",
        tone === "warning" && "bg-warning/8 shadow-[inset_2px_0_0_var(--warning)]"
      )}
    >
      <div className="min-w-[160px] flex-1">
        <p className={cn("text-sm font-semibold", tone === "warning" && "text-warning")}>
          {source.label}
        </p>
        {source.detail ? (
          <p
            className={cn(
              "mt-0.5 font-mono text-[11px] leading-snug",
              tone === "warning" ? "text-warning/90" : "text-muted-foreground"
            )}
          >
            {source.detail}
          </p>
        ) : null}
      </div>
      <span
        className={cn(
          "font-mono text-lg font-semibold tabular-nums",
          tone === "warning" && "text-warning"
        )}
      >
        {source.value}
      </span>
    </div>
  )
}
