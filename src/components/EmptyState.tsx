import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  message: string;
  action?: ReactNode;
}

/** Icon, one line, one action (UX_FLOWS.md §7.1: every empty list, never a bare "nothing here"). */
export function EmptyState({ icon: Icon, message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-8 text-center text-muted-foreground">
      <Icon className="size-8" aria-hidden="true" />
      <p className="text-sm">{message}</p>
      {action}
    </div>
  );
}
