import { tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { WaitlistGroup } from "../types";

interface WaitlistGroupCardProps {
  group: WaitlistGroup;
  onClick: () => void;
}

/**
 * One "בדיון" card for a contested waiting-list group in the phone day-list
 * (UX_FLOWS.md §3.5/§4.2) — the grid's own lane uses the same label inside
 * `WeekGrid`'s `discussionBlocks`. Deliberately styled to read as "still
 * being decided", not as a booked ride.
 */
export function WaitlistGroupCard({ group, onClick }: WaitlistGroupCardProps) {
  const names = group.members.map((member) => member.name).join(", ");
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border-2 border-dashed border-amber-500 bg-amber-500/5 p-3 text-start text-sm"
    >
      <span className="block font-medium text-amber-900">{tv("waitlist.blockLabel", { names })}</span>
      <span className="text-xs text-muted-foreground" dir="ltr">
        {formatTime(new Date(group.starts_at))}–{formatTime(new Date(group.ends_at))}
      </span>
    </button>
  );
}
