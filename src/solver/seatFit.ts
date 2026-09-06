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

/** Luggage fit: number of luggage requests in a ride <= luggageCapacity(car). */
export function luggageFits(car: Car, luggageCount: number): boolean {
  return luggageCount <= car.luggageCapacity;
}

/** Chauffeur load: served requests' passengers plus one adult for the volunteer (SOLVER §3.3, REQ §13.65). */
export function chauffeurLoad(served: Passengers): Passengers {
  return sum(served, { adults: 1, childSeats: 0, boosters: 0 });
}
