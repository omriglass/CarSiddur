import { describe, expect, it } from "vitest";

import { requestsKeys } from "@/features/requests/queryKeys";
import { ridesKeys } from "@/features/rides/keys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { waitlistKeys } from "@/features/waitlist/keys";

import { isDepartmentCatalogQuery, isWatchedWeekQuery } from "./invalidation";

const D = "dept-1";
const OTHER = "dept-2";
const W = "2026-11-01";
const W2 = "2026-11-08";
const weeks = new Set([W]);

describe("isWatchedWeekQuery (lean set)", () => {
  it.each([
    ["week rides", siddurKeys.boardRides(D, W)],
    ["car locations", siddurKeys.carLocations(D, W)],
    ["car start locations", siddurKeys.carStartLocations(D, W)],
    ["week rows", siddurKeys.weeks(D)],
    ["my upcoming rides", siddurKeys.myUpcomingRides("me", D)],
    ["children's rides", siddurKeys.myChildrenRides(D, ["c"])],
    ["scoped ride changes", ridesKeys.rideChanges("me", D, W)],
    ["unscoped ride changes", ridesKeys.rideChanges("me", undefined, undefined, W)],
    ["car neighbours", ridesKeys.carNeighbours(["r1"])],
    ["ride sheet", siddurKeys.boardRideById("r1")],
    ["my requests", [...requestsKeys.mine("me"), D]],
    ["freed offers", requestsKeys.freedOffers("me")],
    ["waitlist", waitlistKeys.groups(D, W)],
  ])("member scope refreshes %s", (_label, key) => {
    expect(isWatchedWeekQuery(key, D, weeks, "public")).toBe(true);
  });

  it.each([
    ["another week's rides", siddurKeys.boardRides(D, W2)],
    ["another department's rides", siddurKeys.boardRides(OTHER, W)],
    ["another department's weeks", siddurKeys.weeks(OTHER)],
    ["another week's ride changes", ridesKeys.rideChanges("me", D, W2)],
    ["another week's waitlist", waitlistKeys.groups(D, W2)],
    ["the export", siddurKeys.weekExport(D, W)],
    ["Sadran board data", sadranKeys.boardRides(D, W)],
    ["catalogs", siddurKeys.myChildren("me")],
    ["inbox", ["inbox", "unread", "me"]],
    ["an open request form", requestsKeys.byId("q1")],
    ["a request's companions", requestsKeys.companions("q1")],
  ])("member scope leaves %s alone", (_label, key) => {
    expect(isWatchedWeekQuery(key, D, weeks, "public")).toBe(false);
  });

  it.each([
    ["board rides", sadranKeys.boardRides(D, W)],
    ["readiness", sadranKeys.publicationReadiness(D, W)],
    ["proposals", sadranKeys.proposals(D, W)],
    ["held notices", sadranKeys.heldNotices(D, W)],
    ["merge previews", sadranKeys.mergePreview("r", "q", "out")],
    ["series legs", sadranKeys.seriesLegs("s")],
  ])("Sadran scope also refreshes %s", (_label, key) => {
    expect(isWatchedWeekQuery(key, D, weeks, "sadran")).toBe(true);
  });

  it("Sadran scope leaves other weeks and department catalogs alone", () => {
    expect(isWatchedWeekQuery(sadranKeys.boardRides(D, W2), D, weeks, "sadran")).toBe(false);
    expect(isWatchedWeekQuery(sadranKeys.cars(D), D, weeks, "sadran")).toBe(false);
    expect(isWatchedWeekQuery(sadranKeys.departmentSettings(D), D, weeks, "sadran")).toBe(false);
  });

  it("Sadran scope leaves the inputs a week change does not move alone (perf 2026-10-29)", () => {
    for (const key of [sadranKeys.fairnessStats(D, W, 3), sadranKeys.carStartLocations(D, W), sadranKeys.mileageTotals(D, W), sadranKeys.placeTravel(D, W, "2:x")]) {
      expect(isWatchedWeekQuery(key, D, weeks, "sadran")).toBe(false);
    }
  });
});

describe("isDepartmentCatalogQuery", () => {
  it("refreshes the department's catalogs and maintenance blocks only", () => {
    expect(isDepartmentCatalogQuery(sadranKeys.cars(D), D)).toBe(true);
    expect(isDepartmentCatalogQuery(sadranKeys.departmentSettings(D), D)).toBe(true);
    expect(isDepartmentCatalogQuery(sadranKeys.maintenanceBlocks(D), D)).toBe(true);
    expect(isDepartmentCatalogQuery(sadranKeys.cars(OTHER), D)).toBe(false);
    expect(isDepartmentCatalogQuery(siddurKeys.boardRides(D, W), D)).toBe(false);
  });
});
