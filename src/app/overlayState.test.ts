import { describe, expect, it } from "vitest";

import { overlayBackgroundPath, overlayTargetPath, readOverlayFrom } from "./overlayState";

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

describe("request overlay target", () => {
  const target = { departmentId: "d1", weekStart: "2026-11-08", day: "2026-11-11", weekOnSiddur: true };
  it("opens the siddur on the request's week and day", () => {
    expect(overlayTargetPath("/siddur", target)).toBe("/siddur/d1/2026-11-08?day=2026-11-11");
    expect(overlayTargetPath("/siddur/d1/2026-11-01", target)).toBe("/siddur/d1/2026-11-08?day=2026-11-11");
  });
  it("opens the /my week view on the request's week", () => {
    expect(overlayTargetPath("/my?view=week&week=2026-11-01", target)).toBe("/my?view=week&week=2026-11-08");
  });
  it("leaves pages without a day as they were", () => {
    expect(overlayTargetPath("/my", target)).toBeUndefined();
    expect(overlayTargetPath("/siddur/d1/archive", target)).toBeUndefined();
    // An open week is only a "not published yet" note on the siddur: stay on the week shown.
    expect(overlayTargetPath("/siddur/d1/2026-11-01", { ...target, weekOnSiddur: false })).toBeUndefined();
  });
});
