import type { BoardRide } from "@/features/rides/api";
import { peopleOf } from "@/features/rides/ridePeople";
import { isReservation, servedOf } from "@/features/rides/servedOf";
import { dateKey } from "@/lib/time";

export interface CelebrationStats {
  rides: number;
  people: number;
  /** Rides carrying more than one distinct served request (merged guests, joined rides). */
  shared: number;
}

/**
 * Totals for the publish celebration, from rides already loaded for the week. Counts the
 * non-cancelled, non-reservation rides of the published `days` (all rides when `days` is omitted).
 * "Shared" = a ride that serves more than one distinct request. People = distinct riders
 * (driver included) across those rides.
 */
export function computeCelebrationStats(rides: readonly BoardRide[], days?: readonly string[]): CelebrationStats {
  const counted = rides.filter((ride) =>
    ride.status !== "cancelled" && !!ride.starts_at && !isReservation(ride)
    && (!days || days.includes(dateKey(ride.starts_at))));
  const people = new Set<string>();
  let shared = 0;
  for (const ride of counted) {
    for (const person of peopleOf(ride)) people.add(person.person_id ?? (person.child_id ? `child:${person.child_id}` : person.key));
    if (new Set(servedOf(ride).map((s) => s.request_id)).size > 1) shared += 1;
  }
  return { rides: counted.length, people: people.size, shared };
}

export const FULL_SCALE_CARS = 15;
export const MAX_CARS = 30;

/** Cars on screen: one per ride up to 15, then one more per two rides, capped at 30. */
export function carsToShow(rides: number): number {
  if (rides <= 0) return 0;
  if (rides <= FULL_SCALE_CARS) return rides;
  return Math.min(MAX_CARS, FULL_SCALE_CARS + Math.ceil((rides - FULL_SCALE_CARS) / 2));
}

/** People dots per car from the real average, at least 1 and at most 4 (a car seats few). */
export function peoplePerCar(stats: Pick<CelebrationStats, "rides" | "people">): number {
  if (stats.rides <= 0) return 0;
  return Math.max(1, Math.min(4, Math.round(stats.people / stats.rides)));
}
