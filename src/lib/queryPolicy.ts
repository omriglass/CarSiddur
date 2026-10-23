import { MutationCache, QueryClient, type Query, type QueryKey } from "@tanstack/react-query";

/**
 * Cache policy per query family (docs/ARCHITECTURE.md "Browser data and caching").
 *
 * Identity, permission and catalog data (who I am, which departments I belong to, whether I may
 * manage a week/operations, cars, destinations, ride types, department settings, policies) changes
 * rarely and only through mutations that invalidate it. It stays fresh for 10 minutes and is NOT
 * refetched when the window regains focus. Everything else (rides, requests, board data, inbox)
 * keeps the QueryClient default (30 s, refetch on focus).
 *
 * `invalidateQueries` ignores `staleTime`, so a mutation that invalidates one of these families
 * still refreshes it at once for the person who made the change.
 */
export const DEFAULT_STALE_MS = 30_000;
export const STABLE_STALE_MS = 10 * 60_000;
/** Week rows carry the phase (published/live), which members wait for: shorter than the catalogs. */
export const WEEKS_STALE_MS = 2 * 60_000;

const AUTH_STABLE = new Set(["profile", "departments", "isSadran", "isSadranAnywhere", "departmentMembers"]);
const FLEET_STABLE = new Set(["cars", "destinations", "rideTypes", "seatConfigs", "turnaroundMinutes"]);
/** `sadranKeys` put the tag either right after the root or last (`[root, dept, "cars"]`). */
const SADRAN_STABLE = new Set([
  "cars", "seatConfigs", "destinations", "rideTypes", "settings", "activePolicy", "whatsappTemplates", "mine", "switchableWeeks",
]);

function isWeeksKey(key: QueryKey): boolean {
  return key[0] === "siddur" && key[1] === "weeks";
}

/** True for identity/permission/catalog query families (see file header). */
export function isStableQuery(key: QueryKey): boolean {
  const [root, tag] = key;
  if (root === "context" || root === "operations") return true;
  if (root === "auth") return typeof tag === "string" && AUTH_STABLE.has(tag);
  if (root === "fleet") return typeof tag === "string" && FLEET_STABLE.has(tag);
  if (root === "siddur") return tag === "departments";
  if (root === "sadran") return key.some((part, index) => index > 0 && typeof part === "string" && SADRAN_STABLE.has(part));
  return false;
}

export function queryStaleTime(query: Pick<Query, "queryKey">): number {
  if (isWeeksKey(query.queryKey)) return WEEKS_STALE_MS;
  return isStableQuery(query.queryKey) ? STABLE_STALE_MS : DEFAULT_STALE_MS;
}

export function queryRefetchesOnFocus(query: Pick<Query, "queryKey">): boolean {
  return !isStableQuery(query.queryKey) && !isWeeksKey(query.queryKey);
}

/** After a successful admin-area mutation, refresh every catalog/permission family at once. */
export function invalidateStableQueries(client: QueryClient): void {
  void client.invalidateQueries({
    predicate: (query) => isStableQuery(query.queryKey) || isWeeksKey(query.queryKey),
  });
}

/** The app's QueryClient: per-family freshness above, plus a catalog refresh after any successful admin-area mutation. */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: queryStaleTime,
        refetchOnWindowFocus: queryRefetchesOnFocus,
      },
    },
    mutationCache: new MutationCache({
      onSuccess: () => {
        // Admin screens edit memberships, roles, cars, settings, policies, destinations: the board/siddur
        // caches of those families (other key roots than the admin ones) must not wait 10 minutes.
        if (typeof window !== "undefined" && window.location.pathname.startsWith("/admin")) invalidateStableQueries(client);
      },
    }),
  });
  return client;
}
