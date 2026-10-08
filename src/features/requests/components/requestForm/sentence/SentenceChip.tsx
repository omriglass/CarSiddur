// UX_FLOWS §3.4a: one tappable word of the request sentence. Opens the bottom sheet of
// its field; carries `data-field=<rhf name>` so `useScrollToFirstError` can scroll to and focus
// it, and flashes (red) while its field is invalid.
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface SentenceChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** react-hook-form field name this chip stands for. */
  field: string;
  invalid?: boolean;
  /** Smaller chip (stop chips inside the sentence). */
  small?: boolean;
}

export const SentenceChip = forwardRef<HTMLButtonElement, SentenceChipProps>(function SentenceChip(
  { field, invalid, small, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      data-field={field}
      aria-invalid={invalid || undefined}
      className={cn(
        "relative inline-flex h-8 max-w-full items-center whitespace-nowrap rounded-sm border-b-2 border-primary/60 bg-primary/10 px-1.5 font-medium text-primary dark:bg-primary/25 dark:text-foreground",
        "before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']",
        "hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        small && "text-sm",
        invalid && "animate-pulse border-destructive bg-destructive/10 text-destructive",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
