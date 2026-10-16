// The "tight schedule" marker outside the board (siddur, /my list and week view) — the board's own rule
// (`useBoardData`): a reservation holds time only, so it never makes a handover pair, and a pair meeting at the
// car's base (default the department home) is a turnaround, not a handover. Without the base every same-place
// pair looked like a handover and nothing was ever tight (owner 2026-10-16).
import { tightScheduleRideIds } from "@/features/sadran/board/geometry";
import { isReservation } from "./servedOf";
import type { BoardRide } from "@/features/siddur/api";

export function tightRideIdsOf(
  rides: readonly BoardRide[],
  bufferMinutes: number,
  homeLocationId: string | null | undefined,
  cars: readonly { id: string; base_location_id?: string | null }[],
): Set<string> {
  return tightScheduleRideIds(
    rides.map((ride) => (isReservation(ride) ? { ...ride, origin_id: null, destination_id: null } : ride)),
    bufferMinutes,
    { homeLocationId, carBaseLocationId: new Map(cars.map((car) => [car.id, car.base_location_id])) },
  );
}
