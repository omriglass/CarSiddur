// src/solver/seatFit.ts
//
// Seat fitting (docs/SOLVER.md §3.3). Dominance is strictly component-wise;
// no substitutions are inferred (a booster child does not fit a child-seat
// position and vice versa). Configurations are enumerated by the admin
// exactly so the solver never reasons about physical seat geometry.

import type { Car, Passengers } from './types';

/** q dominates p iff every component of q is >= the matching component of p. */
export function dominates(q: Passengers, p: Passengers): boolean {
  return q.adults >= p.adults && q.childSeats >= p.childSeats && q.boosters >= p.boosters;
}

/** True iff some seat configuration of `car` dominates `p`. */
export function fits(car: Car, p: Passengers): boolean {
  return car.seatConfigs.some((q) => dominates(q, p));
}

/** Total slack (sum of leftover seats) of the minimal dominating configuration; null if none fits. */
export function slack(car: Car, p: Passengers): number | null {
  let best: number | null = null;
  for (const q of car.seatConfigs) {
    if (!dominates(q, p)) continue;
    const total = q.adults - p.adults + (q.childSeats - p.childSeats) + (q.boosters - p.boosters);
    if (best === null || total < best) best = total;
  }
  return best;
}

/** Component-wise sum of any number of passenger sets. Nothing is ever subtracted (SOLVER §3.3). */
export function sum(...ps: Passengers[]): Passengers {
  return ps.reduce(
    (acc, p) => ({
      adults: acc.adults + p.adults,
      childSeats: acc.childSeats + p.childSeats,
      boosters: acc.boosters + p.boosters,
    }),
    { adults: 0, childSeats: 0, boosters: 0 },
  );
}

/**
 * Luggage fit is yes/no (REQ item 21, 2026-10-07): any number of large-luggage
 * requests may ride together on a car with a large trunk (`luggageCapacity > 0`),
 * and a car without one takes none. There is no per-car count cap.
 */
export function luggageFits(car: Car, luggageCount: number): boolean {
  return luggageCount <= 0 || car.luggageCapacity > 0;
}

/**
 * Towing fit (REQ §13.200): a towing request needs a car with the hitch (`Car.towHitch`), and the hitch is used
 * by one towing request at a time - at most one per ride (and per leg).
 */
export function towFits(car: Car, towCount: number): boolean {
  return towCount <= 0 || (towCount <= 1 && car.towHitch === true);
}

/** Both car needs at once: large luggage (large trunk) and towing (hitch, one per ride). */
export function needsFit(car: Car, luggageCount: number, towCount: number): boolean {
  return luggageFits(car, luggageCount) && towFits(car, towCount);
}

/** Chauffeur load: served requests' passengers plus one adult for the volunteer (SOLVER §3.3, REQ §13.65). */
export function chauffeurLoad(served: Passengers): Passengers {
  return sum(served, { adults: 1, childSeats: 0, boosters: 0 });
}

/** `{ towCount }` only when a towing request rides (keeps assignments without towing byte-identical). */
export function towCountField(towCount: number): { towCount?: number } {
  return towCount > 0 ? { towCount } : {};
}

/**
 * A rider on one leg (REQ item 246 h): seats taken from route place `board` up to, not including, `alight`
 * (undefined/null = the leg's start / end). Twin of SQL `_stretch_loads()`; shared cases in
 * supabase/tests/fixtures/stretch_load_cases.json.
 */
export interface StretchRider extends Passengers {
  board?: number | null;
  alight?: number | null;
}

/**
 * Seats per stretch of a leg with `points` route places (points - 1 stretches). Out-of-range places are clamped;
 * a board at or after its alight counts on the whole leg (the safe reading).
 */
export function stretchLoads(points: number, riders: readonly StretchRider[]): Passengers[] {
  const n = Math.max(points - 1, 0);
  const loads: Passengers[] = Array.from({ length: n }, () => ({ adults: 0, childSeats: 0, boosters: 0 }));
  for (const r of riders) {
    let from = Math.min(Math.max(r.board ?? 0, 0), n);
    let to = Math.min(Math.max(r.alight ?? n, 0), n);
    if (from >= to) { from = 0; to = n; }
    for (let s = from; s < to; s++) {
      const l = loads[s]!;
      l.adults += r.adults; l.childSeats += r.childSeats; l.boosters += r.boosters;
    }
  }
  return loads;
}

/** True iff the car takes every stretch (each stretch may use a different seat configuration). */
export function fitsAlong(car: Car, points: number, riders: readonly StretchRider[]): boolean {
  return stretchLoads(points, riders).every((l) => fits(car, l));
}
