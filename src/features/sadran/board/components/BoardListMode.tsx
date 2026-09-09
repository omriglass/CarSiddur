import { useState } from "react";

import { RideCard, type RideCardData } from "@/components/RideCard";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { UnmetList, type UnmetListItem } from "./UnmetList";

import type { Suggestion } from "@/solver";

type Segment = "cars" | "unmet" | "proposals";

interface BoardListModeProps {
  rides: readonly RideCardData[];
  pendingRides?: readonly RideCardData[];
  shadowedRideIds?: ReadonlySet<string>;
  onRideClick: (rideId: string) => void;
  unmetItems: readonly UnmetListItem[];
  onUnmetDecision?: (item: UnmetListItem, type: "deny" | "shift" | "external") => void;
  onUnmetAction: (item: UnmetListItem, suggestion: Suggestion | null) => void;
  onOpenProposals: () => void;
  /** Count of `status='sent'` (awaiting answer) proposals — a small badge on the "הצעות" tab when > 0. */
  pendingProposalsCount?: number;
}

/** Phone fallback for the board (UX_FLOWS.md §4.2 "Phone fallback — list mode"): רכבים / לא שובצו / הצעות segments. */
export function BoardListMode({ rides, pendingRides = [], shadowedRideIds, onRideClick, unmetItems, onUnmetAction, onUnmetDecision, onOpenProposals, pendingProposalsCount = 0 }: BoardListModeProps) {
  const [segment, setSegment] = useState<Segment>("cars");

  return (
    <div className="space-y-3">
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
            {tab.key === "proposals" && pendingProposalsCount > 0 ? (
              <span
                className="ms-1 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 py-0.5 text-[10px] leading-none text-destructive-foreground"
                dir="ltr"
              >
                {pendingProposalsCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {segment === "cars" ? (
        <div className="space-y-2">
          {pendingRides.map((ride) => <div key={ride.id} className="rounded-md border-2 border-dashed p-1">
            <p className="px-2 text-xs text-muted-foreground">{he.rideEditing.pending}</p>
            <RideCard ride={ride} onClick={() => onRideClick(ride.id)} />
          </div>)}
          {rides.map((ride) => (
            <div key={ride.id} data-ride-id={ride.id} tabIndex={-1} className={shadowedRideIds?.has(ride.id) ? "opacity-50" : undefined}>
              <RideCard ride={ride} onClick={() => onRideClick(ride.id)} />
            </div>
          ))}
        </div>
      ) : null}

      {segment === "unmet" ? <UnmetList items={unmetItems} onAction={onUnmetAction} onDecision={onUnmetDecision} /> : null}
    </div>
  );
}
