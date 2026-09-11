"use client"

import * as React from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "cn"

/**
 * A copy control that names what it copied, both in its label and in the
 * confirmation. "Copy" alone leaves the user guessing what landed on the
 * clipboard; "Copy the command" then "Copied the command" does not.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel,
  className,
  variant = "ghost",
  size = "sm",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "value" | "children"> & {
  value: string
  label?: string
  copiedLabel?: string
}) {
  const [copied, setCopied] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  React.useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      return
    }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={copy}
      className={cn("font-mono", className)}
      {...props}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? (copiedLabel ?? label.replace(/^Copy/, "Copied")) : label}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </Button>
  )
}
