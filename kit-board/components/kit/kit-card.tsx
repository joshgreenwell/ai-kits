"use client"

import * as React from "react"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { cn } from "cn"

/**
 * A kit in the registry.
 *
 * Each card prints that kit's own figures in that kit's own units - tokens and
 * dollars for one, reports and gigabytes for another, runs and fired rules for
 * a third - which is what stops six kits reading as six interchangeable tiles.
 * A kit with nothing to count says so rather than padding the row with a zero.
 */
export function KitCard({
  name,
  cadence,
  description,
  figures,
  status,
  enabled,
  onEnabledChange,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Card>, "children"> & {
  name: string
  cadence: string
  description: React.ReactNode
  figures?: { label: string; value: React.ReactNode; tone?: "default" | "primary" | "destructive" }[]
  status?: React.ReactNode
  enabled?: boolean
  onEnabledChange?: (next: boolean) => void
  actions?: React.ReactNode
}) {
  const switchId = React.useId()

  return (
    <Card
      data-slot="kit-card"
      className={cn("gap-4 py-4", !enabled && "bg-card/50", className)}
      {...props}
    >
      <CardHeader className="gap-1 px-4">
        <CardTitle className={cn("text-base", !enabled && "text-muted-foreground")}>
          {name}
        </CardTitle>
        <p className="text-muted-foreground font-mono text-[11px]">{cadence}</p>
        {onEnabledChange ? (
          <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
            <Label htmlFor={switchId} className="sr-only">
              {enabled ? `Disable ${name}` : `Enable ${name}`}
            </Label>
            <Switch id={switchId} checked={enabled} onCheckedChange={onEnabledChange} />
          </div>
        ) : null}
      </CardHeader>

      <CardContent className="grid gap-3 px-4">
        <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
        {figures?.length ? (
          <dl className="border-border flex flex-wrap gap-x-6 gap-y-2 border-t pt-3">
            {figures.map((f) => (
              <div key={f.label}>
                <dt className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
                  {f.label}
                </dt>
                <dd
                  className={cn(
                    "mt-1 font-mono text-lg leading-none font-medium tabular-nums",
                    f.tone === "primary" && "text-primary",
                    f.tone === "destructive" && "text-destructive"
                  )}
                >
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </CardContent>

      {(status || actions) && (
        <CardFooter className="flex flex-wrap items-center justify-between gap-3 px-4">
          {status}
          {actions}
        </CardFooter>
      )}
    </Card>
  )
}
