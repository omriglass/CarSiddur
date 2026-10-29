import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { NOT_MOVED_BY_WEEK_CHANGES, isStableQuery } from "@/lib/queryPolicy";

import type { WatchChange, WatchScope } from "./watcher";

/**
 * The lean refresh after a watched counter moved (REQ item 149): only the queries that show that
 * department-week (or, for the department counter, its catalogs) — not `invalidateWeekData`'s broad
 * set, which is for the person who made a change. `invalidateQueries` refetches only the queries a
 * mounted screen uses; the rest are just marked stale.
 *
 * Exact key positions, as in `queryPolicy.ts` (`invalidation.test.ts` pins every family):
 *  - `["siddur", "boardRides"|"carLocations"|"carStartLocations", dept, week]`
 *  - `["siddur", "weeks", dept]`, `["siddur", "myUpcomingRides", profile, dept]`, `["siddur", "myChildrenRides", dept, ...]`
 *  - `["siddur", "rideChanges", user, dept?, week?, fromWeek?]` (the unscoped Inbox form too), `["siddur", "carNeighbours", ...]`,
 *    `["siddur", "boardRideById", id]`
 *  - `["requests", "mine"|"freedOffers", ...]` (not a single request's form data)
 *  - `["waitlist", dept, week]`
 *  - Sadran scope only: `["sadran", dept, week, ...]` (board, requests, proposals, held notices, readiness, …)
 *    and the not-week-keyed `["sadran", "mergePreview"|"seriesLegs"|"proposalParties"|"freedClaims"|"proposalHostRide", ...]`.
 */
const WEEK_KEYED_SIDDUR = new Set<unknown>(["boardRides", "carLocations", "carStartLocations"]);
const ANY_WEEK_SIDDUR = new Set<unknown>(["carNeighbours", "boardRideById"]);
// Not `byId`/`companions`: they feed an open request form, which must not reload under the member's hands
// (a conflicting change still surfaces as stale_version on save, as before).
const REQUEST_FAMILIES = new Set<unknown>(["mine", "freedOffers"]);
const SADRAN_UNSCOPED = new Set<unknown>(["mergePreview", "seriesLegs", "proposalParties", "freedClaims", "proposalHostRide"]);

export function isWatchedWeekQuery(key: QueryKey, departmentId: string, weeks: ReadonlySet<string>, scope: WatchScope): boolean {
  const [root, family] = key;
  if (root === "siddur") {
    if (WEEK_KEYED_SIDDUR.has(family)) return key[2] === departmentId && weeks.has(key[3] as string);
    if (family === "weeks") return key[2] === departmentId;
    if (family === "myUpcomingRides") return key[3] === departmentId || key[3] === undefined;
    if (family === "myChildrenRides") return key[2] === departmentId;
    if (family === "rideChanges") {
      const dept = key[3];
      const week = key[4];
      return (dept === undefined || dept === departmentId) && (week === undefined || weeks.has(week as string));
    }
    return ANY_WEEK_SIDDUR.has(family);
  }
  if (root === "requests") return REQUEST_FAMILIES.has(family);
  if (root === "waitlist") return family === departmentId && weeks.has(key[2] as string);
  if (root === "sadran" && scope === "sadran") {
    if (SADRAN_UNSCOPED.has(family)) return true;
    return family === departmentId && weeks.has(key[2] as string) && !NOT_MOVED_BY_WEEK_CHANGES.has(key[3]);
  }
  return false;
}

/** Department catalogs (cars, maintenance blocks, settings, members, policies) of one department. */
export function isDepartmentCatalogQuery(key: QueryKey, departmentId: string): boolean {
  if (!key.includes(departmentId)) return false;
  return isStableQuery(key) || key.includes("maintenanceBlocks");
}

export function invalidateWatchedChange(client: QueryClient, departmentId: string, scope: WatchScope, change: WatchChange): Promise<unknown> {
  const work: Promise<unknown>[] = [];
  if (change.weeks.length > 0) {
    const weeks = new Set(change.weeks);
    work.push(client.invalidateQueries({ predicate: (query) => isWatchedWeekQuery(query.queryKey, departmentId, weeks, scope) }));
  }
  if (change.department) {
    work.push(client.invalidateQueries({ predicate: (query) => isDepartmentCatalogQuery(query.queryKey, departmentId) }));
  }
  return Promise.all(work);
}
