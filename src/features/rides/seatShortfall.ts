// REQ item 248 (owner 2026-11-17): a member's edit may leave more people on a ride than its car seats ("save and
// warn"); the siddur, "my rides" and the board say so until someone fixes it. The server decides (ride_stretches
// `short`, seats per stretch); here only the cheap first step: the per-direction sum the server checks first, so the
// stretches are read only for the rare ride that may be short. Pure: no React, no Supabase; the words come from he.

import type { RouteLeg, RoutePoint } from "@/lib/rideRoute";

import type { BoardRide } from "./api";
import { peopleOf } from "./ridePeople";
import { legPoints, LEGS, type RideStretches } from "./rideStretches";
import { servedOf } from "./servedOf";

export interface SeatConfigLike {
  car_id: string;
  adults: number;
  child_seats: number;
  boosters: number;
}

export interface SeatLoadSum {
  adults: number;
  childSeats: number;
  boosters: number;
}

export interface SeatShortfall {
  /** Seats missing on the worst stretch. */
  n: number;
  leg: RouteLeg;
  /** The stretch's places; null when the ride has no places in the middle (the whole way). */
  from: string | null;
  to: string | null;
}

/** Seats the best configuration misses for `load` (0 = it fits); null = the car has no seat configuration. */
export function seatsMissing(load: SeatLoadSum, configs: readonly SeatConfigLike[]): number | null {
  if (!configs.length) return null;
  return Math.min(...configs.map((c) =>
    Math.max(load.adults - c.adults, 0) + Math.max(load.childSeats - c.child_seats, 0) + Math.max(load.boosters - c.boosters, 0)));
}

/**
 * The whole of one direction, as the server's first check counts it: every request on it (its own seats), the people
 * added to the ride, and a driver who has no request of their own. Never less than the server's count.
 */
export function legSeatSum(ride: BoardRide, leg: RouteLeg): SeatLoadSum | null {
  const served = servedOf(ride).filter((s) => (s.ride_leg ?? s.leg) === "both" || (s.ride_leg ?? s.leg) === leg);
  const added = peopleOf(ride).filter((p) => p.source === "added" && (!p.leg || p.leg === "both" || p.leg === leg));
  if (!served.length && !added.length) return null;
  const load: SeatLoadSum = { adults: 0, childSeats: 0, boosters: 0 };
  for (const s of served) {
    load.adults += s.adults ?? 0;
    load.childSeats += s.child_seats ?? 0;
    load.boosters += s.boosters ?? 0;
  }
  for (const p of added) {
    if (p.seat_kind === "adult") load.adults += 1;
    else if (p.seat_kind === "child_seat") load.childSeats += 1;
    else load.boosters += 1;
  }
  if (ride.driver_id && !servedOf(ride).some((s) => s.role === "driver")) load.adults += 1;
  return load;
}

/** Whether the ride may have more people than seats: the stretches are read (and decide) only then. */
export function maybeShort(ride: BoardRide, configsOfCar: readonly SeatConfigLike[]): boolean {
  if (ride.status === "cancelled") return false;
  return LEGS.some((leg) => {
    const load = legSeatSum(ride, leg);
    return !!load && (seatsMissing(load, configsOfCar) ?? 0) > 0;
  });
}

/** The worst stretch from the server's `short` per stretch, with its places (`points` = the ride's route). */
export function stretchShortfall(stretches: RideStretches | undefined, points: readonly RoutePoint[]): SeatShortfall | null {
  let worst: SeatShortfall | null = null;
  for (const leg of LEGS) {
    const short = stretches?.[leg]?.short ?? [];
    const pts = legPoints(points, leg);
    short.forEach((n, i) => {
      if (n > 0 && (!worst || n > worst.n)) {
        const middle = pts.length > 2;
        worst = { n, leg, from: middle ? (pts[i]?.name ?? null) : null, to: middle ? (pts[i + 1]?.name ?? null) : null };
      }
    });
  }
  return worst;
}

/** "חסרים 2 מקומות" / "חסר מקום אחד" - the card, the grid block and the ride sheet. */
export function seatsShortLabel(short: SeatShortfall | null | undefined, words: { one: string; many: (n: number) => string }): string | undefined {
  if (!short) return undefined;
  return short.n === 1 ? words.one : words.many(short.n);
}
