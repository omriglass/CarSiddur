import { useState } from "react";

import { RideCard, type RideCardData } from "@/components/RideCard";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { UnmetList, type UnmetListItem } from "./UnmetList";

import type { Suggestion } from "@/solver";

type Segment = "cars" | "unmet" | "proposals";

interface BoardListModeProps {
  rides: readonly RideCardData[];
  onRideClick: (rideId: string) => void;
  unmetItems: readonly UnmetListItem[];
  onUnmetDecision?: (item: UnmetListItem, type: "deny" | "shift" | "external") => void;
  onUnmetAction: (item: UnmetListItem, suggestion: Suggestion | null) => void;
  onOpenProposals: () => void;
}

/** Phone fallback for the board (UX_FLOWS.md §4.2 "Phone fallback — list mode"): רכבים / לא שובצו / הצעות segments. */
export function BoardListMode({ rides, onRideClick, unmetItems, onUnmetAction, onUnmetDecision, onOpenProposals }: BoardListModeProps) {
  const [segment, setSegment] = useState<Segment>("cars");

  return (
    <div className="space-y-3 md:hidden">
      <div className="flex gap-1 rounded-md border p-1" role="tablist">
        {(
          [
            { key: "cars", label: he.sadranBoard.listModeCars },
            { key: "unmet", label: he.sadranBoard.listModeUnmet },
            { key: "proposals", label: he.sadranBoard.listModeProposals },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={segment === tab.key}
            className={cn(
              "flex-1 rounded-sm py-2 text-xs font-medium",
              segment === tab.key ? "bg-primary text-primary-foreground" : "text-muted-foreground",
            )}
            onClick={() => (tab.key === "proposals" ? onOpenProposals() : setSegment(tab.key))}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {segment === "cars" ? (
        <div className="space-y-2">
          {rides.map((ride) => (
            <RideCard key={ride.id} ride={ride} onClick={() => onRideClick(ride.id)} />
          ))}
        </div>
      ) : null}

      {segment === "unmet" ? <UnmetList items={unmetItems} onAction={onUnmetAction} onDecision={onUnmetDecision} /> : null}
    </div>
  );
}
