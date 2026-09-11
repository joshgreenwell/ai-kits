"use client"

import * as React from "react"
import { cn } from "cn"

export type DiffLine =
  | { kind: "fold"; count: number }
  | {
      kind: "context" | "add" | "del" | "move"
      oldLine?: number
      newLine?: number
      text: string
      note?: string
    }

/**
 * A control-surface diff.
 *
 * Added lines take the primary green - the same stop that means validated
 * elsewhere - because an added permission is the system accepting something
 * new. Moved lines take their own tone so a reordering never reads as a change.
 */
export function DiffView({
  file,
  revisions,
  lines,
  verdict,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  file: string
  revisions?: string
  lines: DiffLine[]
  verdict?: React.ReactNode
}) {
  const counts = lines.reduce(
    (acc, l) => {
      if (l.kind === "add") acc.add++
      else if (l.kind === "del") acc.del++
      else if (l.kind === "move") acc.move++
      return acc
    },
    { add: 0, del: 0, move: 0 }
  )

  return (
    <div
      data-slot="diff-view"
      className={cn("border-border overflow-hidden rounded-lg border", className)}
      {...props}
    >
      <div className="bg-muted border-border text-muted-foreground flex flex-wrap items-center gap-3 border-b px-3 py-2 font-mono text-[11px]">
        <span className="text-foreground">{file}</span>
        {revisions ? <span>{revisions}</span> : null}
        <span className="text-primary">+{counts.add}</span>
        <span className="text-destructive">-{counts.del}</span>
        {counts.move ? <span className="text-info">moved {counts.move}</span> : null}
      </div>

      <div className="overflow-x-auto font-mono text-xs leading-relaxed">
        {lines.map((line, i) =>
          line.kind === "fold" ? (
            <Fold key={i} count={line.count} />
          ) : (
            <div
              key={i}
              className={cn(
                "grid min-w-[440px] grid-cols-[40px_40px_18px_minmax(0,1fr)]",
                line.kind === "add" && "bg-primary/15 text-primary",
                line.kind === "del" && "bg-destructive/15 text-destructive",
                line.kind === "move" && "bg-info/15 text-info",
                line.kind === "context" && "text-muted-foreground"
              )}
            >
              <span className="text-muted-foreground/60 border-border border-r px-1.5 text-right select-none">
                {line.oldLine ?? ""}
              </span>
              <span className="text-muted-foreground/60 border-border border-r px-1.5 text-right select-none">
                {line.newLine ?? ""}
              </span>
              <span className="px-1 text-center select-none" aria-hidden>
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "move" ? "\u2195" : ""}
              </span>
              <span className="px-1.5 whitespace-pre">
                {line.text}
                {line.note ? <span className="opacity-70">  {line.note}</span> : null}
              </span>
            </div>
          )
        )}
      </div>

      {verdict ? (
        <div className="border-border bg-card border-t px-3 py-2">{verdict}</div>
      ) : null}
    </div>
  )
}

function Fold({ count }: { count: number }) {
  const [open, setOpen] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className="bg-muted border-border text-muted-foreground hover:text-primary focus-visible:ring-ring/50 w-full border-y px-3 py-1.5 text-left font-mono text-[11px] outline-none focus-visible:ring-[3px]"
    >
      {open ? `\u2212 hide ${count} unchanged lines` : `\u22ef ${count} unchanged lines`}
    </button>
  )
}
