import { describe, expect, it, vi } from "vitest";

import { createWeekPartsBatcher, type WeekPartAnswer } from "./weekPartsBatcher";

function setup(answer: (parts: string[]) => Record<string, WeekPartAnswer | undefined> | Promise<never>) {
  const timers: (() => void)[] = [];
  const fetch = vi.fn(async (_dept: string, _week: string, parts: string[]) => answer(parts));
  const batcher = createWeekPartsBatcher({ fetch, setTimer: (fn) => timers.push(fn) });
  const tick = () => timers.splice(0).forEach((fn) => fn());
  return { batcher, fetch, tick };
}

describe("createWeekPartsBatcher", () => {
  it("sends the reads that start together as one call and hands each its part", async () => {
    const { batcher, fetch, tick } = setup((parts) => Object.fromEntries(parts.map((p) => [p, { data: [p] }])));
    const rides = batcher.read("d", "w", "rides");
    const requests = batcher.read("d", "w", "requests");
    const ridesAgain = batcher.read("d", "w", "rides");
    expect(fetch).not.toHaveBeenCalled();
    tick();
    expect(await rides).toEqual(["rides"]);
    expect(await requests).toEqual(["requests"]);
    expect(await ridesAgain).toEqual(["rides"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("d", "w", ["rides", "requests"]);
  });

  it("keeps department-weeks apart", async () => {
    const { batcher, fetch, tick } = setup((parts) => Object.fromEntries(parts.map((p) => [p, { data: [] }])));
    const a = batcher.read("d", "w1", "rides");
    const b = batcher.read("d", "w2", "rides");
    tick();
    await Promise.all([a, b]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never joins a call already on its way: a later read gets a later call", async () => {
    let release: (() => void) | undefined;
    const timers: (() => void)[] = [];
    const fetch = vi.fn(async (_d: string, _w: string, parts: string[]) => {
      if (fetch.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      return Object.fromEntries(parts.map((p) => [p, { data: fetch.mock.calls.length }]));
    });
    const batcher = createWeekPartsBatcher({ fetch, setTimer: (fn) => timers.push(fn) });
    const first = batcher.read("d", "w", "rides");
    timers.splice(0).forEach((fn) => fn());           // first call is now in flight
    const second = batcher.read("d", "w", "rides");   // e.g. the refresh after a change
    timers.splice(0).forEach((fn) => fn());
    expect(fetch).toHaveBeenCalledTimes(2);
    release?.();
    await Promise.all([first, second]);
  });

  it("fails one part alone, the others still answer", async () => {
    const { batcher, tick } = setup(() => ({ rides: { data: [1] }, waitlistHolds: { error: { code: "42501", message: "not_authorized" } } }));
    const rides = batcher.read("d", "w", "rides");
    const holds = batcher.read("d", "w", "waitlistHolds");
    tick();
    expect(await rides).toEqual([1]);
    await expect(holds).rejects.toEqual({ code: "42501", message: "not_authorized" });
  });

  it("a part with no rows of a single-row read resolves null; a missing part rejects", async () => {
    const { batcher, tick } = setup(() => ({ week: {} }));
    const week = batcher.read("d", "w", "week");
    const rides = batcher.read("d", "w", "rides");
    tick();
    expect(await week).toBeNull();
    await expect(rides).rejects.toMatchObject({ code: "week_part_missing" });
  });

  it("a failed call fails every read in it", async () => {
    const { batcher, tick } = setup(() => Promise.reject(new TypeError("Failed to fetch")));
    const rides = batcher.read("d", "w", "rides");
    const requests = batcher.read("d", "w", "requests");
    tick();
    await expect(rides).rejects.toBeInstanceOf(TypeError);
    await expect(requests).rejects.toBeInstanceOf(TypeError);
  });
});
