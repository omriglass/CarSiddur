import { describe, expect, it } from "vitest";

import { clampAim, FILL_SECONDS, FUNNEL, hitsFunnel, landingY, GROUND_Y, MAX_AIM, MIN_AIM, nextFill, START_AIM, streamPath, wobble } from "./ureaStream";

describe("urea stream (FU2)", () => {
  it("starts off the funnel", () => {
    expect(hitsFunnel(START_AIM)).toBe(false);
    expect(hitsFunnel(START_AIM + wobble(0))).toBe(false);
  });

  it("hits only inside the funnel rim", () => {
    const middle = (FUNNEL.left + FUNNEL.right) / 2;
    expect(hitsFunnel(middle)).toBe(true);
    expect(hitsFunnel(FUNNEL.left - 1)).toBe(false);
    expect(hitsFunnel(FUNNEL.right + 1)).toBe(false);
    expect(landingY(middle)).toBe(FUNNEL.y);
    expect(landingY(FUNNEL.left - 20)).toBe(GROUND_Y);
  });

  it("a centred aim stays in despite the wobble", () => {
    const middle = (FUNNEL.left + FUNNEL.right) / 2;
    for (let t = 0; t < 20; t += 0.05) expect(hitsFunnel(middle + wobble(t))).toBe(true);
    expect(wobble(3, false)).toBe(0);
  });

  it("fills only while in the funnel, and stops at full", () => {
    const middle = (FUNNEL.left + FUNNEL.right) / 2;
    expect(nextFill(0, START_AIM, 1)).toBe(0);
    expect(nextFill(0, middle, FILL_SECONDS / 2)).toBeCloseTo(0.5);
    expect(nextFill(0.9, middle, 5)).toBe(1);
  });

  it("clamps the aim and draws a path ending where it lands", () => {
    expect(clampAim(0)).toBe(MIN_AIM);
    expect(clampAim(999)).toBe(MAX_AIM);
    expect(streamPath(230)).toMatch(/ 230\.0 74$/);
    expect(streamPath(150)).toMatch(new RegExp(` 150\\.0 ${GROUND_Y}$`));
  });
});
