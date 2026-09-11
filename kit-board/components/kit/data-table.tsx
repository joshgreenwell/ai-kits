"use client"

import * as React from "react"
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react"
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
 * The ledger.
 *
 * Density comes from spacing, not from stripping structure: 6px rows, zebra
 * fill instead of a rule under every line, a sticky header, and units in the
 * header rather than repeated in every cell.
 *
 * Rows are keyboard navigable with a roving tabindex - arrows move, Home and
 * End jump, Enter or Space selects - because a table you can only reach with a
 * mouse is not usable for the people who live in this screen.
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
}) {
  const [sort, setSort] = React.useState<SortState>(defaultSort ?? null)
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

  function toggleSort(id: string) {
    setSort((prev) =>
      prev?.id === id ? { id, dir: prev.dir === "asc" ? "desc" : "asc" } : { id, dir: "desc" }
    )
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTableSectionElement>) {
    const last = sorted.length - 1
    let next = focusIndex
    if (e.key === "ArrowDown") next = Math.min(last, focusIndex + 1)
    else if (e.key === "ArrowUp") next = Math.max(0, focusIndex - 1)
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = last
    else if (e.key === "Enter" || e.key === " ") {
      const row = sorted[focusIndex]
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

  return (
    <div className={cn(className)} {...props}>
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
                  className={cn(
                    "bg-card sticky top-0 z-[1] uppercase tracking-wide",
                    col.numeric && "text-right"
                  )}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.id)}
                      className={cn(
                        "focus-visible:ring-ring/50 -mx-1 inline-flex items-center gap-1 rounded-xs px-1 outline-none focus-visible:ring-[3px]",
                        col.numeric && "flex-row-reverse",
                        active ? "text-primary" : "hover:text-foreground"
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
                        <ChevronsUpDownIcon className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>

        <TableBody ref={bodyRef} onKeyDown={onKeyDown}>
          {sorted.map((row, i) => {
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
                className={cn(
                  "even:bg-foreground/[0.03] border-b-0",
                  onSelect && "cursor-pointer"
                )}
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
    </div>
  )
}
