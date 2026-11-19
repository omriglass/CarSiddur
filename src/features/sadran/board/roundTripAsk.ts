// RT1 (REQ item 251, owner 2026-11-17/19): a board edit can leave a ride that looks like a round trip - it ends where
// it started and covers a request's return hour - while that request rides it only on the way out and its way back is
// placed nowhere (production 2026-11-18: an out-leg lengthened to the return hours, the way back never placed). The
// board then asks once: "נראה שזו נסיעה הלוך-חזור" (a round trip) or "נראה שזו גם נסיעת האיסוף" (a הקפצה's pickup).
// "Yes" stores the request on the ride for both ways (leg `both`, as `join_drop_off_legs` does); "no" is remembered.
import { servedOf, type ServedEntry } from "@/features/rides/servedOf";
import type { BoardRide, WeekRequestRow } from "@/features/sadran/api";

export interface RoundTripAsk {
  rideId: string;
  requestId: string;
  kind: "round_trip" | "drop_off";
  name: string;
  /** The ride's end and the request's return (pickup) hour, ISO. */
  endsAt: string;
  returnAt: string;
  originName: string;
}

type RideLike = Pick<BoardRide, "id" | "status" | "origin_id" | "destination_id" | "origin_name" | "ends_at" | "served">;
type RequestLike = Pick<WeekRequestRow, "id" | "trip_type" | "return_at" | "requester_full_name">;

function coversReturn(entry: ServedEntry): boolean {
  return entry.leg === "return" || entry.leg === "both";
}

/** The first request on `ride` (by id) whose way back the ride already covers in time but does not carry. */
export function roundTripAsk(ride: RideLike, rides: readonly RideLike[], requests: readonly RequestLike[]): RoundTripAsk | null {
  if (!ride.id || ride.status === "cancelled" || !ride.ends_at || !ride.origin_id || ride.origin_id !== ride.destination_id) return null;
  const outs = servedOf(ride as BoardRide)
    .filter((entry) => entry.leg === "out" && entry.request_id)
    .sort((a, b) => (a.request_id! < b.request_id! ? -1 : a.request_id! > b.request_id! ? 1 : 0));
  for (const entry of outs) {
    const request = requests.find((r) => r.id === entry.request_id);
    if (!request?.return_at) continue;
    const kind = request.trip_type === "round_trip" ? "round_trip" : request.trip_type === "drop_off" ? "drop_off" : null;
    if (!kind || (kind === "drop_off" && entry.car_mode !== "chauffeur")) continue;
    if (Date.parse(ride.ends_at) < Date.parse(request.return_at)) continue;
    const backPlaced = rides.some((other) => other.status !== "cancelled"
      && servedOf(other as BoardRide).some((e) => e.request_id === request.id && coversReturn(e)));
    if (backPlaced) continue;
    return {
      rideId: ride.id, requestId: request.id, kind,
      name: entry.requester ?? request.requester_full_name ?? "",
      endsAt: ride.ends_at, returnAt: request.return_at, originName: ride.origin_name ?? "",
    };
  }
  return null;
}

/** The served rows `edit_ride` gets for "yes": the request rides both ways (a relay way out becomes `keep`). */
export function servedWithBothWays<T extends { request_id: string; leg: "out" | "return" | "both"; car_mode: ServedEntry["car_mode"] }>(
  served: readonly T[], requestId: string,
): T[] {
  return served.map((row) => row.request_id === requestId && row.leg === "out"
    ? { ...row, leg: "both", car_mode: row.car_mode === "relay" ? "keep" : row.car_mode }
    : row);
}

const DECLINED_KEY = "carsiddur.roundTripAsk.declined";

/** "לא" is remembered per device for that ride and request (localStorage; asked again elsewhere at worst). */
export function roundTripAskDeclined(ask: Pick<RoundTripAsk, "rideId" | "requestId">): boolean {
  try {
    const list = JSON.parse(localStorage.getItem(DECLINED_KEY) ?? "[]") as unknown;
    return Array.isArray(list) && list.includes(`${ask.rideId}:${ask.requestId}`);
  } catch { return false; }
}

export function rememberRoundTripAskDeclined(ask: Pick<RoundTripAsk, "rideId" | "requestId">): void {
  try {
    const list = JSON.parse(localStorage.getItem(DECLINED_KEY) ?? "[]") as unknown;
    const next = [...(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []), `${ask.rideId}:${ask.requestId}`];
    localStorage.setItem(DECLINED_KEY, JSON.stringify(next.slice(-200)));
  } catch { /* storage unavailable: asked again next time */ }
}
