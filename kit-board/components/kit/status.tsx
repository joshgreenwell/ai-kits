import * as React from "react"
import { Badge } from "@/components/ui/badge"

/**
 * Status vocabulary, in one place.
 *
 * Every state in the product maps to exactly one badge here, so a run status
 * cannot be spelled two different ways on two different screens. Colour never
 * carries meaning alone - each badge always shows its word.
 */

export type RunStatus =
  | "validated"
  | "failed"
  | "running"
  | "never-run"
  | "disabled"
  | "incomplete"

const RUN_STATUS: Record<
  RunStatus,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  validated: { label: "validated", variant: "soft" },
  failed: { label: "failed validation", variant: "soft-destructive" },
  running: { label: "running", variant: "outline" },
  "never-run": { label: "never run", variant: "secondary" },
  disabled: { label: "disabled", variant: "outline" },
  incomplete: { label: "incomplete", variant: "outline" },
}

export function StatusBadge({
  status,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant" | "children"> & {
  status: RunStatus
  children?: React.ReactNode
}) {
  const s = RUN_STATUS[status]
  return (
    <Badge variant={s.variant} {...props}>
      {children ?? s.label}
    </Badge>
  )
}

export type Severity = "high" | "medium" | "low" | "incomplete"

const SEVERITY: Record<
  Severity,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  high: { label: "high", variant: "soft-destructive" },
  medium: { label: "medium", variant: "soft-warning" },
  low: { label: "low", variant: "soft-info" },
  incomplete: { label: "incomplete", variant: "outline" },
}

export function SeverityBadge({
  severity,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant" | "children"> & { severity: Severity }) {
  const s = SEVERITY[severity]
  return (
    <Badge variant={s.variant} {...props}>
      {s.label}
    </Badge>
  )
}

/** Claim tiers, per the kits' evidence rules: proven / projected / unresolved. */
export type ClaimTier = "proven" | "projected" | "unresolved" | "incomplete"

const CLAIM: Record<
  ClaimTier,
  { label: string; variant: React.ComponentProps<typeof Badge>["variant"] }
> = {
  proven: { label: "proven", variant: "soft" },
  projected: { label: "projected", variant: "soft-warning" },
  unresolved: { label: "unresolved", variant: "outline" },
  incomplete: { label: "incomplete", variant: "outline" },
}

export function ClaimBadge({
  tier,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant" | "children"> & { tier: ClaimTier }) {
  const c = CLAIM[tier]
  return (
    <Badge variant={c.variant} {...props}>
      {c.label}
    </Badge>
  )
}

/** A small colour key for provider identity, used in tables and legends. */
export function ProviderDot({ tone = 1 }: { tone?: 1 | 2 | 3 | 4 | 5 }) {
  const map = {
    1: "bg-chart-1",
    2: "bg-chart-2",
    3: "bg-chart-3",
    4: "bg-chart-4",
    5: "bg-chart-5",
  } as const
  return <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-xs ${map[tone]}`} />
}
