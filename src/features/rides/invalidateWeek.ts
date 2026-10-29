import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import { requestsKeys } from "@/features/requests/queryKeys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { noteOwnRefresh } from "@/lib/ownRefresh";

import { fetchWeekRidesSubset, type BoardRide } from "./api";

/**
 * Board inputs computed from earlier weeks only (`fairness_stats`: the lookback before the week; `car_start_locations`:
 * where each car stands when the week begins) — nothing done in this week changes them (O28-8).
 */
const EARLIER_WEEKS_ONLY = new Set<unknown>(["fairnessStats", "carStartLocations"]);

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
  return Promise.all([
    ids.length ? refreshRides(queryClient, departmentId, weekStart, ids) : null,
    queryClient.invalidateQueries({
      queryKey: sadranKeys.week(departmentId, weekStart),
      predicate: (query) => !EARLIER_WEEKS_ONLY.has(query.queryKey[3]),
    }),
    // REQ item 108 (M1): the server's merge verdicts/windows are not week-keyed; any ride or request change can alter them.
    queryClient.invalidateQueries({ queryKey: sadranKeys.mergePreviews() }),
    queryClient.invalidateQueries({ predicate: (query) => isSiddurQueryAffectedByWeek(query, departmentId, weekStart) }),
    queryClient.invalidateQueries({ queryKey: requestsKeys.all }),
  ]);
}

/** The cached copies of one week's `week_board_rides` rows: the board's and the siddur's. */
function weekRideKeys(departmentId: string, weekStart: string): QueryKey[] {
  return [sadranKeys.boardRides(departmentId, weekStart), siddurKeys.boardRides(departmentId, weekStart)];
}

async function refreshRides(queryClient: QueryClient, departmentId: string, weekStart: string, rideIds: string[]): Promise<void> {
  // Only lists on screen: their full reload is already running and replaces the patch. A list nobody watches just
  // stays invalidated — `setQueryData` would mark the patched copy fresh and skip its reload.
  const keys = weekRideKeys(departmentId, weekStart).filter((key) =>
    queryClient.getQueryData(key) !== undefined && (queryClient.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount() ?? 0) > 0);
  if (!keys.length) return;
  const startedAt = Date.now();
  let rows: BoardRide[];
  try {
    rows = await fetchWeekRidesSubset(departmentId, weekStart, rideIds);
  } catch {
    return; // the full reload behind it still brings the change
  }
  for (const key of keys) {
    // A full read that landed after this one started is at least as new: never overwrite it with older rows.
    if ((queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) > startedAt) continue;
    queryClient.setQueryData<BoardRide[]>(key, (old) => (old ? patchRides(old, rideIds, rows) : old));
  }
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
