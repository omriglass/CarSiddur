import { describe, expect, it } from "vitest";

import { activeStopCount, buildRouteLine } from "./routeLine";

const base = { origin: "A", destination: "D", outStops: ["S1", "S2"], returnStops: ["R1"] };

describe("buildRouteLine", () => {
  it("lists origin, out stops in order, destination", () => {
    const line = buildRouteLine({ ...base, hasReturn: false });
    expect(line.out.map((h) => h.label)).toEqual(["A", "S1", "S2", "D"]);
    expect(line.back).toBeNull();
  });

  it("adds the return part destination -> return stops -> origin when there is a return", () => {
    const line = buildRouteLine({ ...base, hasReturn: true });
    expect(line.back?.map((h) => h.label)).toEqual(["D", "R1", "A"]);
  });

  it("tags only stop hops with leg and index", () => {
    const line = buildRouteLine({ ...base, hasReturn: true });
    expect(line.out.map((h) => h.stop)).toEqual([undefined, { leg: "out", index: 0 }, { leg: "out", index: 1 }, undefined]);
    expect(line.back?.[1]?.stop).toEqual({ leg: "return", index: 0 });
  });
});

describe("activeStopCount", () => {
  it("ignores hidden return stops without a return leg", () => {
    expect(activeStopCount({ ...base, hasReturn: false })).toBe(2);
    expect(activeStopCount({ ...base, hasReturn: true })).toBe(3);
  });
});
