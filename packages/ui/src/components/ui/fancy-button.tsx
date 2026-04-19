import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Slot } from "@/components/ui/slot";

// Matte solid: thin inner top highlight + pill-style elevation (hairline
// outer ring + stacked tight/soft drops with navy tint).
const SOLID_SHADOW =
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_0_1px_rgba(14,18,27,0.12),0_1px_2px_rgba(14,18,27,0.12),0_2px_4px_-1px_rgba(14,18,27,0.08)]";

const SOLID_SHADOW_HOVER =
  "hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_0_1px_rgba(14,18,27,0.14),0_2px_4px_rgba(14,18,27,0.14),0_4px_8px_-2px_rgba(14,18,27,0.10)]";

const SOLID_SHADOW_ACTIVE =
  "active:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(14,18,27,0.14),0_1px_1px_rgba(14,18,27,0.14)]";

// Outlined (basic) buttons: same pill elevation as solids but without the
// inner highlight.
const OUTLINE_SHADOW =
  "shadow-[0_0_0_1px_rgba(14,18,27,0.12),0_1px_2px_rgba(14,18,27,0.12),0_2px_4px_-1px_rgba(14,18,27,0.08)]";

const OUTLINE_SHADOW_HOVER =
  "hover:shadow-[0_0_0_1px_rgba(14,18,27,0.14),0_2px_4px_rgba(14,18,27,0.14),0_4px_8px_-2px_rgba(14,18,27,0.10)]";

const OUTLINE_SHADOW_ACTIVE =
  "active:shadow-[0_0_0_1px_rgba(14,18,27,0.14),0_1px_1px_rgba(14,18,27,0.14)]";

const fancyButtonRoot = cva(
  [
    "group relative inline-flex items-center justify-center whitespace-nowrap typography-ui-label outline-none",
    "transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out",
    "focus:outline-none",
    "disabled:pointer-events-none disabled:text-muted-foreground/60",
    "disabled:bg-interactive-hover disabled:shadow-none",
  ],
  {
    variants: {
      variant: {
        neutral: [
          "bg-foreground text-background",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
        ],
        primary: [
          "bg-[var(--primary-base)] text-white",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
        ],
        destructive: [
          "bg-[var(--status-error)] text-white",
          SOLID_SHADOW,
          SOLID_SHADOW_HOVER,
          SOLID_SHADOW_ACTIVE,
        ],
        basic: [
          "bg-background text-foreground",
          "hover:bg-interactive-hover hover:text-foreground",
          OUTLINE_SHADOW,
          OUTLINE_SHADOW_HOVER,
          OUTLINE_SHADOW_ACTIVE,
        ],
      },
      size: {
        medium: "h-10 gap-3 rounded-[var(--radius-xl)] px-3.5",
        small: "h-9 gap-3 rounded-[var(--radius-lg)] px-3",
        xsmall: "h-8 gap-2 rounded-[var(--radius-lg)] px-2.5",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "medium",
    },
  },
);

const fancyButtonIcon = cva("relative z-10 size-5 shrink-0", {
  variants: {
    size: {
      medium: "-mx-1",
      small: "-mx-1",
      xsmall: "-mx-1",
    },
  },
  defaultVariants: {
    size: "medium",
  },
});

type FancyButtonVariants = VariantProps<typeof fancyButtonRoot>;

type FancyButtonContextValue = Pick<FancyButtonVariants, "variant" | "size">;

const FancyButtonContext = React.createContext<FancyButtonContextValue>({});

type RootProps = FancyButtonVariants &
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
  };

const FancyButtonRoot = React.forwardRef<HTMLButtonElement, RootProps>(
  ({ asChild, children, variant, size, className, ...rest }, ref) => {
    const Component = (asChild ? Slot : "button") as React.ElementType;
    const ctx = React.useMemo<FancyButtonContextValue>(
      () => ({ variant, size }),
      [variant, size],
    );

    return (
      <FancyButtonContext.Provider value={ctx}>
        <Component
          ref={ref}
          className={cn(fancyButtonRoot({ variant, size }), className)}
          {...rest}
        >
          {children}
        </Component>
      </FancyButtonContext.Provider>
    );
  },
);
FancyButtonRoot.displayName = "FancyButton.Root";

type IconProps<T extends React.ElementType = "div"> = {
  as?: T;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<T>, "as" | "className">;

function FancyButtonIcon<T extends React.ElementType = "div">({
  as,
  className,
  ...rest
}: IconProps<T>) {
  const { size } = React.useContext(FancyButtonContext);
  const Component = (as ?? "div") as React.ElementType;
  return (
    <Component
      className={cn(fancyButtonIcon({ size }), className)}
      {...rest}
    />
  );
}
FancyButtonIcon.displayName = "FancyButton.Icon";

export { FancyButtonRoot as Root, FancyButtonIcon as Icon };
export { fancyButtonRoot as fancyButtonVariants };
