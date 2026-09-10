import { describe, expect, it } from "vitest";
import { resolveWeekStart } from "./resolveWeekStart";

const now = new Date("2026-09-08T10:00:00+03:00");
const weeks = [
  { week_start: "2026-08-30", phase: "solving" },
  { week_start: "2026-09-06", phase: "solving" },
  { week_start: "2026-09-13", phase: "open" },
] as const;
describe("new request week selection", () => {
  it("prefers the open week after catch-up", () => {
    expect(resolveWeekStart(weeks, undefined, now)).toBe("2026-09-13");
  });
  it("allows requests in the recovered current solving week", () => {
    expect(resolveWeekStart(weeks.slice(0, 2), undefined, now)).toBe("2026-09-06");
    expect(resolveWeekStart(weeks, "2026-09-06", now)).toBe("2026-09-06");
  });
  it("does not select stale or archived weeks", () => {
    expect(resolveWeekStart([weeks[0]], undefined, now)).toBeUndefined();
    expect(resolveWeekStart([{ ...weeks[1], phase: "archived" }], "2026-09-06", now)).toBeUndefined();
  });
  it("a non-specific entry (no week override) always targets the open week when one exists, even alongside a live week", () => {
    const openAndLive = [
      { week_start: "2026-09-06", phase: "live" },
      { week_start: "2026-09-13", phase: "open" },
    ] as const;
    expect(resolveWeekStart(openAndLive, undefined, now)).toBe("2026-09-13");
  });
  it("falls back to the live week when there is no open week yet", () => {
    const liveOnly = [{ week_start: "2026-09-06", phase: "live" }] as const;
    expect(resolveWeekStart(liveOnly, undefined, now)).toBe("2026-09-06");
  });
  it("never resolves to an upcoming week, even as an explicit override", () => {
    const withUpcoming = [
      { week_start: "2026-09-06", phase: "solving" },
      { week_start: "2026-09-20", phase: "upcoming" },
    ] as const;
    expect(resolveWeekStart(withUpcoming, undefined, now)).toBe("2026-09-06");
    expect(resolveWeekStart(withUpcoming, "2026-09-20", now)).toBe("2026-09-06");
  });
});
