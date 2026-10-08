// UX_FLOWS §3.4a: the small bordered pill used inside sheets and on stage 2 (recent places,
// who, flexibility, car choice). `pressed` = selected: tinted fill + primary border.
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface PillChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  pressed?: boolean;
  /** Dashed outline: an "add" affordance ("+ חבר/ה"). */
  dashed?: boolean;
}

export const PillChip = forwardRef<HTMLButtonElement, PillChipProps>(function PillChip({ pressed, dashed, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={cn(
        "relative inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full border px-3 text-sm transition-colors",
        "before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']",
        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
        dashed && "border-dashed text-primary",
        pressed && "border-primary bg-primary/10 font-medium text-primary hover:bg-primary/15 dark:bg-primary/25 dark:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
