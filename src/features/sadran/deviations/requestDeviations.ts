import type { BoardRide, WeekRequestRow } from "../api";
import { servedOf } from "../solverRun";

export type DeviationKind = "depart" | "arrival" | "preferredCar" | "passenger" | "missingDriver" | "unassigned" | "status";
export interface RequestDeviation {
  request: WeekRequestRow;
  changes: { kind: DeviationKind; original?: string | null; current?: string | null; rideId?: string }[];
}

/** Compare passenger legs, not deadhead travel, against the owner's original times. */
export function requestDeviations(requests: readonly WeekRequestRow[], rides: readonly BoardRide[]): RequestDeviation[] {
  const links = rides.filter((r) => r.status !== "cancelled").flatMap((ride) => servedOf(ride).map((entry) => ({ ride, entry })));
  const result: RequestDeviation[] = [];
  for (const request of requests) {
    if (request.status === "draft" || request.status === "withdrawn") continue;
    const changes: RequestDeviation["changes"] = [];
    const assignments = links.filter(({ entry }) => entry.request_id === request.id);
    const originalDepart = request.original_depart_at ?? request.depart_at;
    const originalReturn = request.original_return_at ?? request.return_at;
    const compareTime = (kind: "depart" | "arrival", original: string | null, current: string | null, rideId: string | null) => {
      if (original && current && Date.parse(original) !== Date.parse(current)) changes.push({ kind, original, current, rideId: rideId ?? undefined });
    };
    for (const { ride, entry } of assignments) {
      if (entry.leg === "both" || entry.leg === "out") compareTime("depart", originalDepart, ride.starts_at, ride.id);
      if (entry.leg === "both" || entry.leg === "return") compareTime("arrival", originalReturn, ride.ends_at, ride.id);
      if (request.preferred_car_id && ride.car_id !== request.preferred_car_id) {
        changes.push({ kind: "preferredCar", original: request.preferred_car_id, current: ride.car_id, rideId: ride.id ?? undefined });
      }
      if (ride.needs_driver) changes.push({ kind: "missingDriver", rideId: ride.id ?? undefined });
      else if (entry.role === "passenger") changes.push({ kind: "passenger", current: ride.driver_name, rideId: ride.id ?? undefined });
    }
    if (["denied", "external", "cancelled"].includes(request.status)) changes.push({ kind: "status", current: request.status });
    else if (!assignments.length) changes.push({ kind: "unassigned" });
    if (changes.length) result.push({ request, changes });
  }
  return result.sort((a, b) => {
    const aTime = a.request.original_depart_at ?? a.request.original_return_at ?? a.request.depart_at ?? a.request.return_at ?? "";
    const bTime = b.request.original_depart_at ?? b.request.original_return_at ?? b.request.depart_at ?? b.request.return_at ?? "";
    return aTime.localeCompare(bTime) || a.request.id.localeCompare(b.request.id);
  });
}
