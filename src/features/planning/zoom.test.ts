import { describe, expect, it } from "vitest";

import { PLANNING_ZOOM_MAX, PLANNING_ZOOM_MIN, planningPinchZoom, planningZoomIn, planningZoomOut } from "./zoom";

describe("planning/zoom", () => {
  it("buttons step by 25% within 100%..250%", () => {
    expect(planningZoomIn(1)).toBe(1.25);
    expect(planningZoomOut(1)).toBe(PLANNING_ZOOM_MIN);
    expect(planningZoomIn(2.5)).toBe(PLANNING_ZOOM_MAX);
  });

  it("a pinch scales from its start and is clamped", () => {
    expect(planningPinchZoom(1, 100, 150)).toBe(1.5);
    expect(planningPinchZoom(2, 100, 400)).toBe(PLANNING_ZOOM_MAX);
    expect(planningPinchZoom(1.5, 100, 10)).toBe(PLANNING_ZOOM_MIN);
    expect(planningPinchZoom(1.3, 0, 50)).toBe(1.3);
  });
});
