import { describe, expect, it } from "vitest";

import { hasRideTodayOrTomorrow, resolveHomeWeek, type WeekPhaseRow } from "./homeWeek";

const WEEKS: WeekPhaseRow[] = [
  { weekStart: "2026-09-06", phase: "live" },
  { weekStart: "2026-09-13", phase: "open" },
];

describe("resolveHomeWeek", () => {
  it("'live' preference picks the live week", () => {
    expect(resolveHomeWeek("live", WEEKS, false)?.weekStart).toBe("2026-09-06");
  });

  it("'open' preference picks the open week", () => {
    expect(resolveHomeWeek("open", WEEKS, false)?.weekStart).toBe("2026-09-13");
  });

  it("'auto' picks live when there's a ride today/tomorrow", () => {
    expect(resolveHomeWeek("auto", WEEKS, true)?.weekStart).toBe("2026-09-06");
  });

  it("'auto' picks open when there's no ride today/tomorrow", () => {
    expect(resolveHomeWeek("auto", WEEKS, false)?.weekStart).toBe("2026-09-13");
  });

  it("falls back to whichever week exists when the preferred phase is missing", () => {
    const onlyOpen: WeekPhaseRow[] = [{ weekStart: "2026-09-13", phase: "open" }];
    expect(resolveHomeWeek("live", onlyOpen, false)?.weekStart).toBe("2026-09-13");

    const onlyLive: WeekPhaseRow[] = [{ weekStart: "2026-09-06", phase: "live" }];
    expect(resolveHomeWeek("open", onlyLive, false)?.weekStart).toBe("2026-09-06");
  });

  it("returns undefined when no week matches at all", () => {
    expect(resolveHomeWeek("live", [], false)).toBeUndefined();
  });
});

describe("hasRideTodayOrTomorrow", () => {
  // 2026-09-06 12:00 Jerusalem (UTC+3 in September) = 09:00 UTC.
  const now = new Date("2026-09-06T09:00:00Z");

  it("is true for a ride starting today", () => {
    expect(hasRideTodayOrTomorrow(["2026-09-06T05:00:00Z"], now)).toBe(true);
  });

  it("is true for a ride starting tomorrow", () => {
    expect(hasRideTodayOrTomorrow(["2026-09-07T05:00:00Z"], now)).toBe(true);
  });

  it("is false for a ride further out", () => {
    expect(hasRideTodayOrTomorrow(["2026-09-09T05:00:00Z"], now)).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(hasRideTodayOrTomorrow([], now)).toBe(false);
  });

  it("respects the Jerusalem offset near UTC midnight", () => {
    // 2026-09-06 22:30 UTC = 2026-09-07 01:30 Jerusalem — local "today" is
    // already the 7th, so a ride at 08:00 local on the 7th counts...
    const lateUtcNow = new Date("2026-09-06T22:30:00Z");
    expect(hasRideTodayOrTomorrow(["2026-09-07T05:00:00Z"], lateUtcNow)).toBe(true);
    // ...but one two local days earlier does not.
    expect(hasRideTodayOrTomorrow(["2026-09-05T20:00:00Z"], lateUtcNow)).toBe(false);
  });
});
