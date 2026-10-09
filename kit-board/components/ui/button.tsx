import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Carbon's button: the shape (height, padding, type, the 1px border) is fixed by the
// [data-slot="button"] rule in app/theme.css; the variants here carry only colour.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border-transparent text-sm font-medium whitespace-nowrap outline-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive/60 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The primary action is the content colour itself, not a hue; hue is kept for meaning.
        default: "bg-foreground text-[#131316] hover:bg-content-secondary",
        destructive:
          "border-destructive/32 bg-destructive/12 text-destructive hover:bg-destructive/18",
        outline:
          "border-interactive bg-control text-foreground hover:bg-fill-emphasis",
        secondary:
          "bg-fill-emphasis text-foreground hover:bg-white/12",
        ghost:
          "text-content-secondary hover:bg-fill-control hover:text-foreground",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
