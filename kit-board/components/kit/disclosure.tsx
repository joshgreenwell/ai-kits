"use client"

import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

/**
 * Secondary evidence that would crowd the reading it supports.
 * One quiet trigger, never a full-width control - a disclosure is not a field.
 */
export function Disclosure({
  title,
  defaultOpen,
  className,
  contentClassName,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "title" | "children"> & {
  title: React.ReactNode
  contentClassName?: string
  children: React.ReactNode
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("group/disclosure", className)} {...props}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-foreground -ml-1.5 gap-1.5 px-1.5 font-normal"
        >
          <ChevronRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]/disclosure:rotate-90" />
          {title}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("mt-3", contentClassName)}>{children}</CollapsibleContent>
    </Collapsible>
  )
}
