import type { ReactNode } from "react"
import { cn } from "cn"

/** A shared title row for each private observatory section. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        "border-border flex flex-wrap items-end justify-between gap-4 border-b pb-4",
        className
      )}
    >
      <div className="grid gap-1.5">
        {eyebrow ? (
          <p className="text-muted-foreground font-mono text-[11px]">{eyebrow}</p>
        ) : null}
        <h1 className="text-[30px] leading-[1.15] font-semibold tracking-[-.03em]">{title}</h1>
        {description ? (
          <p className="text-content-secondary max-w-[72ch] text-[14.5px] leading-[1.65]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
