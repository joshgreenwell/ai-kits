import * as React from "react"
import { Badge } from "@/components/ui/badge"
import { CopyButton } from "@/components/kit/copy-button"
import { cn } from "cn"

/**
 * CLI output with its exit code visible.
 *
 * The kits exit non-zero when a rule fires, so the exit code is the headline,
 * not a footnote - and the copy control names the command it copied.
 */
export function TerminalBlock({
  command,
  children,
  exitCode,
  note,
  caption,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  command?: string
  children: React.ReactNode
  exitCode?: number
  note?: React.ReactNode
  caption?: React.ReactNode
}) {
  return (
    <div
      data-slot="terminal-block"
      className={cn("border-border overflow-hidden rounded-lg border bg-black/40", className)}
      {...props}
    >
      {(caption || command) && (
        <div className="border-border text-muted-foreground flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2 font-mono text-[11px]">
          <span>{caption}</span>
          {command ? <CopyButton value={command} label="Copy the command" size="xs" /> : null}
        </div>
      )}
      <pre className="text-foreground/85 overflow-x-auto px-3 py-3 font-mono text-xs leading-relaxed">
        {children}
      </pre>
      {exitCode !== undefined ? (
        <div className="border-border flex flex-wrap items-center gap-3 border-t px-3 py-2">
          <Badge variant={exitCode === 0 ? "soft" : "soft-destructive"}>exit {exitCode}</Badge>
          {note ? (
            <span className="text-muted-foreground font-mono text-[11px]">{note}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
