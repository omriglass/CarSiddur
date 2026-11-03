import { formatTime } from "@/lib/time";

import { TRIP_TYPE_LABEL, waitingRoute } from "../waitingLabels";
import { waitingPeople } from "../siddurLanes";
import type { WaitingRequest } from "../types";

/**
 * REQ §13.182: one waiting request in the phone day list - hours, who and where in normal-size
 * text, styled like the "my rides" waiting block so it never reads as a booked ride.
 */
export function WaitingRequestCard({ request, onClick }: { request: WaitingRequest; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="siddur-waiting-card"
      className="w-full rounded-md border-2 border-dashed border-muted-foreground bg-muted/45 p-3 text-start"
    >
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold" dir="ltr">{formatTime(new Date(request.starts_at))}–{formatTime(new Date(request.ends_at))}</span>
        <span className="font-medium">{waitingPeople(request).join(", ")}</span>
      </span>
      <span className="block text-sm">{waitingRoute(request)} · {TRIP_TYPE_LABEL[request.trip_type]}</span>
    </button>
  );
}
