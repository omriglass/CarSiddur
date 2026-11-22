import type { BoardRide } from "./api";

import { servedOf } from "./servedOf";

type SeriesOf = { seriesIndex: number | null; seriesCount: number | null };

/**
 * R22U10/R22B11: the "יום 1/2" marker on my rides follows MY trip on the ride. A one-day trip riding along on one day of
 * someone else's multi-day ride is not "day 1 of 2" for me; with no trip of mine on it (I drive others, I was added) it is
 * the ride's own.
 */
export function viewerSeriesDay(ride: BoardRide, myRequestOf: (requestId: string) => SeriesOf | undefined, viewerId?: string): SeriesOf {
  const rideDay = { seriesIndex: ride.series_index ?? null, seriesCount: ride.series_count ?? null };
  const none = { seriesIndex: null, seriesCount: null };
  const served = servedOf(ride);
  const mine = served.flatMap((entry) => {
    const row = entry.request_id ? myRequestOf(entry.request_id) : undefined;
    return row ? [row] : [];
  });
  if (mine.length) return mine.find((row) => (row.seriesCount ?? 0) > 1) ?? none;
  // A companion's request is not in their own list once placed: their trip on the ride comes from its people. The
  // multi-day trip holds the car (it drives the ride); a trip riding along as a guest is not on its days.
  const people = (Array.isArray(ride.people) ? ride.people : []) as { person_id?: unknown; request_id?: unknown }[];
  const myTrips = new Set(people.flatMap((p) => (viewerId && p.person_id === viewerId && typeof p.request_id === "string" ? [p.request_id] : [])));
  if (!myTrips.size) return rideDay;
  return served.some((entry) => entry.role === "driver" && entry.request_id && myTrips.has(entry.request_id)) ? rideDay : none;
}
