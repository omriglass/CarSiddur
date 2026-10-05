import { describe, expect, it } from "vitest";
import { AUTO_SCROLL_MAX_STEP_PX, edgeScrollStep } from "./dragAutoScroll";

describe("edgeScrollStep", () => {
  it("does nothing in the middle", () => expect(edgeScrollStep(500, 0, 1000)).toBe(0));
  it("scrolls towards the start near the start edge", () => expect(edgeScrollStep(5, 0, 1000)).toBeLessThan(0));
  it("scrolls towards the end near the end edge and caps the speed", () => {
    expect(edgeScrollStep(995, 0, 1000)).toBeGreaterThan(0);
    expect(edgeScrollStep(5000, 0, 1000)).toBe(AUTO_SCROLL_MAX_STEP_PX);
  });
  it("ignores tiny scrollers", () => expect(edgeScrollStep(5, 0, 50)).toBe(0));
});
