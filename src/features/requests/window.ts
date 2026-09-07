import type { Database } from "@/integrations/supabase/types";

export interface RequestWindow {
  phase: Database["public"]["Enums"]["week_phase"];
  open_at: string;
  close_at: string;
}

export function isRequestWindowOpen(window: RequestWindow | null | undefined, now = Date.now()): boolean {
  return !!window && (window.phase === "open" || window.phase === "solving") && now >= Date.parse(window.open_at) && now <= Date.parse(window.close_at);
}


/** Draft solver placements remain editable until the submission deadline. */
export function canEditRequest(request: {
  status: Database["public"]["Enums"]["request_status"];
  window?: RequestWindow | null;
  hasPublishedRide?: boolean;
  ride?: { status: Database["public"]["Enums"]["ride_status"] } | null;
}, now = Date.now()): boolean {
  return isRequestWindowOpen(request.window, now)
    && !["withdrawn", "cancelled"].includes(request.status)
    && !request.hasPublishedRide
    && (!request.ride || request.ride.status === "draft" || request.ride.status === "cancelled");
}
