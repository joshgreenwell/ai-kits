"use client"

import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "cn"

export type Column<T> = {
  id: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  /** Right-aligns and sets tabular monospace figures. */
  numeric?: boolean
  /** Required for a sortable column: the comparable value behind the cell. */
  sortValue?: (row: T) => number | string
  footer?: React.ReactNode
  width?: string
}

type SortState = { id: string; dir: "asc" | "desc" } | null

/**
 * The ledger: a shadcn table, not a lookalike of one.
 *
 * The primitives in components/ui/table carry the whole appearance - the rule
 * under each row, the hover fill, the header weight - so a ledger here and a
 * table anywhere else in the app cannot drift apart. What this adds on top is
 * only behaviour: a sticky header, sortable columns whose control is an
 * ordinary ghost button, and a roving tabindex so rows are reachable with
 * arrows, Home and End rather than with a mouse alone.
 */
export function DataTable<T>({
  columns,
  rows,
  getRowId,
  caption,
  selectedId,
  onSelect,
  defaultSort,
  empty,
  limit,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "rows" | "children" | "onSelect"> & {
  columns: Column<T>[]
  rows: T[]
  getRowId: (row: T) => string
  caption?: React.ReactNode
  selectedId?: string
  onSelect?: (row: T) => void
  defaultSort?: { id: string; dir: "asc" | "desc" }
  empty?: React.ReactNode
  /**
   * Show the first rows of the current sort and offer the rest behind one toggle, instead of a scroll box
   * nested inside the page. A selected row past the limit stays visible, so a drill-down never hides itself.
   */
  limit?: number
}) {
  const [sort, setSort] = React.useState<SortState>(defaultSort ?? null)
  const [expanded, setExpanded] = React.useState(false)
  const [focusIndex, setFocusIndex] = React.useState(0)
  const bodyRef = React.useRef<HTMLTableSectionElement>(null)

  const sorted = React.useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.id === sort.id)
    if (!col?.sortValue) return rows
    const read = col.sortValue
    return [...rows].sort((a, b) => {
      const av = read(a)
      const bv = read(b)
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv))
      return sort.dir === "asc" ? cmp : -cmp
    })
  }, [rows, sort, columns])

  const limited = limit !== undefined && !expanded && sorted.length > limit
  const visible = React.useMemo(
    () => (limited ? sorted.filter((row, i) => i < limit! || getRowId(row) === selectedId) : sorted),
    [limited, sorted, limit, getRowId, selectedId]
  )

  function toggleSort(id: string) {
    setSort((prev) =>
      prev?.id === id ? { id, dir: prev.dir === "asc" ? "desc" : "asc" } : { id, dir: "desc" }
    )
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTableSectionElement>) {
    const last = visible.length - 1
    let next = focusIndex
    if (e.key === "ArrowDown") next = Math.min(last, focusIndex + 1)
    else if (e.key === "ArrowUp") next = Math.max(0, focusIndex - 1)
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = last
    else if (e.key === "Enter" || e.key === " ") {
      const row = visible[focusIndex]
      if (row && onSelect) {
        e.preventDefault()
        onSelect(row)
      }
      return
    } else return

    e.preventDefault()
    setFocusIndex(next)
    const el = bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr")[next]
    el?.focus()
  }

  const hasFooter = columns.some((c) => c.footer !== undefined)

  if (!sorted.length && empty) {
    return <div className={cn(className)}>{empty}</div>
  }

  // min-w-0: in a grid or flex parent, a wide table scrolls inside its own container instead of
  // stretching the parent past the card, where the card's overflow would clip the last columns.
  return (
    <div className={cn("min-w-0", className)} {...props}>
      <Table>
        {caption ? <TableCaption>{caption}</TableCaption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((col) => {
              const active = sort?.id === col.id
              const sortable = Boolean(col.sortValue)
              return (
                <TableHead
                  key={col.id}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn("bg-card sticky top-0 z-[1]", col.numeric && "text-right")}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {sortable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => toggleSort(col.id)}
                      className={cn(
                        "-mx-2 font-semibold",
                        col.numeric && "flex-row-reverse",
                        active ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {col.header}
                      {active ? (
                        sort.dir === "asc" ? (
                          <ArrowUpIcon className="size-3" />
                        ) : (
                          <ArrowDownIcon className="size-3" />
                        )
                      ) : (
                        <ChevronsUpDownIcon className="size-3 opacity-50" />
                      )}
                    </Button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>

        <TableBody ref={bodyRef} onKeyDown={onKeyDown}>
          {visible.map((row, i) => {
            const id = getRowId(row)
            const selected = selectedId === id
            return (
              <TableRow
                key={id}
                tabIndex={i === focusIndex ? 0 : -1}
                aria-selected={selected}
                data-state={selected ? "selected" : undefined}
                onFocus={() => setFocusIndex(i)}
                onClick={() => onSelect?.(row)}
                className={cn(onSelect && "cursor-pointer")}
              >
                {columns.map((col) => (
                  <TableCell
                    key={col.id}
                    className={cn(col.numeric && "text-right font-mono tabular-nums")}
                  >
                    {col.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>

        {hasFooter ? (
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              {columns.map((col) => (
                <TableCell
                  key={col.id}
                  className={cn(col.numeric && "text-right font-mono tabular-nums")}
                >
                  {col.footer}
                </TableCell>
              ))}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
      {limit !== undefined && sorted.length > limit ? (
        <div className="border-border border-t px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
            className="text-muted-foreground hover:text-foreground font-normal"
          >
            {expanded ? `Show the first ${limit}` : `Show all ${sorted.length} rows`}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
