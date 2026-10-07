import { describe, expect, it } from "vitest";

import { isHiddenOutcome, isPartiallyPlaced, isRequestDayPublished, legCoverage, ownTimesFromLegs } from "./publishedOutcome";

const win = (phase: "open" | "published" | "live" | "archived", days: string[]) => ({
  phase, open_at: "2026-10-01T00:00:00Z", close_at: "2026-10-09T00:00:00Z", published_days: days,
});

describe("isRequestDayPublished (REQ 109 a, mirrors is_day_public)", () => {
  it("needs a published phase and the day in published_days", () => {
    expect(isRequestDayPublished(win("published", ["2026-10-08"]), "2026-10-08T09:00:00+03:00", null)).toBe(true);
    expect(isRequestDayPublished(win("published", ["2026-10-09"]), "2026-10-08T09:00:00+03:00", null)).toBe(false);
    expect(isRequestDayPublished(win("open", ["2026-10-08"]), "2026-10-08T09:00:00+03:00", null)).toBe(false);
    expect(isRequestDayPublished(null, "2026-10-08T09:00:00+03:00", null)).toBe(false);
  });
  it("uses the Jerusalem day", () => {
    expect(isRequestDayPublished(win("live", ["2026-10-08"]), "2026-10-07T21:30:00Z", null)).toBe(true);
  });
});

describe("isHiddenOutcome", () => {
  it("hides planning outcomes before publication only", () => {
    expect(isHiddenOutcome("assigned", false)).toBe(true);
    expect(isHiddenOutcome("waitlisted", false)).toBe(true);
    expect(isHiddenOutcome("assigned", true)).toBe(false);
    expect(isHiddenOutcome("submitted", false)).toBe(false);
    expect(isHiddenOutcome("proposed", false)).toBe(false);
  });
});

describe("leg coverage", () => {
  const out = { leg: "out" as const, startsAt: "a", endsAt: "b" };
  it("flags one placed leg of a two-leg request", () => {
    expect(isPartiallyPlaced(legCoverage([out], true, true))).toBe(true);
    expect(isPartiallyPlaced(legCoverage([{ ...out, leg: "both" }], true, true))).toBe(false);
    expect(legCoverage([out], true, false)).toBeNull();
  });
  it("takes own times from the ride carrying each leg", () => {
    expect(ownTimesFromLegs([
      { leg: "out", startsAt: "s1", endsAt: "e1" },
      { leg: "return", startsAt: "s2", endsAt: "e2" },
    ])).toEqual({ departAt: "s1", returnAt: "e2" });
  });
});
