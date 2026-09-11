import * as React from "react"
import { cn } from "cn"

/**
 * Hourly burn against a baseline.
 *
 * The average line and the peak are both labelled with their real values, so
 * the chart never asks anyone to estimate a quantity from a height.
 */
export function SparkBars({
  values,
  average,
  axis,
  formatValue = (n: number) => n.toLocaleString(),
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  values: number[]
  /** Baseline to draw as a dashed reference line, in the same unit as values. */
  average?: number
  axis?: string[]
  formatValue?: (n: number) => string
}) {
  const max = Math.max(...values, average ?? 0) || 1
  const peakIndex = values.indexOf(Math.max(...values))

  return (
    <div data-slot="spark-bars" className={cn("grid gap-2", className)} {...props}>
      <div
        role="img"
        aria-label={
          `Peak ${formatValue(values[peakIndex] ?? 0)}` +
          (average === undefined ? "" : ` against an average of ${formatValue(average)}`)
        }
        className="border-border relative flex h-20 items-end gap-[2px] border-b"
      >
        {average !== undefined ? (
          <span
            className="border-ring/70 absolute inset-x-0 border-t border-dashed"
            style={{ bottom: `${(average / max) * 100}%` }}
          >
            <span className="text-ring bg-card absolute right-0 -top-4 rounded-sm px-1 font-mono text-[10px]">
              avg {formatValue(average)}
            </span>
          </span>
        ) : null}
        {values.map((v, i) => (
          <span
            key={i}
            className={cn(
              "min-h-[2px] flex-1 rounded-t-xs",
              i === peakIndex ? "bg-primary" : "bg-primary/45"
            )}
            style={{ height: `${(v / max) * 100}%` }}
          />
        ))}
      </div>
      {axis?.length ? (
        <div className="text-muted-foreground flex justify-between font-mono text-[10px]">
          {axis.map((a, i) => (
            <span key={i}>{a}</span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
