import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { tv } from "@/i18n/he";
import { cn } from "@/lib/utils";

/**
 * REQ §13.182: the siddur header's waiting-list button, beside the pencil / long-range / eye icons.
 * Its badge counts the day's waiting requests (none = no badge); tapping it shows or hides the
 * "חסר רכב" columns (and the "בדיון" lane, and the list view's waiting cards). The choice is per device.
 */
export function WaitlistToggleButton({ count, shown, onChange }: { count: number; shown: boolean; onChange: (shown: boolean) => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className={cn("relative", shown && "border-amber-500 bg-amber-500/10 text-amber-900 hover:bg-amber-500/20")}
      aria-pressed={shown}
      aria-label={tv(shown ? "waitlist.toggleHide" : "waitlist.toggleShow", { count: String(count) })}
      data-testid="siddur-waitlist-toggle"
      onClick={() => onChange(!shown)}
    >
      <Users className="size-5" aria-hidden="true" />
      {count > 0 ? (
        <span className="absolute -end-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-700 px-1 text-xs font-bold text-white" data-testid="siddur-waitlist-count">
          {count}
        </span>
      ) : null}
    </Button>
  );
}
