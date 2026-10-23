// R14U1: the phone board's cars list in time order - grouped by Jerusalem day, each day sorted by start
// (tie-break car name, then id).
import { dateKey } from "@/lib/time";

export interface TimedRide {
  id: string;
  startsAt: string;
  carName: string | null;
}

export function compareRidesByStart(a: TimedRide, b: TimedRide): number {
  return Date.parse(a.startsAt) - Date.parse(b.startsAt)
    || (a.carName ?? "").localeCompare(b.carName ?? "", "he")
    || a.id.localeCompare(b.id);
}

export function groupRidesByDay<T extends TimedRide>(rides: readonly T[]): { day: string; rides: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const ride of [...rides].sort(compareRidesByStart)) {
    const day = dateKey(ride.startsAt);
    const list = groups.get(day) ?? [];
    list.push(ride);
    groups.set(day, list);
  }
  return [...groups.entries()].map(([day, list]) => ({ day, rides: list }));
}
