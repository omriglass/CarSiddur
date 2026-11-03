import { he } from "@/i18n/he";
import type { TripType } from "@/lib/enums";
import { routeLabel } from "@/lib/routeLabel";

import { waitingPeople } from "./siddurLanes";
import type { WaitingRequest } from "./types";

export const TRIP_TYPE_LABEL: Record<TripType, string> = {
  round_trip: he.request.tripTypeRoundTrip,
  one_way: he.request.tripTypeOneWay,
  drop_off: he.request.tripTypeDropOff,
};

/** "לחיפה" / "מבנימינה לחיפה" for a waiting request (REQ §13.182). */
export function waitingRoute(request: WaitingRequest): string {
  return routeLabel({ destination: request.destination_name ?? "", origin: request.origin_name, originIsHome: request.origin_is_home });
}

/** The grid block and list card line: who · where. */
export function waitingLabel(request: WaitingRequest): string {
  return `${waitingPeople(request).join(", ")} · ${waitingRoute(request)}`;
}
