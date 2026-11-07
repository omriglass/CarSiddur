import { Sparkles } from "lucide-react";

import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

/** WS1 (REQ §13.185 f): faint sparkle on a freshly washed car. Absolute, never takes taps or drags, no layout shift. */
export function CarSparkle({ className }: { className?: string }) {
  return (
    <span
      className={cn("pointer-events-none absolute end-0.5 top-0.5 text-amber-500 dark:text-amber-300", className)}
      title={he.carSparkle.label}
      role="img"
      aria-label={he.carSparkle.label}
      data-testid="car-sparkle"
    >
      <Sparkles className="size-3 animate-car-sparkle motion-reduce:animate-none" aria-hidden="true" />
    </span>
  );
}
