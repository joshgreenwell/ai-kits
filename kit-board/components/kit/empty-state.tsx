import * as React from "react"
import { cn } from "cn"

/**
 * An empty state that says what happened and what to do next.
 *
 * Absence is a result in this product, not a gap: "no findings" after a full
 * scan is a clean run, and reads differently from "never ran". The tone prop
 * carries that difference.
 */
export function EmptyState({
  title,
  description,
  actions,
  tone = "neutral",
  icon,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children" | "title"> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  tone?: "neutral" | "success"
  icon?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "grid justify-items-start gap-2 rounded-lg border border-dashed p-6",
        tone === "success" ? "border-primary/35 bg-primary/5" : "border-border",
        className
      )}
      {...props}
    >
      {icon ? (
        <span
          className={cn(
            "mb-1 [&_svg]:size-4",
            tone === "success" ? "text-primary" : "text-muted-foreground"
          )}
        >
          {icon}
        </span>
      ) : null}
      <p className={cn("text-sm font-semibold", tone === "success" && "text-primary")}>{title}</p>
      {description ? (
        <p className="text-muted-foreground max-w-[62ch] text-sm leading-relaxed">{description}</p>
      ) : null}
      {actions ? <div className="mt-1 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  )
}
