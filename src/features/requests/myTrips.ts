// `/my` "one item per trip" (owner 2026-10-13): a request the member made and the ride that serves it
// used to show twice — once under "הנסיעות הקרובות שלי" (ride cards) and again in the week list
// (request rows). Now every week lists one item per trip: a request (carrying the ride cards of the
// rides that serve it) or, for a ride none of my requests reaches (I drive someone else's request,
// a Sadran named me on a reservation), the ride card itself. Pure; ride-agnostic so it stays
// testable without the siddur's row type.
import { groupByWeek, requestStart, type DisplayRow } from "./myRequestsRows";

export interface TripRide {
  id: string | null;
  starts_at: string | null;
  week_start: string | null;
  department_id: string | null;
}

export type TripItem<R extends TripRide> =
  | { kind: "request"; row: DisplayRow; rides: R[] }
  | { kind: "ride"; ride: R };

export interface TripWeek<R extends TripRide> {
  weekStart: string;
  departmentId: string;
  /** The week's request rows (the "withdraw all" button looks at them). */
  rows: DisplayRow[];
  items: TripItem<R>[];
}

function rideStart(ride: TripRide): number {
  return ride.starts_at ? Date.parse(ride.starts_at) : Number.POSITIVE_INFINITY;
}

function byStart<R extends TripRide>(a: R, b: R): number {
  return rideStart(a) - rideStart(b) || (a.id ?? "").localeCompare(b.id ?? "");
}

/**
 * The rides serving each request row (a multi-day series: only its next ride — every day is on the
 * same car, and the card says "day i of n"). Keyed by row id.
 */
export function ridesByRequestRow<R extends TripRide>(
  rows: readonly DisplayRow[],
  rides: readonly R[],
  requestIdsOf: (ride: R) => readonly string[],
): Map<string, R[]> {
  const result = new Map<string, R[]>();
  for (const row of rows) {
    const ids = new Set([row.id, ...(row.seriesLegs ?? []).map((leg) => leg.id)]);
    const serving = rides.filter((ride) => requestIdsOf(ride).some((id) => ids.has(id))).sort(byStart);
    if (serving.length) result.set(row.id, row.seriesLegs ? serving.slice(0, 1) : serving);
  }
  return result;
}

/**
 * `rows` = the request rows listed by week; `elsewhere` = rows shown in another section of the page
 * (the unserved list) — their rides are theirs too, so never listed again as rides of their own.
 */
export function buildTripWeeks<R extends TripRide>(
  rows: readonly DisplayRow[],
  elsewhere: readonly DisplayRow[],
  rides: readonly R[],
  requestIdsOf: (ride: R) => readonly string[],
): TripWeek<R>[] {
  const ridesByRow = ridesByRequestRow([...rows, ...elsewhere], rides, requestIdsOf);
  const linked = new Set<string>();
  for (const row of [...rows, ...elsewhere]) {
    const ids = new Set([row.id, ...(row.seriesLegs ?? []).map((leg) => leg.id)]);
    for (const ride of rides) if (ride.id && requestIdsOf(ride).some((id) => ids.has(id))) linked.add(ride.id);
  }

  const weeks = new Map<string, TripWeek<R>>();
  for (const group of groupByWeek(rows)) {
    weeks.set(`${group.weekStart}:${group.departmentId}`, {
      ...group,
      items: group.rows.map((row) => ({ kind: "request", row, rides: ridesByRow.get(row.id) ?? [] })),
    });
  }
  for (const ride of rides) {
    if (!ride.id || linked.has(ride.id) || !ride.week_start || !ride.department_id) continue;
    const key = `${ride.week_start}:${ride.department_id}`;
    const week = weeks.get(key) ?? { weekStart: ride.week_start, departmentId: ride.department_id, rows: [], items: [] };
    week.items.push({ kind: "ride", ride });
    weeks.set(key, week);
  }

  const itemStart = (item: TripItem<R>) => (item.kind === "request" ? requestStart(item.row) : rideStart(item.ride));
  const itemId = (item: TripItem<R>) => (item.kind === "request" ? item.row.id : (item.ride.id ?? ""));
  return [...weeks.values()]
    .map((week) => ({ ...week, items: [...week.items].sort((a, b) => itemStart(a) - itemStart(b) || itemId(a).localeCompare(itemId(b))) }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.departmentId.localeCompare(b.departmentId));
}
