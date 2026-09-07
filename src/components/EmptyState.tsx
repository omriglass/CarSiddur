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
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary/10">
        <Icon className="size-6 text-primary" aria-hidden="true" />
      </span>
      <p className="text-sm text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}
