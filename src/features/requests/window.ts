import type { RequestStatus, RideStatus, WeekPhase } from "@/lib/enums";

export interface RequestWindow {
  phase: WeekPhase;
  open_at: string;
  close_at: string;
}

export function isRequestWindowOpen(window: RequestWindow | null | undefined, now = Date.now()): boolean {
  return !!window && (window.phase === "open" || window.phase === "solving") && now >= Date.parse(window.open_at) && now <= Date.parse(window.close_at);
}


/** Draft solver placements remain editable until the submission deadline. */
export function canEditRequest(request: {
  status: RequestStatus;
  window?: RequestWindow | null;
  hasPublishedRide?: boolean;
  ride?: { status: RideStatus } | null;
}, now = Date.now()): boolean {
  return isRequestWindowOpen(request.window, now)
    && !["withdrawn", "cancelled"].includes(request.status)
    && !request.hasPublishedRide
    && (!request.ride || request.ride.status === "draft" || request.ride.status === "cancelled");
}
