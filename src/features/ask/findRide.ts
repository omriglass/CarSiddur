// REQ item 258 (d), UX_FLOWS §3.4b "Find a ride": the rides a member may join and a free shared car, for the day, place
// and time the chat understood. Ranked as the join list (`joinable_rides_for_request`) ranks: place (any place on the
// ride's way out within the department's join radius), time (±2 h of the asked time; no time = the whole day), a free
// seat — nearest place first, then the earliest. Pure; the chat feeds it the week's rides and free windows.
import type { BoardRide } from "@/features/siddur/api";
import type { CarFreeWindow } from "@/features/siddur/freeWindows";
import { freeSeats, peopleOf } from "@/features/rides/ridePeople";
import { dateKey, formatTime } from "@/lib/time";
import { parseRideRoute } from "@/lib/rideRoute";

export interface FindPlace { id: string; name: string; lat: number | null; lng: number | null }

export interface JoinableRide {
  ride: BoardRide;
  freeSeats: number;
  /** km from the asked place to the nearest place on the ride's way out (0 = the same place). */
  distanceKm: number;
}

export interface FreeCar { carId: string; carName: string; start: number; end: number }

/** The join list's window: a ride leaving within 2 hours of the asked time. */
export const JOIN_WINDOW_MINUTES = 120;
/** A free car is offered when it is free from the asked time for at least this long (no time: its longest gap that day). */
export const FREE_CAR_MIN_MINUTES = 60;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const toMinutes = (time: string) => {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return h * 60 + m;
};

/** The places on a ride's way out (route points of the out leg, else its destination). */
function outPlaceIds(ride: BoardRide): string[] {
  const ids = parseRideRoute(ride.route).filter((p) => p.leg === "out" && p.placeId).map((p) => p.placeId as string);
  if (ride.destination_id) ids.push(ride.destination_id);
  return [...new Set(ids)];
}

export function findJoinableRides(input: {
  rides: readonly BoardRide[];
  day: string;
  /** The asked place (a list place), or null: any place. A typed place not on the list matches by name only. */
  place: FindPlace | null;
  placeText: string | null;
  /** "HH:MM" the member wants to leave (arrive-by already turned into a leaving time), or null: the whole day. */
  time: string | null;
  places: readonly FindPlace[];
  radiusKm: number;
  /** Adult seats per car (the car's largest configuration). */
  adultSeats: (carId: string) => number;
  me: string | undefined;
}): JoinableRide[] {
  const byId = new Map(input.places.map((p) => [p.id, p]));
  const found: JoinableRide[] = [];
  for (const ride of input.rides) {
    if (!ride.id || !ride.starts_at || !ride.car_id || ride.status === "cancelled" || ride.auto_relocation) continue;
    if (dateKey(ride.starts_at) !== input.day) continue;
    const people = peopleOf(ride);
    if (!people.length) continue;
    if (input.me && people.some((p) => p.person_id === input.me)) continue;
    if (input.time) {
      const at = toMinutes(formatTime(new Date(ride.starts_at)));
      if (Math.abs(at - toMinutes(input.time)) > JOIN_WINDOW_MINUTES) continue;
    }
    let distanceKm = 0;
    if (input.place) {
      const target = input.place;
      const distances = outPlaceIds(ride).flatMap((id) => {
        if (id === target.id) return [0];
        const p = byId.get(id);
        return p && p.lat !== null && p.lng !== null && target.lat !== null && target.lng !== null
          ? [haversineKm({ lat: p.lat, lng: p.lng }, { lat: target.lat, lng: target.lng })] : [];
      });
      if (!distances.length) continue;
      distanceKm = Math.min(...distances);
      if (distanceKm > input.radiusKm) continue;
    } else if (input.placeText) {
      const text = input.placeText.trim();
      if (!(ride.destination_name ?? "").includes(text)) continue;
    }
    const seats = freeSeats(people, { adults: input.adultSeats(ride.car_id), child_seats: 0, boosters: 0 });
    if (seats < 1) continue;
    found.push({ ride, freeSeats: seats, distanceKm });
  }
  return found.sort((a, b) => a.distanceKm - b.distanceKm
    || Date.parse(a.ride.starts_at as string) - Date.parse(b.ride.starts_at as string)
    || (a.ride.id as string).localeCompare(b.ride.id as string));
}

/**
 * One free shared car for the asked time: free from the time (rounded down to the quarter) for at least an hour; with
 * no time, the car with the longest free gap that day (at least an hour). Nothing when no car fits.
 */
export function findFreeCar(input: {
  freeWindows: readonly CarFreeWindow[];
  cars: readonly { id: string; name: string }[];
  /** epoch ms of the asked leaving time, or null. */
  at: number | null;
}): FreeCar | null {
  const min = FREE_CAR_MIN_MINUTES * 60_000;
  const names = new Map(input.cars.map((c) => [c.id, c.name]));
  const fits = input.freeWindows
    .filter((w) => names.has(w.carId))
    .filter((w) => (input.at === null ? w.end - w.start >= min : w.start <= input.at && w.end - input.at >= min))
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.carId.localeCompare(b.carId));
  const best = fits[0];
  return best ? { carId: best.carId, carName: names.get(best.carId) ?? "", start: best.start, end: best.end } : null;
}
