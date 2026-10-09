import { describe, expect, it } from "vitest";

import { dirtySpots, distanceToSegment, rubSpots, WASH_H, WASH_RUB_DISTANCE, WASH_SPOTS, WASH_W } from "./washSpots";

describe("washSpots", () => {
  it("every spot lies inside the drawing", () => {
    for (const spot of WASH_SPOTS) {
      expect(spot.x - spot.r).toBeGreaterThanOrEqual(0);
      expect(spot.x + spot.r).toBeLessThanOrEqual(WASH_W);
      expect(spot.y + spot.r).toBeLessThanOrEqual(WASH_H);
    }
  });

  it("distanceToSegment handles points beside, past and on a degenerate segment", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it("rubbing cleans only the spots the stroke passes over, in proportion to its length", () => {
    const spots = [{ x: 50, y: 50, r: 10 }, { x: 200, y: 50, r: 10 }];
    const half = WASH_RUB_DISTANCE / 2;
    const once = rubSpots([1, 1], spots, { x: 50 - half / 2, y: 50 }, { x: 50 + half / 2, y: 50 });
    expect(once[0]).toBeCloseTo(0.5);
    expect(once[1]).toBe(1);
    const twice = rubSpots(once, spots, { x: 50 + half / 2, y: 50 }, { x: 50 - half / 2, y: 50 });
    expect(twice[0]).toBe(0);
    expect(dirtySpots(twice)).toBe(1);
  });

  it("a fast stroke across a spot counts (segment, not end points) but only for the spot's width", () => {
    const spots = [{ x: 100, y: 50, r: 10 }];
    const after = rubSpots([1], spots, { x: 0, y: 50 }, { x: 200, y: 50 })[0] ?? 1;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(1);
  });
});
