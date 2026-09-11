import * as React from "react"
import { cn } from "cn"

/**
 * An allowance meter: used, projected, and the limit, on one scale.
 *
 * "Will I run out before the window resets" is a comparison between three
 * positions, so all three are drawn. A bare percentage cannot answer it.
 */
export function Meter({
  used,
  projected,
  limit,
  formatValue = (n: number) => n.toLocaleString(),
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  used: number
  limit: number
  /** Projected total by the end of the window, including what is already used. */
  projected?: number
  formatValue?: (n: number) => string
}) {
  const pctUsed = Math.max(0, Math.min(100, (used / limit) * 100))
  const pctProjected =
    projected === undefined
      ? 0
      : Math.max(0, Math.min(100 - pctUsed, ((projected - used) / limit) * 100))

  const label =
    projected === undefined
      ? `${formatValue(used)} of ${formatValue(limit)} used`
      : `${formatValue(used)} of ${formatValue(limit)} used; projected ${formatValue(projected)}`

  return (
    <div data-slot="meter" className={cn("grid gap-2", className)} {...props}>
      <div
        role="img"
        aria-label={label}
        className="bg-muted border-border relative h-2 overflow-hidden rounded-sm border"
      >
        <span
          className="bg-primary absolute inset-y-0 left-0"
          style={{ width: `${pctUsed}%` }}
        />
        {projected !== undefined ? (
          <span
            className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,var(--primary)_0_3px,transparent_3px_6px)] opacity-45"
            style={{ left: `${pctUsed}%`, width: `${pctProjected}%` }}
          />
        ) : null}
      </div>
      <div className="text-muted-foreground flex justify-between font-mono text-[10.5px]">
        <span>0</span>
        {projected !== undefined ? <span>projected {formatValue(projected)}</span> : null}
        <span>{formatValue(limit)}</span>
      </div>
    </div>
  )
}
