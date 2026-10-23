import { describe, expect, it, vi } from "vitest";

import {
  createQueryClient,
  DEFAULT_STALE_MS,
  invalidateStableQueries,
  isStableQuery,
  queryRefetchesOnFocus,
  queryStaleTime,
  STABLE_STALE_MS,
  WEEKS_STALE_MS,
} from "./queryPolicy";

const stable = [
  ["auth", "profile", "u1"],
  ["auth", "departments", "u1"],
  ["auth", "isSadran", "u1", "d1", "2026-10-25"],
  ["auth", "isSadranAnywhere", "u1", "d1"],
  ["auth", "departmentMembers", "d1"],
  ["context", "departments", "u1"],
  ["operations", "access", "u1", "d1"],
  ["fleet", "cars", "d1"],
  ["fleet", "destinations", "d1"],
  ["fleet", "rideTypes", "d1"],
  ["fleet", "seatConfigs", "d1"],
  ["sadran", "d1", "cars"],
  ["sadran", "d1", "settings"],
  ["sadran", "d1", "activePolicy", "options"],
  ["sadran", "destinations"],
  ["sadran", "rideTypes"],
  ["sadran", "d1", "switchableWeeks", "u1", "2026-10-25"],
];
const live = [
  ["siddur", "boardRides", "d1", "2026-10-25"],
  ["siddur", "myUpcomingRides", "u1", "d1"],
  ["siddur", "rideChanges", "u1", "d1", "2026-10-25"],
  ["sadran", "d1", "2026-10-25", "weekRow"],
  ["sadran", "d1", "2026-10-25", "boardRides"],
  ["sadran", "d1", "2026-10-25", "proposals"],
  ["auth", "pushSubscriptionCount", "u1"],
  ["requests", "mine", "u1"],
  ["inbox", "unread"],
  ["fleet", "myTemporaryCars", "u1"],
];

describe("query cache policy", () => {
  it("treats identity, permission and catalog families as stable", () => {
    for (const key of stable) {
      expect(isStableQuery(key), key.join("/")).toBe(true);
      expect(queryStaleTime({ queryKey: key })).toBe(STABLE_STALE_MS);
      expect(queryRefetchesOnFocus({ queryKey: key })).toBe(false);
    }
  });

  it("keeps ride, board and request data fresh at 30 s and refetching on focus", () => {
    for (const key of live) {
      expect(isStableQuery(key), key.join("/")).toBe(false);
      expect(queryStaleTime({ queryKey: key })).toBe(DEFAULT_STALE_MS);
      expect(queryRefetchesOnFocus({ queryKey: key })).toBe(true);
    }
  });

  it("gives week rows a short stable window without refetch on focus", () => {
    const key = ["siddur", "weeks", "d1"];
    expect(queryStaleTime({ queryKey: key })).toBe(WEEKS_STALE_MS);
    expect(queryRefetchesOnFocus({ queryKey: key })).toBe(false);
  });

  it("installs the policy as the client's defaults", () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions().queries;
    expect(defaults?.staleTime).toBe(queryStaleTime);
    expect(defaults?.refetchOnWindowFocus).toBe(queryRefetchesOnFocus);
  });

  it("invalidates stable families (and only them) on demand", async () => {
    const client = createQueryClient();
    client.setQueryData(["auth", "profile", "u1"], { id: "u1" });
    client.setQueryData(["siddur", "boardRides", "d1", "w"], []);
    const spy = vi.spyOn(client, "invalidateQueries");
    invalidateStableQueries(client);
    const predicate = spy.mock.calls[0]?.[0]?.predicate;
    const profile = client.getQueryCache().find({ queryKey: ["auth", "profile", "u1"] });
    const rides = client.getQueryCache().find({ queryKey: ["siddur", "boardRides", "d1", "w"] });
    expect(predicate?.(profile!)).toBe(true);
    expect(predicate?.(rides!)).toBe(false);
  });
});
