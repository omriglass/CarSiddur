import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

/** Where the member's consent stands for a changed request (REQ §13.161): not an enum, so not a `StatusBadge`. */
export type ConsentChipState = "none" | "draft" | "sent" | "agreed";

const TONE: Record<Exclude<ConsentChipState, "none">, string> = {
  draft: "border border-dashed border-primary bg-primary/10 text-primary",
  sent: "bg-maintenance/15 text-maintenance",
  agreed: "bg-available/15 text-available",
};

export function ConsentChip({ state, className }: { state: ConsentChipState; className?: string }) {
  if (state === "none") return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-semibold", TONE[state], className)} data-consent={state}>
      {he.rideDelta[state === "agreed" ? "agreed" : state]}
    </span>
  );
}
