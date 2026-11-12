import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hydrate, initCatalogPersistence, readSaved, resetCatalogPersistenceForTests, REVALIDATE_AFTER_MS, setCatalogOwner, snapshot, STORAGE_KEY, type StorageLike } from "./catalogPersist";
import { CATALOG_STALE_MS } from "./queryPolicy";

const CARS = ["fleet", "cars", "dept-1"] as const;
const RIDES = ["sadran", "dept-1", "2026-11-08", "boardRides"] as const;

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

afterEach(() => {
  resetCatalogPersistenceForTests();
  vi.useRealTimers();
});

describe("catalog persistence (PF1)", () => {
  it("saves catalog queries only - never rides", () => {
    const client = new QueryClient();
    client.setQueryData(CARS, [{ id: "c1" }]);
    client.setQueryData(RIDES, [{ id: "r1" }]);
    expect(snapshot(client, "me", "v1").entries.map((e) => e.key)).toEqual([CARS]);
  });

  it("uses a recent copy as is and marks an older one for a re-read", () => {
    const client = new QueryClient();
    const now = 1_000_000_000;
    const overdue = hydrate(client, { owner: "me", version: "v1", entries: [
      { key: CARS, data: [{ id: "c1" }], at: now - 60_000 },
      { key: ["fleet", "destinations"], data: [{ id: "d1" }], at: now - CATALOG_STALE_MS - 1 },
      { key: ["fleet", "rideTypes"], data: [{ id: "t1" }], at: now - 8 * 24 * 60 * 60_000 },
      { key: RIDES, data: [{ id: "r1" }], at: now },
    ] }, now);
    expect(client.getQueryData(CARS)).toEqual([{ id: "c1" }]);
    expect(client.getQueryState(CARS)?.dataUpdatedAt).toBe(now - 60_000);
    expect(overdue).toEqual([["fleet", "destinations"]]);
    expect(client.getQueryData(["fleet", "rideTypes"])).toBeUndefined(); // too old
    expect(client.getQueryData(RIDES)).toBeUndefined(); // not a catalog
  });

  it("never overwrites a value the app already loaded", () => {
    const client = new QueryClient();
    client.setQueryData(CARS, [{ id: "live" }]);
    hydrate(client, { owner: "me", version: "v1", entries: [{ key: CARS, data: [{ id: "saved" }], at: Date.now() }] }, Date.now());
    expect(client.getQueryData(CARS)).toEqual([{ id: "live" }]);
  });

  it("discards another member's copy, another version's, and a broken one", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ owner: "me", version: "v1", entries: [] }));
    expect(readSaved(storage, "me", "v1")).not.toBeNull();
    expect(readSaved(storage, "someone-else", "v1")).toBeNull();
    expect(readSaved(storage, "me", "v2")).toBeNull();
    storage.setItem(STORAGE_KEY, "{not json");
    expect(readSaved(storage, "me", "v1")).toBeNull();
  });

  it("round trip: saved after a load, restored for the same member, re-read after the screen settles when old, cleared on sign-out", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const first = new QueryClient();
    initCatalogPersistence(first, "v1", storage);
    setCatalogOwner("me");
    await first.fetchQuery({ queryKey: CARS, queryFn: () => [{ id: "c1" }] });
    await first.fetchQuery({ queryKey: RIDES, queryFn: () => [{ id: "r1" }] });
    vi.advanceTimersByTime(2_500);
    expect(JSON.parse(storage.map.get(STORAGE_KEY) ?? "{}").entries).toHaveLength(1);

    // A reload 20 minutes later: shown at once, re-read only after the screen's own calls.
    resetCatalogPersistenceForTests();
    vi.advanceTimersByTime(20 * 60_000);
    const second = new QueryClient();
    initCatalogPersistence(second, "v1", storage);
    setCatalogOwner("me");
    expect(second.getQueryData(CARS)).toEqual([{ id: "c1" }]);
    expect(second.getQueryState(CARS)?.isInvalidated).toBe(false);
    vi.advanceTimersByTime(REVALIDATE_AFTER_MS + 1);
    expect(second.getQueryState(CARS)?.isInvalidated).toBe(true);

    setCatalogOwner(null);
    expect(storage.map.has(STORAGE_KEY)).toBe(false);
  });

  it("gives another member nothing", () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ owner: "me", version: "v1", entries: [{ key: CARS, data: [{ id: "c1" }], at: Date.now() }] }));
    const client = new QueryClient();
    initCatalogPersistence(client, "v1", storage);
    setCatalogOwner("someone-else");
    expect(client.getQueryData(CARS)).toBeUndefined();
  });
});
