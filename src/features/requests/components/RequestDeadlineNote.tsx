import { cn } from "@/lib/utils";

import { requestDeadlineText } from "../deadline";

/** The week's request closing time as one quiet line; renders nothing once the week no longer takes requests. */
export function RequestDeadlineNote({ week, className }: { week: { phase: string; close_at: string } | null | undefined; className?: string }) {
  const text = requestDeadlineText(week);
  if (!text) return null;
  return <p className={cn("text-xs text-muted-foreground", className)} data-testid="request-deadline">{text}</p>;
}
