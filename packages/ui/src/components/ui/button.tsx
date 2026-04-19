import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Slot } from "@/components/ui/slot"

// Matte solid buttons: thin inner top highlight + pill-style elevation
// (hairline outer ring + stacked tight/soft drops with navy tint instead of
// pure black, so shadows don't muddy on colored surfaces).
const SOLID_SHADOW =
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_0_1px_rgba(14,18,27,0.12),0_1px_2px_rgba(14,18,27,0.12),0_2px_4px_-1px_rgba(14,18,27,0.08)]"

const SOLID_SHADOW_HOVER =
  "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_1px_rgba(14,18,27,0.14),0_2px_4px_rgba(14,18,27,0.14),0_4px_8px_-2px_rgba(14,18,27,0.10)]"

const SOLID_SHADOW_ACTIVE =
  "active:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(14,18,27,0.14),0_1px_1px_rgba(14,18,27,0.14)]"

// Outlined buttons: same pill elevation as solids but without the inner
// highlight (no fill to catch light from above).
const OUTLINE_SHADOW =
  "shadow-[0_0_0_1px_rgba(14,18,27,0.12),0_1px_2px_rgba(14,18,27,0.12),0_2px_4px_-1px_rgba(14,18,27,0.08)]"

const OUTLINE_SHADOW_HOVER =
  "hover:shadow-[0_0_0_1px_rgba(14,18,27,0.14),0_2px_4px_rgba(14,18,27,0.14),0_4px_8px_-2px_rgba(14,18,27,0.10)]"

const OUTLINE_SHADOW_ACTIVE =
  "active:shadow-[0_0_0_1px_rgba(14,18,27,0.14),0_1px_1px_rgba(14,18,27,0.14)]"

const buttonVariants = cva(
  [
    "group relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[7px] typography-ui-label font-medium lowercase tracking-[0.01em] shrink-0",
    "transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out outline-none",
    "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
    "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
    "disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: cn(
          "bg-[var(--primary-base)] text-white",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
        ),
        destructive: cn(
          "bg-[var(--status-error)] text-white",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
          "focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        ),
        neutral: cn(
          "bg-foreground text-background",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
        ),
        outline: cn(
          "bg-background text-foreground hover:bg-interactive-hover hover:text-foreground",
          OUTLINE_SHADOW,
          OUTLINE_SHADOW_HOVER,
          OUTLINE_SHADOW_ACTIVE,
        ),
        // Flat chip for "one-of-N" toggles. No elevation; thin border only.
        chip:
          "border border-border/60 bg-transparent text-foreground hover:bg-interactive-hover hover:text-foreground",
        secondary:
          "bg-interactive-hover text-foreground hover:bg-interactive-active",
        ghost:
          "text-foreground hover:bg-interactive-hover hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-2.5 has-[>svg]:px-2 rounded-[6px]",
        xs: "h-6 gap-1 px-2 typography-micro has-[>svg]:px-1.5 rounded-[5px]",
        lg: "h-10 px-4 has-[>svg]:px-3.5 rounded-[8px]",
        icon: "size-9",
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
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants }
