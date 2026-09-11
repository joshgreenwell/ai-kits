import * as React from "react"
import { Label } from "@/components/ui/label"
import { cn } from "cn"

/**
 * A labelled control with its help text and error wired to it.
 *
 * Field owns the id so that label htmlFor, aria-describedby and aria-invalid
 * cannot drift apart - the usual way an accessible form stops being one.
 */
export function Field({
  label,
  help,
  error,
  htmlFor,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode
  help?: React.ReactNode
  error?: React.ReactNode
  htmlFor: string
  children: React.ReactNode
}) {
  const helpId = `${htmlFor}-help`
  const errorId = `${htmlFor}-error`
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ")

  return (
    <div data-slot="field" className={cn("grid gap-1.5", className)} {...props}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {React.isValidElement<Record<string, unknown>>(children)
        ? React.cloneElement(children, {
            id: htmlFor,
            "aria-invalid": error ? true : undefined,
            "aria-describedby": describedBy || undefined,
          })
        : children}
      {help ? (
        <p id={helpId} className="text-muted-foreground text-xs leading-snug">
          {help}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-destructive text-xs leading-snug">
          {error}
        </p>
      ) : null}
    </div>
  )
}
