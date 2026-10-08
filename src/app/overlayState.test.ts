import { describe, expect, it } from "vitest";

import { overlayBackgroundPath, readOverlayFrom } from "./overlayState";

describe("request overlay background", () => {
  it("reads a main-page `from` hint", () => {
    expect(readOverlayFrom({ from: "/my" })).toBe("/my");
    expect(readOverlayFrom({ from: "/siddur/d1/2027-01-10?x=1" })).toBe("/siddur/d1/2027-01-10?x=1");
  });
  it("ignores missing, foreign or request-route hints", () => {
    expect(readOverlayFrom(null)).toBeUndefined();
    expect(readOverlayFrom({ from: 5 })).toBeUndefined();
    expect(readOverlayFrom({ from: "https://x.example" })).toBeUndefined();
    expect(readOverlayFrom({ from: "/requests/new" })).toBeUndefined();
  });
  it("falls back to the landing page", () => {
    expect(["/my", "/siddur"]).toContain(overlayBackgroundPath(undefined));
    expect(overlayBackgroundPath({ from: "/my" })).toBe("/my");
  });
});
