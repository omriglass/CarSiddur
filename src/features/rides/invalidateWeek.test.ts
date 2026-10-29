import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sadranKeys } from "@/features/sadran/keys";

import { siddurKeys } from "@/features/siddur/queryKeys";

import * as api from "./api";
import { invalidateWeekData, isMergePreviewTouched, isSiddurQueryAffectedByWeek, mergePreviewScope, patchRides } from "./invalidateWeek";

import type { BoardRide } from "./api";
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

/** A list on screen: an observer that never fetches by itself. */
const watch = (client: QueryClient, queryKey: readonly unknown[]) =>
  new QueryObserver(client, { queryKey, queryFn: () => [] as BoardRide[], enabled: false }).subscribe(() => {});

const ride = (id: string, startsAt: string, notes: string | null = null) => ({ id, starts_at: startsAt, notes }) as BoardRide;

describe("patchRides (O28-8)", () => {
  const a = ride("a", "2026-09-27T06:00:00Z");
  const c = ride("c", "2026-09-27T08:00:00Z");
  const old = [a, ride("b", "2026-09-27T07:00:00Z"), c];

  it("replaces a changed ride in place and keeps every other ride", () => {
    const next = patchRides(old, ["b"], [ride("b", "2026-09-27T07:00:00Z", "new")]);
    expect(next.map((r) => [r.id, r.notes])).toEqual([["a", null], ["b", "new"], ["c", null]]);
  });

  it("drops an asked-for ride the server no longer returns (cancelled) and adds a new one in time order", () => {
    const next = patchRides(old, ["c", "n"], [ride("n", "2026-09-27T06:30:00Z")]);
    expect(next.map((r) => r.id)).toEqual(["a", "n", "b"]);
  });

  it("re-sorts a moved ride when the list was in time order, and leaves an unordered list's order alone", () => {
    expect(patchRides(old, ["a"], [ride("a", "2026-09-27T09:00:00Z")]).map((r) => r.id)).toEqual(["b", "c", "a"]);
    const unordered = [c, a];
    expect(patchRides(unordered, ["a"], [ride("a", "2026-09-27T09:00:00Z")]).map((r) => r.id)).toEqual(["c", "a"]);
  });
});

describe("invalidateWeekData skips what a change in the week does not move (O28-8, perf 2026-10-29)", () => {
  it("leaves fairness, car start places, mileage and place travel alone and refreshes the rest of the week", async () => {
    const client = new QueryClient();
    const kept = [
      sadranKeys.fairnessStats(DEPT, WEEK, 3),
      sadranKeys.carStartLocations(DEPT, WEEK),
      sadranKeys.mileageTotals(DEPT, WEEK),
      sadranKeys.placeTravel(DEPT, WEEK, "3:abc"),
    ];
    const proposals = sadranKeys.proposals(DEPT, WEEK);
    for (const key of [...kept, proposals]) client.setQueryData(key, {});
    await invalidateWeekData(client, DEPT, WEEK);
    for (const key of kept) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(client.getQueryState(proposals)?.isInvalidated).toBe(true);
  });
});

describe("invalidateWeekData with ride ids (O28-8)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("patches the changed ride into the week ride lists on screen; one nobody watches stays invalidated", async () => {
    const client = new QueryClient();
    const boardKey = sadranKeys.boardRides(DEPT, WEEK);
    const siddurKey = siddurKeys.boardRides(DEPT, WEEK);
    client.setQueryData(boardKey, [ride("a", "2026-09-27T06:00:00Z")]);
    client.setQueryData(siddurKey, [ride("a", "2026-09-27T06:00:00Z")]);
    watch(client, boardKey);
    const fetch = vi.spyOn(api, "fetchWeekRidesSubset").mockResolvedValue([ride("a", "2026-09-27T06:00:00Z", "patched")]);
    await invalidateWeekData(client, DEPT, WEEK, ["a", null]);
    expect(fetch).toHaveBeenCalledWith(DEPT, WEEK, ["a"]);
    expect(client.getQueryData<BoardRide[]>(boardKey)?.[0]?.notes).toBe("patched");
    expect(client.getQueryData<BoardRide[]>(siddurKey)?.[0]?.notes).toBeNull();
    expect(client.getQueryState(siddurKey)?.isInvalidated).toBe(true);
  });

  it("never overwrites a full read that landed while the subset was on its way", async () => {
    const client = new QueryClient();
    const boardKey = sadranKeys.boardRides(DEPT, WEEK);
    client.setQueryData(boardKey, [ride("a", "2026-09-27T06:00:00Z")]);
    watch(client, boardKey);
    vi.spyOn(api, "fetchWeekRidesSubset").mockImplementation(async () => {
      client.setQueryData(boardKey, [ride("a", "2026-09-27T06:00:00Z", "full")], { updatedAt: Date.now() + 1000 });
      return [ride("a", "2026-09-27T06:00:00Z", "older")];
    });
    await invalidateWeekData(client, DEPT, WEEK, ["a"]);
    expect(client.getQueryData<BoardRide[]>(boardKey)?.[0]?.notes).toBe("full");
  });

  it("does not fetch when no week ride list is on screen", async () => {
    const fetch = vi.spyOn(api, "fetchWeekRidesSubset");
    await invalidateWeekData(new QueryClient(), DEPT, WEEK, ["a"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("merge previews after a change to known rides (perf 2026-10-29)", () => {
  const ride = (id: string, car: string, requests: string[] = []) =>
    ({ id, car_id: car, served: requests.map((request_id) => ({ request_id, role: "passenger", leg: "both" })) }) as unknown as BoardRide;
  const cached = new Map([ride("r1", "carA", ["q1"]), ride("r2", "carA"), ride("r3", "carB"), ride("r4", "carC")].map((r) => [r.id as string, r]));
  const preview = (rideId: string, requestId: string) => sadranKeys.mergePreview(rideId, requestId, "both");

  it("reloads the changed ride's previews, its car's (old and new) and its requests'; leaves the rest", () => {
    // r1 moved from carA to carB.
    const after = new Map(cached);
    after.set("r1", ride("r1", "carB", ["q1"]));
    const scope = mergePreviewScope(["r1"], cached, [after.get("r1") as BoardRide], after);
    expect(isMergePreviewTouched(preview("r1", "q9"), scope)).toBe(true);
    expect(isMergePreviewTouched(preview("r2", "q9"), scope)).toBe(true); // old car
    expect(isMergePreviewTouched(preview("r3", "q9"), scope)).toBe(true); // new car
    expect(isMergePreviewTouched(preview("r4", "q1"), scope)).toBe(true); // the moved ride's request
    expect(isMergePreviewTouched(preview("r4", "q9"), scope)).toBe(false);
  });

  it("reloads a preview whose host ride the cache does not know", () => {
    const scope = mergePreviewScope(["r1"], cached, [], cached);
    expect(isMergePreviewTouched(preview("unknown", "q9"), scope)).toBe(true);
  });
});
