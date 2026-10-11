import { describe, expect, it } from "vitest";

import { assignLanes, type LaneInput } from "./assignLanes";

const item = (id: string, startMinutes: number, endMinutes: number, carId = "d1"): LaneInput => ({ id, carId, startMinutes, endMinutes });

describe("assignLanes", () => {
  it("gives a lone item one full-width lane", () => {
    expect(assignLanes([item("a", 600, 660)]).get("a")).toEqual({ lane: 0, laneCount: 1 });
  });

  it("puts two overlapping items side by side", () => {
    const lanes = assignLanes([item("a", 600, 720), item("b", 660, 780)]);
    expect(lanes.get("a")).toEqual({ lane: 0, laneCount: 2 });
    expect(lanes.get("b")).toEqual({ lane: 1, laneCount: 2 });
  });

  it("does not treat touching items as overlapping", () => {
    const lanes = assignLanes([item("a", 600, 660), item("b", 660, 720)]);
    expect(lanes.get("a")).toEqual({ lane: 0, laneCount: 1 });
    expect(lanes.get("b")).toEqual({ lane: 0, laneCount: 1 });
  });

  it("reuses a freed lane inside one cluster and gives the whole cluster the same count", () => {
    // a 600-900 overlaps b 610-660 and c 700-800 (b and c do not overlap each other): two lanes for all three.
    const lanes = assignLanes([item("a", 600, 900), item("b", 610, 660), item("c", 700, 800)]);
    expect(lanes.get("a")).toEqual({ lane: 0, laneCount: 2 });
    expect(lanes.get("b")).toEqual({ lane: 1, laneCount: 2 });
    expect(lanes.get("c")).toEqual({ lane: 1, laneCount: 2 });
  });

  it("clusters independently: a later separate cluster is not narrowed by an earlier one", () => {
    const lanes = assignLanes([item("a", 600, 700), item("b", 620, 700), item("c", 800, 860)]);
    expect(lanes.get("a")?.laneCount).toBe(2);
    expect(lanes.get("c")).toEqual({ lane: 0, laneCount: 1 });
  });

  it("chains overlaps transitively into one cluster", () => {
    const lanes = assignLanes([item("a", 600, 700), item("b", 650, 750), item("c", 720, 800)]);
    // a-b overlap, b-c overlap, a-c do not: c reuses lane 0, cluster has 2 lanes.
    expect(lanes.get("a")).toEqual({ lane: 0, laneCount: 2 });
    expect(lanes.get("b")).toEqual({ lane: 1, laneCount: 2 });
    expect(lanes.get("c")).toEqual({ lane: 0, laneCount: 2 });
  });

  it("never mixes columns", () => {
    const lanes = assignLanes([item("a", 600, 700, "d1"), item("b", 600, 700, "d2")]);
    expect(lanes.get("a")).toEqual({ lane: 0, laneCount: 1 });
    expect(lanes.get("b")).toEqual({ lane: 0, laneCount: 1 });
  });

  it("counts a very short item as the minimum drawn height", () => {
    // a ends at 615 but is drawn ~30 minutes tall, so b at 620 would sit on it.
    const lanes = assignLanes([item("a", 600, 615), item("b", 620, 700)]);
    expect(lanes.get("b")).toEqual({ lane: 1, laneCount: 2 });
  });

  it("is deterministic: input order does not matter, equal intervals fall back to the id", () => {
    const a = item("a", 600, 700);
    const b = item("b", 600, 700);
    const c = item("c", 600, 700);
    const first = assignLanes([c, a, b]);
    const second = assignLanes([a, b, c]);
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    expect(first.get("a")?.lane).toBe(0);
    expect(first.get("b")?.lane).toBe(1);
    expect(first.get("c")?.lane).toBe(2);
  });

  it("puts the longer of two items with the same start first", () => {
    const lanes = assignLanes([item("a", 600, 660), item("z", 600, 900)]);
    expect(lanes.get("z")?.lane).toBe(0);
    expect(lanes.get("a")?.lane).toBe(1);
  });
});
