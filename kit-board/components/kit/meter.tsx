import * as React from "react"
import { cn } from "cn"

/**
 * An allowance meter: what is left, what the forecast will still take, and the limit, on one scale.
 *
 * "Will I run out before the window resets" is a comparison between what survives the window, what is
 * left now, and the limit, so all three positions are drawn. A bare percentage cannot answer it.
 *
 * The bar is a depleting gauge: a fresh window is full and the fill retreats to the right as the
 * allowance is spent. The solid part is what survives the window; the hatched part at its right edge
 * is the slice the forecast will still consume, so an overrun turns the whole remaining fill hatched.
 * An overrun also turns that hatch and the track destructive, because the fill is at its smallest
 * exactly when the forecast is at its worst and a signal drawn only on the fill would vanish with it.
 * The caller keeps measuring consumption (`used`, `projected`) because that is what a provider
 * reports; the inversion lives here so no call site has to re-derive it.
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
  // Rounded once so a subtraction's float tail never reaches the DOM as `width:57.20000000000001%`.
  const trim = (n: number) => Math.round(n * 1e6) / 1e6
  const remaining = Math.max(0, Math.min(limit, limit - used))
  const pctRemaining = limit > 0 ? (remaining / limit) * 100 : 0
  // What the forecast still takes, clamped against the remaining fill rather than against the limit:
  // a projection past the limit eats all of it, which is this primitive's over-consumption signal.
  const pctAtRisk =
    projected === undefined || limit <= 0
      ? 0
      : Math.max(0, Math.min(pctRemaining, ((projected - used) / limit) * 100))
  const pctSafe = pctRemaining - pctAtRisk
  const projectedLeft = projected === undefined ? null : limit - projected
  // The forecast spends past the limit: every one of these renders the same clamped geometry, so the
  // colour is what separates them from a window that merely gets tight. An exhausted allowance has no
  // fill left to carry it, which is why the track takes the tone too.
  const over = projectedLeft !== null && projectedLeft < 0

  const left = formatValue(trim(remaining))
  const label =
    projectedLeft === null
      ? `${left} of ${formatValue(limit)} left`
      : projectedLeft >= 0
        ? `${left} of ${formatValue(limit)} left; ${formatValue(trim(projectedLeft))} left at the end of the window`
        : `${left} of ${formatValue(limit)} left; projected to run out, ${formatValue(trim(-projectedLeft))} beyond the allowance`

  return (
    <div data-slot="meter" className={cn("grid gap-2", className)} {...props}>
      {/* valuenow is in the caller's own units, so valuemax is the limit rather than a percentage. */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={trim(remaining)}
        className={cn(
          "bg-muted border-border relative h-2 overflow-hidden rounded-sm border",
          (over || remaining === 0) && "bg-destructive/25"
        )}
      >
        <span
          className="bg-primary absolute inset-y-0 left-0"
          style={{ width: `${trim(pctSafe)}%` }}
        />
        {projected !== undefined ? (
          <span
            className={cn(
              "absolute inset-y-0",
              over
                ? "bg-[repeating-linear-gradient(135deg,var(--destructive)_0_3px,transparent_3px_6px)] opacity-70"
                : "bg-[repeating-linear-gradient(135deg,var(--primary)_0_3px,transparent_3px_6px)] opacity-45"
            )}
            style={{ left: `${trim(pctSafe)}%`, width: `${trim(pctAtRisk)}%` }}
          />
        ) : null}
      </div>
      {/* The scale is unchanged, 0 to the limit; only the direction the fill measures from it flipped.
          Every word of it is already in the aria-label above, so to assistive tech it is decoration. */}
      <div aria-hidden className="text-muted-foreground flex justify-between font-mono text-[10.5px]">
        <span>0</span>
        {projectedLeft !== null ? (
          <span>
            {projectedLeft >= 0
              ? `${formatValue(trim(projectedLeft))} left at reset`
              : `${formatValue(trim(-projectedLeft))} over`}
          </span>
        ) : null}
        <span>{formatValue(limit)}</span>
      </div>
    </div>
  )
}
