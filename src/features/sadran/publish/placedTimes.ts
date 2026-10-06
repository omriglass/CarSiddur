// R3B19: the publish recipient list shows the times a member was PLACED at (the rides serving the
// request), not the times they asked for. Pure; falls back to the requested times when no ride serves it.
import { servedOf } from "@/features/rides/servedOf";
import type { BoardRide } from "../api";

export function placedTimes(
  request: { id: string; depart_at: string | null; return_at: string | null },
  rides: readonly BoardRide[],
): { departAt: string | null; returnAt: string | null } {
  const serving = rides.flatMap((ride) =>
    ride.starts_at && ride.ends_at && ride.status !== "cancelled"
      ? servedOf(ride).filter((entry) => entry.request_id === request.id).map((entry) => ({ ride, leg: entry.leg ?? "both" }))
      : []);
  if (!serving.length) return { departAt: request.depart_at, returnAt: request.return_at };
  const outs = serving.filter((s) => s.leg !== "return").map((s) => Date.parse(s.ride.starts_at as string));
  const backs = serving.filter((s) => s.leg !== "out").map((s) => Date.parse(s.ride.ends_at as string));
  const returnStarts = serving.filter((s) => s.leg === "return").map((s) => Date.parse(s.ride.starts_at as string));
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    departAt: outs.length ? iso(Math.min(...outs)) : request.depart_at,
    returnAt: backs.length ? iso(returnStarts.length && !outs.length ? Math.min(...returnStarts) : Math.max(...backs)) : request.return_at,
  };
}
