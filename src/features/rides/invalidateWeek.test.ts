import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { sadranKeys } from "@/features/sadran/keys";

import { siddurKeys } from "@/features/siddur/queryKeys";

import { invalidateWeekData, isSiddurQueryAffectedByWeek } from "./invalidateWeek";
import { ridesKeys } from "./keys";

const DEPT = "dept-a";
const WEEK = "2026-09-27";
const affected = (queryKey: readonly unknown[]) => isSiddurQueryAffectedByWeek({ queryKey }, DEPT, WEEK);

describe("isSiddurQueryAffectedByWeek", () => {
  it("refreshes the changed week's rides, car locations and export", () => {
    expect(affected(siddurKeys.boardRides(DEPT, WEEK))).toBe(true);
    expect(affected(siddurKeys.carLocations(DEPT, WEEK))).toBe(true);
    expect(affected(siddurKeys.weekExport(DEPT, WEEK))).toBe(true);
  });

  it("skips other weeks and other departments of the week-keyed families", () => {
    expect(affected(siddurKeys.boardRides(DEPT, "2026-10-04"))).toBe(false);
    expect(affected(siddurKeys.carLocations("dept-b", WEEK))).toBe(false);
    expect(affected(siddurKeys.weekExport("dept-b", "2026-10-04"))).toBe(false);
  });

  it("still refreshes every non-week siddur query, as the old siddurKeys.all did", () => {
    expect(affected(siddurKeys.weeks(DEPT))).toBe(true);
    expect(affected(siddurKeys.boardRideById("ride-1"))).toBe(true);
    expect(affected(siddurKeys.myUpcomingRides("me", DEPT))).toBe(true);
    expect(affected(siddurKeys.carForRide("car-1"))).toBe(true);
    expect(affected(siddurKeys.currentWeekStart())).toBe(true);
    // Pending ride changes (the member's "change:" grid blocks) must refresh with the week.
    expect(affected(ridesKeys.rideChanges("me", DEPT, WEEK))).toBe(true);
  });

  it("ignores queries of other features", () => {
    expect(affected(["sadran", DEPT, WEEK])).toBe(false);
    expect(affected(["requests", "mine", "me"])).toBe(false);
  });
});

describe("invalidateWeekData", () => {
  it("also refreshes the server merge verdicts, which are not week-keyed (REQ item 108 M1)", async () => {
    const client = new QueryClient();
    const key = sadranKeys.mergePreview("ride-1", "req-1", "out");
    client.setQueryData(key, { ok: true });
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    await invalidateWeekData(client, DEPT, WEEK);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });
});
