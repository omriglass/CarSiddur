import { describe, expect, it, vi } from "vitest";

import { authKeys, contextKeys } from "@/features/auth/queryKeys";
import { operationsKeys } from "@/features/admin/queryKeys";
import { carsOverviewKeys } from "@/features/carsOverview/keys";
import { fleetKeys } from "@/features/fleet/queryKeys";
import { ridesKeys } from "@/features/rides/keys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";

import {
  CATALOG_STALE_MS,
  createQueryClient,
  DEFAULT_STALE_MS,
  invalidateStableQueries,
  isStableQuery,
  PERMISSIONS_STALE_MS,
  queryStaleTime,
  queryTier,
  WEEKS_STALE_MS,
  type QueryTier,
} from "./queryPolicy";

const STALE: Record<QueryTier, number> = {
  permissions: PERMISSIONS_STALE_MS,
  weeks: WEEKS_STALE_MS,
  catalog: CATALOG_STALE_MS,
  live: DEFAULT_STALE_MS,
};

type Builders = Record<string, unknown>;
/** Every builder of a key factory: expected tier by name. A new builder with no entry fails the test. */
function checkFactory(name: string, factory: Builders, expected: Record<string, QueryTier>) {
  it(`${name}: every builder is classified and matches`, () => {
    const names = Object.keys(factory).filter((k) => typeof factory[k] === "function");
    expect(names.sort(), `unclassified or stale entries in ${name}`).toEqual(Object.keys(expected).sort());
    for (const builder of names) {
      const key = (factory[builder] as (...args: unknown[]) => readonly unknown[])("a", "b", "c", "d");
      expect(queryTier(key as never), `${name}.${builder} -> ${key.join("/")}`).toBe(expected[builder]);
    }
  });
}

describe("query cache policy: key factories", () => {
  checkFactory("authKeys", authKeys, {
    profile: "catalog", myDepartments: "permissions", isSadran: "permissions", isSadranAnywhere: "permissions",
    departmentMembers: "permissions", pushSubscriptionCount: "live",
  });
  checkFactory("carsOverviewKeys", carsOverviewKeys, { department: "catalog", checklists: "catalog" });
  checkFactory("contextKeys", contextKeys, { departments: "permissions" });
  checkFactory("operationsKeys", operationsKeys, { access: "permissions", departments: "permissions" });
  checkFactory("fleetKeys", fleetKeys, {
    cars: "catalog", destinations: "catalog", rideTypes: "catalog", seatConfigs: "catalog", turnaroundMinutes: "catalog",
    myTemporaryCars: "live", maintenanceBlocks: "live",
  });
  checkFactory("siddurKeys", siddurKeys, {
    departments: "permissions", currentWeekStart: "live", weeks: "weeks", boardRides: "live", boardRideById: "live",
    carForRide: "live", carStartLocations: "live", carLocations: "live", myUpcomingRides: "live", myChildren: "live",
    myChildrenRides: "live", myCoGuardians: "live", weekExport: "live",
  });
  checkFactory("ridesKeys", ridesKeys, { rideChanges: "live", carNeighbours: "live" });
  checkFactory("sadranKeys", sadranKeys, {
    week: "live", weekRow: "weeks", boardRides: "live", carLocations: "live", weekRequestsWithNames: "live",
    cars: "catalog", seatConfigs: "catalog", destinations: "catalog", fairnessStats: "live", mileageTotals: "live",
    heldNotices: "live", carStartLocations: "live", mergePreviews: "live", mergePreview: "live", placeTravel: "live",
    seriesLegs: "live", rideTypes: "catalog", departmentSettings: "catalog", activePolicy: "catalog",
    maintenanceBlocks: "live", solverRuns: "live", proposals: "live", proposalParties: "live", freedOffers: "live",
    freedClaims: "live", siddurVersions: "live", auditLog: "live", departmentMembers: "permissions",
    whatsappTemplates: "catalog", mySadranDepartments: "permissions", policyOptions: "catalog", profilesByIds: "live",
    publicationConflicts: "live", publicationReadiness: "live", switchableWeeks: "permissions", reopenFingerprint: "live",
    excelExport: "live", proposalHostRide: "live",
  });

  it("matches catalog words only at their exact position", () => {
    // a week-scoped key whose last part is a catalog word stays live
    expect(queryTier(["sadran", "d1", "2026-10-25", "cars"])).toBe("live");
    expect(queryTier(["siddur", "boardRides", "settings", "cars"])).toBe("live");
    expect(queryTier(["requests", "mine", "cars"])).toBe("live");
  });
});

describe("query cache policy: freshness", () => {
  it("uses the tier's staleTime and treats everything but live as stable", () => {
    for (const [key, tier] of [
      [["auth", "isSadran", "u", "d", "w"], "permissions"],
      [["siddur", "weeks", "d"], "weeks"],
      [["sadran", "d", "2026-10-25", "weekRow"], "weeks"],
      [["fleet", "cars", "d"], "catalog"],
      [["siddur", "boardRides", "d", "w"], "live"],
    ] as const) {
      expect(queryTier(key)).toBe(tier);
      expect(queryStaleTime({ queryKey: key })).toBe(STALE[tier]);
      expect(isStableQuery(key)).toBe(tier !== "live");
    }
  });

  it("installs the policy as the client's defaults and refetches on focus everywhere (counter-gated week reads excepted)", () => {
    const defaults = createQueryClient().getDefaultOptions().queries;
    expect(defaults?.staleTime).toBe(queryStaleTime);
    const onFocus = defaults?.refetchOnWindowFocus as (query: { queryKey: readonly unknown[]; state: { dataUpdatedAt: number } }) => boolean;
    // No watcher registered here (counterGate.test.ts covers the gating): every family refetches when stale.
    for (const key of [["siddur", "boardRides", "d", "w"], ["siddur", "weeks", "d"], ["auth", "profile", "u"], ["sadran", "d", "w", "boardRides"]]) {
      expect(onFocus({ queryKey: key, state: { dataUpdatedAt: Date.now() } }), key.join("/")).toBe(true);
    }
  });

  it("invalidates stable families (and only them) on demand", () => {
    const client = createQueryClient();
    client.setQueryData(["auth", "profile", "u1"], { id: "u1" });
    client.setQueryData(["siddur", "weeks", "d1"], []);
    client.setQueryData(["siddur", "boardRides", "d1", "w"], []);
    const spy = vi.spyOn(client, "invalidateQueries");
    invalidateStableQueries(client);
    const predicate = spy.mock.calls[0]?.[0]?.predicate;
    const find = (queryKey: string[]) => client.getQueryCache().find({ queryKey })!;
    expect(predicate?.(find(["auth", "profile", "u1"]))).toBe(true);
    expect(predicate?.(find(["siddur", "weeks", "d1"]))).toBe(true);
    expect(predicate?.(find(["siddur", "boardRides", "d1", "w"]))).toBe(false);
  });
});
