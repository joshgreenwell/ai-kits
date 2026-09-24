"use client"

import * as React from "react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"

/** One figure a ranked row reports. The first column is the measure the rows are ranked and barred by. */
export type RankedColumn<T> = {
  header: string
  /** The column's track while the list is wide, such as "4.5rem". */
  width: string
  value: (row: T) => React.ReactNode
  /** Named after the value while the list is narrow, where no header row names it. */
  unit?: (row: T) => string
  title?: (row: T) => string | undefined
  className?: (row: T) => string | undefined
}

export type RankedSegment = { value: number; color: string; label: string }

/**
 * A ranked reading of rows that share one measure: a name, a bar against the largest row, and a few
 * figures, the way the model ranking on the Tokens page reads. Wide, the figures sit in columns under
 * a header. Narrow, the first figure moves beside the name, the bar runs under both, and the rest wrap
 * into one line that names its own units, so nothing scrolls sideways.
 *
 * A row with `onSelect` is a toggle button (aria-pressed, `data-state="selected"`), which is how a row
 * filters the page or narrows a sibling view. A selected row past the preview stays visible, so a
 * drill-down never hides itself.
 */
export function RankedList<T>({
  label,
  rows,
  rowKey,
  amount,
  name,
  marker,
  detail,
  segments,
  nameHeader,
  barHeader = "Relative volume",
  columns,
  nameWidth = "15rem",
  isSelected,
  onSelect,
  canSelect,
  ranked = true,
  preview = 8,
  noun = "rows",
  empty = null,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "onSelect"> & {
  label: string
  rows: T[]
  rowKey: (row: T) => string
  amount: (row: T) => number
  name: (row: T) => React.ReactNode
  marker?: (row: T) => React.ReactNode
  detail?: (row: T) => React.ReactNode
  /** Divides a row's bar into parts that add up to its amount. */
  segments?: (row: T) => RankedSegment[]
  nameHeader: string
  barHeader?: string
  columns: RankedColumn<T>[]
  nameWidth?: string
  isSelected?: (row: T) => boolean
  onSelect?: (row: T) => void
  canSelect?: (row: T) => boolean
  ranked?: boolean
  preview?: number
  noun?: string
  empty?: React.ReactNode
}) {
  const [all, setAll] = React.useState(false)
  if (!rows.length) return <>{empty}</>
  const top = Math.max(...rows.map(amount), 0) || 1
  const limited = !all && rows.length > preview
  const shown = limited ? rows.filter((row, index) => index < preview || isSelected?.(row)) : rows
  const [primary, ...rest] = columns
  const template = { "--ranked-cols": [`minmax(0,${nameWidth})`, "minmax(3rem,1fr)", ...columns.map(column => column.width)].join(" ") } as React.CSSProperties
  const unit = (column: RankedColumn<T>, row: T) =>
    column.unit ? <span className="@min-[36rem]/ranked:hidden"> {column.unit(row)}</span> : null

  return (
    <div data-slot="ranked-list" className={cn("@container/ranked grid min-w-0", className)} style={template} {...props}>
      <div
        aria-hidden="true"
        className="text-muted-foreground hidden grid-cols-(--ranked-cols) gap-x-4 px-4 pb-2 text-[10px] font-semibold tracking-wider uppercase @min-[36rem]/ranked:grid"
      >
        <span>{nameHeader}</span>
        <span>{barHeader}</span>
        {columns.map(column => <span key={column.header} className="text-right">{column.header}</span>)}
      </div>
      <ol aria-label={label} className="border-border divide-border divide-y border-t">
        {shown.map(row => {
          const index = rows.indexOf(row)
          const selectable = !!onSelect && (canSelect?.(row) ?? true)
          const selected = !!isSelected?.(row)
          const value = amount(row)
          const width = value > 0 ? `${Math.max(0.5, (value / top) * 100)}%` : "0%"
          const parts = segments?.(row).filter(part => part.value > 0) ?? []
          const partTotal = parts.reduce((n, part) => n + part.value, 0)
          const note = detail?.(row)
          const cells = (
            <>
              <span className="flex min-w-0 items-start gap-2">
                {ranked ? <span className="text-muted-foreground w-4 shrink-0 font-mono text-[10.5px] leading-[18px] tabular-nums">{index + 1}</span> : null}
                {marker ? <span className="flex h-[18px] shrink-0 items-center">{marker(row)}</span> : null}
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">{name(row)}</span>
                  {note != null && note !== "" && note !== false ? <span className="text-muted-foreground min-w-0 text-[10.5px] leading-snug break-words">{note}</span> : null}
                </span>
              </span>
              <span aria-hidden="true" className="bg-muted order-2 col-span-2 flex h-1.5 overflow-hidden rounded-full @min-[36rem]/ranked:order-none @min-[36rem]/ranked:col-span-1">
                {parts.length ? (
                  <span className="flex h-full overflow-hidden rounded-full" style={{ width }}>
                    {parts.map(part => <span key={part.label} className="h-full" style={{ width: `${(part.value / partTotal) * 100}%`, background: part.color }} />)}
                  </span>
                ) : (
                  <span className="bg-primary/70 block h-full rounded-full" style={{ width }} />
                )}
              </span>
              <span
                className={cn("order-1 self-start text-right font-mono text-xs leading-[18px] font-semibold tabular-nums @min-[36rem]/ranked:order-none @min-[36rem]/ranked:self-center @min-[36rem]/ranked:font-normal", primary.className?.(row))}
                title={primary.title?.(row)}
              >
                {primary.value(row)}{unit(primary, row)}
              </span>
              {rest.length ? (
                <span className="text-muted-foreground order-3 col-span-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px] tabular-nums @min-[36rem]/ranked:order-none @min-[36rem]/ranked:col-span-1 @min-[36rem]/ranked:contents @min-[36rem]/ranked:text-xs">
                  {rest.map(column => (
                    <span key={column.header} className={cn("@min-[36rem]/ranked:text-right", column.className?.(row))} title={column.title?.(row)}>
                      {column.value(row)}{unit(column, row)}
                    </span>
                  ))}
                </span>
              ) : null}
            </>
          )
          const layout = "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-left @min-[36rem]/ranked:grid-cols-(--ranked-cols)"
          return (
            <li key={rowKey(row)}>
              {selectable ? (
                <button
                  type="button"
                  aria-pressed={selected}
                  data-state={selected ? "selected" : undefined}
                  onClick={() => onSelect?.(row)}
                  className={cn(
                    layout,
                    "hover:bg-accent/60 cursor-pointer outline-none transition-colors focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]",
                    selected && "bg-primary/10 hover:bg-primary/15 shadow-[inset_2px_0_0_var(--primary)]"
                  )}
                >
                  {cells}
                </button>
              ) : (
                <div className={layout}>{cells}</div>
              )}
            </li>
          )
        })}
      </ol>
      {rows.length > preview ? (
        <div className="border-border border-t px-4 py-2">
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground -ml-1.5 px-1.5 font-normal" aria-expanded={all} onClick={() => setAll(value => !value)}>
            {all ? `Show the top ${preview}` : `Show all ${rows.length} ${noun}`}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
