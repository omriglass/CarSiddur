import { describe, expect, it } from "vitest";

import { groupTasksByCar, taskInWindow, visibleTasks } from "./window";

const T0 = Date.parse("2026-11-01T07:00:00Z");
const MIN = 60_000;
const ride = (id: string, startMin: number, endMin: number) => ({
  ride_id: id,
  ride_starts_at: new Date(T0 + startMin * MIN).toISOString(),
  ride_ends_at: new Date(T0 + endMin * MIN).toISOString(),
});

describe("taskInWindow", () => {
  const r = ride("r1", 0, 300); // 07:00-12:00
  it("opens 15 minutes before the start and closes 15 minutes after the end", () => {
    expect(taskInWindow(r, T0 - 16 * MIN)).toBe(false);
    expect(taskInWindow(r, T0 - 15 * MIN)).toBe(true);
    expect(taskInWindow(r, T0 + 150 * MIN)).toBe(true);
    expect(taskInWindow(r, T0 + 315 * MIN)).toBe(true);
    expect(taskInWindow(r, T0 + 316 * MIN)).toBe(false);
  });
});

describe("visibleTasks", () => {
  const a = { task_id: "t1", car_id: "c1", ...ride("r1", 0, 60) };
  const b = { task_id: "t1", car_id: "c1", ...ride("r2", 70, 120) }; // overlapping windows of the same task
  it("shows a task once on /my even when two rides' windows contain now", () => {
    expect(visibleTasks([a, b], T0 + 62 * MIN)).toEqual([a]);
  });
  it("filters to one ride on the ride sheet", () => {
    expect(visibleTasks([a, b], T0 + 62 * MIN, "r2")).toEqual([b]);
    expect(visibleTasks([a, b], T0 + 62 * MIN, "r1")).toEqual([a]);
  });
  it("drops a task whose window has passed", () => {
    expect(visibleTasks([a], T0 + 80 * MIN)).toEqual([]);
  });
});

describe("groupTasksByCar", () => {
  it("groups by car in order", () => {
    const groups = groupTasksByCar([{ car_id: "c1" }, { car_id: "c2" }, { car_id: "c1" }]);
    expect(groups).toEqual([[{ car_id: "c1" }, { car_id: "c1" }], [{ car_id: "c2" }]]);
  });
});
