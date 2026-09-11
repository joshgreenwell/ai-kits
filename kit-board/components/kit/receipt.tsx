import * as React from "react"
import { cn } from "cn"

/**
 * A publication receipt: what ran, in order, with the time each step finished.
 *
 * The failure case is built from the same parts as the success case. A failed
 * run is not a missing run, so it keeps its steps and states plainly what was
 * not written.
 */
export function Receipt({ className, ...props }: React.ComponentProps<"ol">) {
  return <ol data-slot="receipt" className={cn("grid", className)} {...props} />
}

export function ReceiptStep({
  state,
  time,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"li">, "children"> & {
  state: "ok" | "fail" | "skip"
  time?: React.ReactNode
  children: React.ReactNode
}) {
  const mark = { ok: "OK", fail: "FAIL", skip: "SKIP" }[state]
  const glyph = { ok: "\u2713", fail: "\u2715", skip: "\u2014" }[state]
  const tone = {
    ok: "text-primary",
    fail: "text-destructive",
    skip: "text-muted-foreground",
  }[state]

  return (
    <li
      data-slot="receipt-step"
      className={cn("border-border flex items-baseline gap-3 border-b py-1.5 last:border-b-0", className)}
      {...props}
    >
      <span className={cn("w-4 shrink-0 font-mono text-xs leading-6", tone)} aria-hidden>
        {glyph}
      </span>
      <span className="sr-only">{mark}: </span>
      <span className="text-muted-foreground min-w-0 flex-1 text-sm [&_b]:text-foreground [&_b]:font-semibold">
        {children}
      </span>
      {time ? (
        <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
          {time}
        </span>
      ) : null}
    </li>
  )
}
