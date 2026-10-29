import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import { requestsKeys } from "@/features/requests/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { noteOwnRefresh } from "@/lib/ownRefresh";
import { NOT_MOVED_BY_WEEK_CHANGES } from "@/lib/queryPolicy";

import { fetchWeekRidesSubset, type BoardRide } from "./api";
import { servedOf } from "./servedOf";

/** `siddur` query families keyed by `(departmentId, weekStart)` at positions 2 and 3. */
const WEEK_KEYED_SIDDUR = new Set<unknown>(["boardRides", "carLocations", "weekExport"]);

/**
 * Every `siddur` query except week-keyed data of *other* weeks (code review 2026-09-24 R7).
 * Non-week siddur queries (weeks/phases, a ride's detail, my upcoming rides, car lookups) may
 * all reflect a ride change, so they refresh as before; only other weeks' rides are skipped.
 */
export function isSiddurQueryAffectedByWeek(query: Pick<Query, "queryKey">, departmentId: string, weekStart: string): boolean {
  const [root, family, dept, week] = query.queryKey;
  if (root !== siddurKeys.all[0]) return false;
  if (!WEEK_KEYED_SIDDUR.has(family)) return true;
  return dept === departmentId && week === weekStart;
}

/**
 * Refresh everything a ride/request change in one department-week can affect: that week's
 * Sadran board, the siddur (minus other weeks' rides), and the requests feature. The requests
 * keys are all per-user or per-request, so `requestsKeys.all` costs nothing extra and keeps
 * `byId`/`companions`/`freedOffers` fresh. Callers add feature-specific keys (waitlist, inbox).
 *
 * `rideIds` (O28-8): the rides the action itself changed. They are read on their own (a few ms) and
 * patched into the week's ride lists at once, while the full reload — which also brings any side
 * effects on other rides — runs behind them.
 */
export function invalidateWeekData(queryClient: QueryClient, departmentId: string, weekStart: string, rideIds?: readonly (string | null | undefined)[]): Promise<unknown> {
  // O28-8: this refetch already holds the change, so its own live-sync broadcast need not reload the week again.
  noteOwnRefresh(departmentId, weekStart);
  const ids = [...new Set((rideIds ?? []).filter((id): id is string => !!id))];
  // Read before the patch: the changed rides' cars and requests as they were (a moved ride leaves its old car).
  const before = cachedWeekRides(queryClient, departmentId, weekStart);
  return Promise.all([
    ids.length
      ? refreshRides(queryClient, departmentId, weekStart, ids).then((rows) =>
          invalidateMergePreviews(queryClient, rows && mergePreviewScope(ids, before, rows, cachedWeekRides(queryClient, departmentId, weekStart))))
      : invalidateMergePreviews(queryClient, null),
    queryClient.invalidateQueries({
      queryKey: sadranKeys.week(departmentId, weekStart),
      predicate: (query) => !NOT_MOVED_BY_WEEK_CHANGES.has(query.queryKey[3]),
    }),
    queryClient.invalidateQueries({ predicate: (query) => isSiddurQueryAffectedByWeek(query, departmentId, weekStart) }),
    queryClient.invalidateQueries({ queryKey: requestsKeys.all }),
  ]);
}

/** The cached copies of one week's `week_board_rides` rows: the board's and the siddur's. */
function weekRideKeys(departmentId: string, weekStart: string): QueryKey[] {
  return [sadranKeys.boardRides(departmentId, weekStart), siddurKeys.boardRides(departmentId, weekStart)];
}

/** Every cached ride of the week (board and siddur copies), by id. */
function cachedWeekRides(queryClient: QueryClient, departmentId: string, weekStart: string): Map<string, BoardRide> {
  const byId = new Map<string, BoardRide>();
  for (const key of weekRideKeys(departmentId, weekStart)) {
    for (const ride of queryClient.getQueryData<BoardRide[]>(key) ?? []) if (ride.id) byId.set(ride.id, ride);
  }
  return byId;
}

/** What a set of changed rides can touch in a merge verdict: those rides, their cars (before and after) and the requests on them. */
export interface MergePreviewScope {
  rideIds: ReadonlySet<string>;
  carIds: ReadonlySet<string>;
  requestIds: ReadonlySet<string>;
  /** Ride id -> car id, for the previews' host rides. */
  carOf: ReadonlyMap<string, string | null>;
}

