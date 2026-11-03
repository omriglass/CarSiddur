import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { tv } from "@/i18n/he";

/**
 * REQ §13.182: the siddur header's waiting-list button, right after the pencil, shown while anyone waits on the
 * day. Its badge counts them; tapping it scrolls smoothly to the "בדיון" lane and the "חסר רכב" columns (the
 * list view's waiting cards on the phone). It hides nothing — the waiting list is always on the siddur.
 */
export function WaitlistScrollButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="relative"
      aria-label={tv("waitlist.scrollTo", { count: String(count) })}
      data-testid="siddur-waitlist-button"
      onClick={onClick}
    >
      <Users className="size-5" aria-hidden="true" />
      <span className="absolute -end-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-700 px-1 text-xs font-bold text-white" data-testid="siddur-waitlist-count">
        {count}
      </span>
    </Button>
  );
}
