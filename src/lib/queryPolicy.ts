import { MutationCache, QueryClient, type Query, type QueryKey } from "@tanstack/react-query";

import { gatesFocusRefetch } from "./counterGate";
import { AppError } from "./rpc";

/**
 * Cache policy per query family (docs/ARCHITECTURE.md "Browser data and caching").
 *
 * Every family refetches when the window regains focus (a PWA resumed from the background must catch
 * up); `staleTime` gates it, so a quick tab flip costs nothing but a resume after the window has
 * expired refreshes at once. Tiers:
 *  - permissions: who I am / what I may manage / who the members are: 1 min
 *  - weeks: week rows and their phase (published/live): 2 min
 *  - catalogs: cars (incl. the all-cars dashboard, `carsOverview`), destinations, ride types, seat configs, department settings, policies,
 *    templates, profile: 10 min
 *  - everything else (rides, requests, board data, inbox): 30 s
 *
 * Classification matches EXACT key positions (never "any part of the key"), so a future week-scoped
 * key that happens to contain a catalog word stays on the 30 s default. `queryPolicy.test.ts`
 * enumerates every builder of the involved key factories and fails on an unclassified one.
 *
 * Exception (`counterGate.ts`): a week's ride/board queries that a mounted `useWeekChangeWatch` covers skip the
 * focus refetch (the watcher checks the week's change counter on return and refreshes what moved), up to
 * a 5-minute safety cap.
 *
 * `invalidateQueries` ignores `staleTime`, so a mutation that invalidates one of these families
 * still refreshes it at once for the person who made the change.
 */
export const DEFAULT_STALE_MS = 30_000;
export const PERMISSIONS_STALE_MS = 60_000;
export const WEEKS_STALE_MS = 2 * 60_000;
export const CATALOG_STALE_MS = 10 * 60_000;

/**
 * Board inputs a change in this week does not move (O28-8, production timeouts 2026-10-29): `fairness_stats` (the
 * lookback before the week), `car_start_locations` (where each car stands when the week begins),
 * `car_mileage_totals` (earlier weeks plus this week's *confirmed* rides only — a planning-time tie-break, refreshed
 * by its staleTime) and `place_travel_for_week` (keyed by the week's place set, so a new place is a new key).
 * Neither `invalidateWeekData` nor the live-sync refresh (`features/liveSync/invalidation.ts`) reloads them.
 */
export const NOT_MOVED_BY_WEEK_CHANGES = new Set<unknown>(["fairnessStats", "carStartLocations", "mileageTotals", "placeTravel"]);

export type QueryTier = "permissions" | "weeks" | "catalog" | "live";

const AUTH_PERMISSIONS = new Set(["departments", "isSadran", "isSadranAnywhere", "departmentMembers"]);
const FLEET_CATALOG = new Set(["cars", "destinations", "rideTypes", "seatConfigs", "turnaroundMinutes"]);
/** `["sadran", <tag>, ...]`: department-independent tags. */
const SADRAN_GLOBAL_CATALOG = new Set(["destinations", "rideTypes", "whatsappTemplates"]);
/** `["sadran", <departmentId>, <tag>, ...]`. */
const SADRAN_DEPT_CATALOG = new Set(["cars", "seatConfigs", "settings", "activePolicy"]);
const SADRAN_DEPT_PERMISSIONS = new Set(["members", "switchableWeeks"]);

/** The freshness tier of a query key. */
export function queryTier(key: QueryKey): QueryTier {
  const [root, tag] = key;
  const third = key[2];
  if (root === "context" || root === "operations") return "permissions";
  if (root === "carsOverview") return "catalog";
  if (root === "auth") {
    if (tag === "profile") return "catalog";
    return typeof tag === "string" && AUTH_PERMISSIONS.has(tag) ? "permissions" : "live";
  }
  if (root === "fleet") return typeof tag === "string" && FLEET_CATALOG.has(tag) ? "catalog" : "live";
  if (root === "siddur") {
    if (tag === "weeks") return "weeks";
    return tag === "departments" ? "permissions" : "live";
  }
  if (root === "sadran") {
    if (typeof tag !== "string") return "live";
    if (tag === "mine") return "permissions";
    if (SADRAN_GLOBAL_CATALOG.has(tag)) return "catalog";
    if (typeof third === "string") {
      if (SADRAN_DEPT_CATALOG.has(third)) return "catalog";
      if (SADRAN_DEPT_PERMISSIONS.has(third)) return "permissions";
      if (key[3] === "weekRow") return "weeks";
    }
  }
  return "live";
}

const TIER_STALE_MS: Record<QueryTier, number> = {
  permissions: PERMISSIONS_STALE_MS,
  weeks: WEEKS_STALE_MS,
  catalog: CATALOG_STALE_MS,
  live: DEFAULT_STALE_MS,
};

/** True for every family that is not on the 30 s default (identity, permission, week-row and catalog data). */
export function isStableQuery(key: QueryKey): boolean {
  return queryTier(key) !== "live";
}

export function queryStaleTime(query: Pick<Query, "queryKey">): number {
  return TIER_STALE_MS[queryTier(query.queryKey)];
}

/** After a successful admin-area mutation, refresh every catalog/permission family at once. */
export function invalidateStableQueries(client: QueryClient): void {
  void client.invalidateQueries({
    predicate: (query) => isStableQuery(query.queryKey),
  });
}

/** The app's QueryClient: per-family freshness above, plus a catalog refresh after any successful admin-area mutation. */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // One retry for a passing failure — but never after a statement timeout: the database is overloaded and a
        // second 8 s attempt only adds to it (production 2026-10-29).
        retry: (failureCount: number, error: unknown) => failureCount < 1 && !(error instanceof AppError && error.code === "server_busy"),
        staleTime: queryStaleTime,
        // true = refetch when stale; a counter-covered week query waits for the watcher's counter check instead.
        refetchOnWindowFocus: (query: Query) => !gatesFocusRefetch(query),
      },
    },
    mutationCache: new MutationCache({
      onSuccess: () => {
        // Admin screens edit memberships, roles, cars, settings, policies, destinations: the board/siddur
        // caches of those families (other key roots than the admin ones) must not wait for their staleTime.
        if (typeof window !== "undefined" && window.location.pathname.startsWith("/admin")) invalidateStableQueries(client);
      },
    }),
  });
  return client;
}