export function mergePreviewScope(
  rideIds: readonly string[], before: ReadonlyMap<string, BoardRide>, rows: readonly BoardRide[], after: ReadonlyMap<string, BoardRide>,
): MergePreviewScope {
  const carIds = new Set<string>();
  const requestIds = new Set<string>();
  const note = (ride: BoardRide | undefined) => {
    if (!ride) return;
    if (ride.car_id) carIds.add(ride.car_id);
    for (const entry of servedOf(ride)) if (entry.request_id) requestIds.add(entry.request_id);
  };
  for (const id of rideIds) note(before.get(id));
  rows.forEach(note);
  const carOf = new Map<string, string | null>();
  for (const [id, ride] of [...before, ...after]) carOf.set(id, ride.car_id ?? null);
  return { rideIds: new Set(rideIds), carIds, requestIds, carOf };
}

/**
 * REQ item 108 (M1): a merge verdict/window (`merge_preview`) depends on the host ride, the other rides on its car
 * (turnaround, the grown window) and the guest request. Perf 2026-10-29: with a known set of changed rides only the
 * previews they can touch reload; a host ride the cache does not know reloads too. `scope` null = reload them all.
 */
export function isMergePreviewTouched(key: QueryKey, scope: MergePreviewScope): boolean {
  const [, , rideId, requestId] = key;
  if (typeof rideId !== "string" || typeof requestId !== "string") return true;
  if (scope.rideIds.has(rideId) || scope.requestIds.has(requestId)) return true;
  if (!scope.carOf.has(rideId)) return true;
  const car = scope.carOf.get(rideId);
  return !car || scope.carIds.has(car);
}

function invalidateMergePreviews(queryClient: QueryClient, scope: MergePreviewScope | null): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: sadranKeys.mergePreviews(),
    predicate: scope ? (query) => isMergePreviewTouched(query.queryKey, scope) : undefined,
  });
}

/** Reads the changed rides and patches them into the lists on screen. Their rows, or null when nothing was read. */
async function refreshRides(queryClient: QueryClient, departmentId: string, weekStart: string, rideIds: string[]): Promise<BoardRide[] | null> {
  // Only lists on screen: their full reload is already running and replaces the patch. A list nobody watches just
  // stays invalidated — `setQueryData` would mark the patched copy fresh and skip its reload.
  const keys = weekRideKeys(departmentId, weekStart).filter((key) =>
    queryClient.getQueryData(key) !== undefined && (queryClient.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount() ?? 0) > 0);
  if (!keys.length) return null;
  const startedAt = Date.now();
  let rows: BoardRide[];
  try {
    rows = await fetchWeekRidesSubset(departmentId, weekStart, rideIds);
  } catch {
    return null; // the full reload behind it still brings the change
  }
  for (const key of keys) {
    // A full read that landed after this one started is at least as new: never overwrite it with older rows.
    if ((queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) > startedAt) continue;
    queryClient.setQueryData<BoardRide[]>(key, (old) => (old ? patchRides(old, rideIds, rows) : old));
  }
  return rows;
}

/**
 * `rows` replace the cached rides with the same id; an asked-for ride missing from `rows` is gone (cancelled,
 * no longer visible) and leaves the list; a new one is added. Kept in `starts_at` order when the list was.
 */
export function patchRides(old: readonly BoardRide[], rideIds: readonly string[], rows: readonly BoardRide[]): BoardRide[] {
  const asked = new Set(rideIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const sorted = old.every((ride, i) => i === 0 || (old[i - 1]?.starts_at ?? "") <= (ride.starts_at ?? ""));
  const next: BoardRide[] = [];
  for (const ride of old) {
    const fresh = ride.id ? byId.get(ride.id) : undefined;
    if (fresh) {
      next.push(fresh);
      byId.delete(fresh.id as string);
    } else if (!ride.id || !asked.has(ride.id)) {
      next.push(ride);
    }
  }
  next.push(...byId.values());
  return sorted ? next.sort((a, b) => ((a.starts_at ?? "") < (b.starts_at ?? "") ? -1 : (a.starts_at ?? "") > (b.starts_at ?? "") ? 1 : 0)) : next;
}
