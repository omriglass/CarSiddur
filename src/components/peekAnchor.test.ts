import { describe, expect, it } from "vitest";

import { PEEK_STRIP_PX, peekAnchorBox } from "./peekAnchor";

describe("peekAnchorBox (the ride summary popup stays on screen)", () => {
  it("keeps a short block as it is", () => {
    expect(peekAnchorBox({ top: 200, bottom: 260 }, 900)).toEqual({ top: 200, bottom: 260 });
  });
  it("a full-day block becomes a strip at its visible top, so the popup opens below it", () => {
    expect(peekAnchorBox({ top: 60, bottom: 1600 }, 900)).toEqual({ top: 60, bottom: 60 + PEEK_STRIP_PX });
  });
  it("a block scrolled partly above the screen is measured from the screen's top", () => {
    expect(peekAnchorBox({ top: -400, bottom: 100 }, 900)).toEqual({ top: 0, bottom: 100 });
  });
});
