// R13U3 / R13U9 (REQ §13.148): who a publish notifies — the browser twin of `publish_siddur`'s notice rule, so the
// publish screen counts the same people the server writes to (one notice per member) instead of every request.
// A request on a newly published day is told when it has a ride there, waits, or its offer lapses now; a request on
// a day published again only when its status or a ride serving it changed since the last published version. Pure.
import { servedOf } from "@/features/rides/servedOf";
import type { BoardRide } from "../api";

export interface NoticeRequest {
  id: string;
  requester_id: string;
  status: string;
  /** Jerusalem date key of the request's day (its departure, else its return). */
  day: string;
}

export interface SnapshotRide {
  id: string;
  starts_at: string;
  ends_at: string;
  car_id: string | null;
  driver_id?: string | null;
}

const SILENT_STATUSES = new Set(["draft", "withdrawn", "cancelled", "external"]);

export function publishNotices<R extends NoticeRequest>(params: {
  requests: readonly R[];
  rides: readonly BoardRide[];
  /** Days public before this publish; null on the week's first publish. */
  priorPublishedDays: readonly string[] | null;
  previousStatuses: ReadonlyMap<string, string>;
  previousRides: readonly SnapshotRide[];
  /** Requests whose sent offer lapses at this publish (`expiresAtPublish`). */
  lapsingRequestIds: ReadonlySet<string>;
}): { notified: { requesterId: string; requests: R[] }[]; unnotifiedCount: number } {
  const { requests, rides, priorPublishedDays, previousStatuses, previousRides, lapsingRequestIds } = params;
  const previousRide = new Map(previousRides.map((ride) => [ride.id, ride]));
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ? Date.parse(a) : null) === (b ? Date.parse(b) : null);
  const byPerson = new Map<string, R[]>();
  let unnotifiedCount = 0;
  for (const request of requests) {
    if (SILENT_STATUSES.has(request.status)) continue;
    const serving = rides.filter((ride) => ride.id && ride.status !== "cancelled" && servedOf(ride).some((entry) => entry.request_id === request.id));
    const newDay = !priorPublishedDays || !priorPublishedDays.includes(request.day);
    const told = newDay
      ? serving.length > 0 || request.status === "waitlisted" || lapsingRequestIds.has(request.id)
      : previousStatuses.get(request.id) !== request.status || serving.some((ride) => {
          const before = previousRide.get(ride.id as string);
          return !before || !same(before.starts_at, ride.starts_at) || !same(before.ends_at, ride.ends_at) || before.car_id !== ride.car_id
            || (!!ride.driver_id && before.driver_id !== ride.driver_id);
        });
    if (!told) { unnotifiedCount += 1; continue; }
    byPerson.set(request.requester_id, [...(byPerson.get(request.requester_id) ?? []), request]);
  }
  return { notified: [...byPerson].map(([requesterId, list]) => ({ requesterId, requests: list })), unnotifiedCount };
}
