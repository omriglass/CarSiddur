import type { WeekGridCar, WeekGridRide } from "@/components/WeekGrid";
import { packPhantomLanes } from "@/components/weekGridLanes";

import type { WaitingRequest } from "./types";

/** Grid ids of the siddur's waiting-list columns and blocks (REQ §13.182); `phantom:` keeps them out of drags and car swaps. */
export const WAITING_LANE_PREFIX = "phantom:waiting:";
export const WAITING_BLOCK_PREFIX = "waiting:";

export function waitingRequestIdOf(gridRideId: string): string | null {
  return gridRideId.startsWith(WAITING_BLOCK_PREFIX) ? gridRideId.slice(WAITING_BLOCK_PREFIX.length) : null;
}

/** Everyone travelling on a waiting request, requester first. */
export function waitingPeople(request: Pick<WaitingRequest, "requester_name" | "companion_names" | "child_names" | "guest_names">): string[] {
  return [request.requester_name, ...request.companion_names, ...request.child_names, ...request.guest_names];
}

/**
 * The selected day's waiting requests as "missing car" columns: one lane per simultaneous request
 * (`packPhantomLanes`, as on the board), so overlapping requests never share one narrow column.
 * `minutesOf` turns an instant into minutes since midnight on the grid's day; `laneName(i)` names lane i.
 */
export function waitingLanes(
  requests: readonly WaitingRequest[],
  day: string,
  minutesOf: (iso: string) => number,
  laneName: (index: number) => string,
  labelOf: (request: WaitingRequest) => string,
): { cars: WeekGridCar[]; rides: WeekGridRide[] } {
  const items = requests
    .filter((request) => request.day === day)
    .map((request) => {
      const startMinutes = minutesOf(request.starts_at);
      return { id: `${WAITING_BLOCK_PREFIX}${request.request_id}`, request, startMinutes, endMinutes: startMinutes + (Date.parse(request.ends_at) - Date.parse(request.starts_at)) / 60_000 };
    });
  const packed = packPhantomLanes(items);
  const laneCount = packed.reduce((max, item) => Math.max(max, item.lane + 1), 0);
  return {
    cars: Array.from({ length: laneCount }, (_, lane) => ({ id: `${WAITING_LANE_PREFIX}${lane}`, name: laneName(lane), group: "phantom" as const })),
    rides: packed.map((item) => ({
      id: item.id,
      carId: `${WAITING_LANE_PREFIX}${item.lane}`,
      startMinutes: item.startMinutes,
      endMinutes: item.endMinutes,
      label: labelOf(item.request),
      kind: "waiting" as const,
      isMine: item.request.is_mine,
    })),
  };
}
