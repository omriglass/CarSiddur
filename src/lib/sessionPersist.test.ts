import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StorageLike } from "./catalogPersist";
import {
  hydrateSession, initSessionPersistence, isPlainJson, isSessionSaved, resetSessionPersistenceForTests, SESSION_MAX_AGE_MS,
  SESSION_STORAGE_KEY, setSessionOwner, snapshotSession,
} from "./sessionPersist";

const MY_REQUESTS = ["requests", "mine", "me", "dept-1"] as const;
const SIDDUR_RIDES = ["siddur", "boardRides", "dept-1", "2026-11-15"] as const;
const BOARD = ["sadran", "dept-1", "2026-11-15", "boardRides"] as const;
const CARS = ["fleet", "cars", "dept-1"] as const;

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

afterEach(() => {
  resetSessionPersistenceForTests();
  vi.useRealTimers();
});

describe("session persistence (owner 2026-11-17: reopening shows what was already read)", () => {
  it("saves the member screens' data - not the Sadran's board, not the catalogs (catalogPersist keeps those)", () => {
    expect(isSessionSaved(MY_REQUESTS)).toBe(true);
    expect(isSessionSaved(SIDDUR_RIDES)).toBe(true);
    expect(isSessionSaved(BOARD)).toBe(false);
    expect(isSessionSaved(CARS)).toBe(false);
  });

  it("only data that survives JSON", () => {
    expect(isPlainJson([{ a: 1, b: null, c: ["x"] }])).toBe(true);
    expect(isPlainJson(new Map())).toBe(false);
    expect(isPlainJson({ at: new Date() })).toBe(false);
    const client = new QueryClient();
    client.setQueryData(MY_REQUESTS, [{ id: "q1" }]);
    client.setQueryData(SIDDUR_RIDES, new Map([["r1", 1]]));
    expect(snapshotSession(client, "me", "v1").entries.map((e) => e.key)).toEqual([MY_REQUESTS]);
  });

  it("puts the copy back out of date (screens re-read at once), skips old entries and never overwrites live data", () => {
    const client = new QueryClient();
    const now = 1_000_000_000_000;
    client.setQueryData(SIDDUR_RIDES, [{ id: "live" }]);
    const restored = hydrateSession(client, { owner: "me", version: "v1", entries: [
      { key: MY_REQUESTS, data: [{ id: "q1" }], at: now - 60_000 },
      { key: SIDDUR_RIDES, data: [{ id: "saved" }], at: now - 60_000 },
      { key: ["inbox", "list"], data: [], at: now - SESSION_MAX_AGE_MS - 1 },
    ] }, now);
    expect(client.getQueryData(MY_REQUESTS)).toEqual([{ id: "q1" }]);
    expect(client.getQueryState(MY_REQUESTS)?.isInvalidated || client.getQueryState(MY_REQUESTS)!.dataUpdatedAt < now - SESSION_MAX_AGE_MS).toBe(true);
    expect(client.getQueryData(SIDDUR_RIDES)).toEqual([{ id: "live" }]);
    expect(client.getQueryData(["inbox", "list"])).toBeUndefined();
    expect([...restored.values()]).toEqual([now - 60_000]);
  });

  it("another member or app version gets nothing; signing out wipes the copy", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ owner: "other", version: "v1", entries: [{ key: MY_REQUESTS, data: [1], at: Date.now() }] }));
    const client = new QueryClient();
    initSessionPersistence(client, "v1", storage);
    setSessionOwner("me");
    expect(client.getQueryData(MY_REQUESTS)).toBeUndefined();
    setSessionOwner(null);
    expect(storage.map.has(SESSION_STORAGE_KEY)).toBe(false);
  });
});
