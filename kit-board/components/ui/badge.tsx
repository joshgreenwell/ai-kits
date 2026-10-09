import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// One size: Carbon's 20px tag, which sits inside a line of small text without pushing the line apart.
// The height is fixed so a badge in a flex row or grid cell never stretches to its neighbours. Every
// tone is the same recipe - a 28% border and a 10% wash of the tone, lettered in the tone itself - and
// the plain variants lean on it a little harder than the soft ones.
const badgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-[7px] text-[11px] leading-none font-medium whitespace-nowrap transition-[color,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:border-destructive/60 [&>svg]:pointer-events-none [&>svg]:size-2.5",
  {
    variants: {
      variant: {
        default: "border-primary/40 bg-primary/16 text-primary [a&]:hover:bg-primary/22",
        secondary:
          "border-interactive bg-fill-subtle text-muted-foreground [a&]:hover:bg-fill-control",
        destructive:
          "border-destructive/40 bg-destructive/16 text-destructive [a&]:hover:bg-destructive/22",
        outline:
          "border-interactive text-content-secondary [a&]:hover:bg-fill-control [a&]:hover:text-foreground",
        warning: "border-warning/40 bg-warning/16 text-warning [a&]:hover:bg-warning/22",
        info: "border-info/40 bg-info/16 text-info [a&]:hover:bg-info/22",
        // Soft tones read better inside dense rows, where a stronger wash shouts.
        soft: "border-primary/28 bg-primary/10 text-primary",
        "soft-destructive": "border-destructive/28 bg-destructive/10 text-destructive",
        "soft-warning": "border-warning/28 bg-warning/10 text-warning",
        "soft-info": "border-info/28 bg-info/10 text-info",
        ghost: "text-content-secondary [a&]:hover:bg-fill-control [a&]:hover:text-foreground",
        link: "text-link underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
