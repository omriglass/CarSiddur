import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusManager, QueryObserver, type QueryClient } from "@tanstack/react-query";

import { requestsKeys } from "@/features/requests/queryKeys";
import { ridesKeys } from "@/features/rides/keys";
import { sadranKeys } from "@/features/sadran/keys";
import { siddurKeys } from "@/features/siddur/queryKeys";
import { waitlistKeys } from "@/features/waitlist/keys";

import { GATE_MAX_AGE_MS, isCounterGated, registerWatch, resetCounterGate } from "./counterGate";
import { createQueryClient, DEFAULT_STALE_MS } from "./queryPolicy";

const D = "dept-1";
const W = "2026-11-01";
const W2 = "2026-11-08";

function watch(scope: "public" | "sadran", options: { ready?: boolean; gate?: boolean; dept?: string; weeks?: string[] } = {}) {
  const handle = registerWatch({ departmentId: options.dept ?? D, weeks: options.weeks ?? [W], scope, gate: options.gate ?? true });
  if (options.ready ?? true) handle.markReady();
  return handle;
}

beforeEach(() => resetCounterGate());

describe("isCounterGated", () => {
  it("gates the member week reads of a watched week, and only that week", () => {
    watch("public");
    expect(isCounterGated(siddurKeys.boardRides(D, W))).toBe(true);
    expect(isCounterGated(ridesKeys.rideChanges("me", D, W))).toBe(true);
    expect(isCounterGated(waitlistKeys.groups(D, W))).toBe(true);
    expect(isCounterGated(siddurKeys.boardRides(D, W2))).toBe(false);
    expect(isCounterGated(siddurKeys.boardRides("dept-2", W))).toBe(false);
  });

  it("leaves every other family on today's behaviour", () => {
    watch("sadran");
    for (const key of [
      siddurKeys.myUpcomingRides("me", D),
      siddurKeys.carLocations(D, W),
      siddurKeys.carStartLocations(D, W),
      siddurKeys.weeks(D),
      siddurKeys.myChildrenRides(D, ["c"]),
      siddurKeys.boardRideById("r1"),
      ridesKeys.carNeighbours(["r1"]),
      ridesKeys.rideChanges("me", undefined, undefined, W), // the Inbox's unscoped block
      ridesKeys.rideChanges("me", D, W, W), // spans weeks
      [...requestsKeys.mine("me"), D],
      requestsKeys.freedOffers("me"),
      sadranKeys.fairnessStats(D, W, 3),
      sadranKeys.mileageTotals(D, W),
      sadranKeys.carStartLocations(D, W),
      sadranKeys.placeTravel(D, W),
      sadranKeys.carLocations(D, W),
      sadranKeys.weekRow(D, W),
      sadranKeys.solverRuns(D, W),
      sadranKeys.cars(D),
      sadranKeys.mergePreview("r", "q", "out"),
    ]) {
      expect(isCounterGated(key), key.join("/")).toBe(false);
    }
  });

  it("gates the board's week reads only under a Sadran-scope watch", () => {
    const sadranKeysGated = [
      sadranKeys.boardRides(D, W), sadranKeys.weekRequestsWithNames(D, W), sadranKeys.proposals(D, W),
      sadranKeys.heldNotices(D, W), sadranKeys.publicationReadiness(D, W), sadranKeys.freedOffers(D, W),
    ];
    const member = watch("public");
    for (const key of sadranKeysGated) expect(isCounterGated(key), key.join("/")).toBe(false);
    member.unregister();
    watch("sadran");
    for (const key of sadranKeysGated) expect(isCounterGated(key), key.join("/")).toBe(true);
  });

  it("is off with no watcher, before the first good check, after unmount, and when the viewer opts out", () => {
    expect(isCounterGated(siddurKeys.boardRides(D, W))).toBe(false);
    const notReady = watch("public", { ready: false });
    expect(isCounterGated(siddurKeys.boardRides(D, W))).toBe(false);
    notReady.markReady();
    expect(isCounterGated(siddurKeys.boardRides(D, W))).toBe(true);
    notReady.unregister();
    expect(isCounterGated(siddurKeys.boardRides(D, W))).toBe(false);
    watch("public", { gate: false });
    expect(isCounterGated(siddurKeys.boardRides(D, W))).toBe(false);
  });
});

describe("return to the tab (fake timers)", () => {
  let client: QueryClient;
  const unsubscribe: (() => void)[] = [];

  async function mount(key: readonly unknown[], fn: () => Promise<string>) {
    const observer = new QueryObserver(client, { queryKey: key, queryFn: fn });
    unsubscribe.push(observer.subscribe(() => undefined));
    await vi.advanceTimersByTimeAsync(0);
  }
  async function returnToTab() {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    client = createQueryClient();
    client.mount();
  });
  afterEach(() => {
    while (unsubscribe.length) unsubscribe.pop()?.();
    client.unmount();
    client.clear();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("a gated query older than 30 s is NOT refetched on return; an ungated one is", async () => {
    watch("public");
    const gated = vi.fn(async () => "rides");
    const ungated = vi.fn(async () => "locations");
    await mount(siddurKeys.boardRides(D, W), gated);
    await mount(siddurKeys.carLocations(D, W), ungated);
    await vi.advanceTimersByTimeAsync(DEFAULT_STALE_MS + 1000);
    await returnToTab();
    expect(gated).toHaveBeenCalledTimes(1);
    expect(ungated).toHaveBeenCalledTimes(2);
  });

  it("a counter move (lean invalidation) still refetches the gated query", async () => {
    watch("public");
    const gated = vi.fn(async () => "rides");
    await mount(siddurKeys.boardRides(D, W), gated);
    await vi.advanceTimersByTimeAsync(60_000);
    await returnToTab();
    expect(gated).toHaveBeenCalledTimes(1);
    await client.invalidateQueries({ queryKey: siddurKeys.boardRides(D, W) });
    expect(gated).toHaveBeenCalledTimes(2);
  });

  it("refetches on return once older than the 5-minute cap", async () => {
    watch("public");
    const gated = vi.fn(async () => "rides");
    await mount(siddurKeys.boardRides(D, W), gated);
    await vi.advanceTimersByTimeAsync(GATE_MAX_AGE_MS - 1000);
    await returnToTab();
    expect(gated).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await returnToTab();
    expect(gated).toHaveBeenCalledTimes(2);
  });

  it("behaves as before (refetch when stale) with no watcher for the week", async () => {
    watch("public", { dept: "dept-2" });
    const fn = vi.fn(async () => "rides");
    await mount(siddurKeys.boardRides(D, W), fn);
    await vi.advanceTimersByTimeAsync(DEFAULT_STALE_MS + 1000);
    await returnToTab();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a fresh (< 30 s) query is not refetched either way", async () => {
    const fn = vi.fn(async () => "locations");
    await mount(siddurKeys.carLocations(D, W), fn);
    await vi.advanceTimersByTimeAsync(5000);
    await returnToTab();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
